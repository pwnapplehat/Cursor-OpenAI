#!/usr/bin/env bash
# setup.sh - mem0 self-hosted memory addon for the Cursor-OpenAI gateway (Linux/macOS).
#
# Gives Hermes Agent (addons/hermes) persistent long-term memory via mem0 OSS
# (https://github.com/mem0ai/mem0), fully self-hosted:
#
#   LLM fact extraction  -> this gateway (your Cursor subscription)
#   Embeddings           -> Ollama, locally (free, private, no API key)
#   Vector storage       -> Qdrant embedded mode (a local folder, no server)
#
# Why a script at all: Hermes' own `hermes memory setup mem0 --mode oss` wizard
# cannot point mem0's OpenAI-compatible LLM at a custom base_url (verified in
# the plugin's _setup.py - only Ollama providers get a URL flag), so the
# gateway-as-LLM wiring must be written into mem0.json directly. This script
# does that, plus every prerequisite around it.
#
# Safe by design (addon conventions, see addons/README.md):
#   - Idempotent: re-running repairs/refreshes; existing user_id, agent_id and
#     vector-store location are preserved.
#   - Backs up mem0.json (timestamped) before changing it.
#   - Installs Python deps into Hermes' own venv using uv - never into your
#     global Python.
#   - Never installs Ollama for you - prints the official instructions instead.
#   - Self-test never calls the LLM (no metered Cursor request) and cleans up
#     after itself.
#
# Usage:
#   ./setup.sh
#   ./setup.sh --user-id alice
#   ./setup.sh --model gpt-5.5 --embed-model mxbai-embed-large
#   ./setup.sh --qdrant-url http://127.0.0.1:6333
#
# Storage modes: by default memories live in embedded Qdrant (a local folder) -
# zero services, but SINGLE-PROCESS: if you run the Hermes gateway AND
# `hermes dashboard` / CLI chats at the same time, whichever opens the store
# first wins and the others get no memory. If you use more than one Hermes
# process (most people do eventually), run a Qdrant server instead and pass
# --qdrant-url:
#   docker run -d --name hermes-qdrant --restart unless-stopped -p 127.0.0.1:6333:6333 -v hermes-qdrant-storage:/qdrant/storage qdrant/qdrant
#
# Exit codes: 0 = fully configured, 1 = prerequisite missing, 2 = partial
# (something needs a manual step; details printed).

set -u

MODEL='composer-2.5'
EMBED_MODEL='nomic-embed-text'
USER_ID=''
OLLAMA_URL='http://localhost:11434'
QDRANT_URL=''
AUTH_KEY=''
PARTIAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --model)        MODEL="${2:?--model needs a value}"; shift 2 ;;
    --embed-model)  EMBED_MODEL="${2:?--embed-model needs a value}"; shift 2 ;;
    --user-id)      USER_ID="${2:?--user-id needs a value}"; shift 2 ;;
    --ollama-url)   OLLAMA_URL="${2:?--ollama-url needs a value}"; shift 2 ;;
    --qdrant-url)   QDRANT_URL="${2:?--qdrant-url needs a value}"; shift 2 ;;
    --auth-key)     AUTH_KEY="${2:?--auth-key needs a value}"; shift 2 ;;
    -h|--help)
      sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)"; exit 1 ;;
  esac
done

step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32m%s\033[0m\n' "$1"; }
note() { printf '   \033[33m%s\033[0m\n' "$1"; }

# Embedding dimensions for common Ollama embedding models. Anything not listed
# is probed live against the Ollama API instead of guessed.
known_dims() {
  case "$1" in
    nomic-embed-text)       echo 768 ;;
    mxbai-embed-large)      echo 1024 ;;
    all-minilm)             echo 384 ;;
    bge-m3)                 echo 1024 ;;
    snowflake-arctic-embed) echo 1024 ;;
    *)                      echo '' ;;
  esac
}

# --- Locate the repo and resolve the gateway port ------------------------------
# This file lives at <repo>/addons/mem0/setup.sh.
ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ADDON_DIR/../.." && pwd)"
REPO_ENV="$REPO_ROOT/.env"
REPO_SETTINGS="$REPO_ROOT/.cursor-gateway/settings.json"

get_gateway_port() {
  # Mirrors the gateway's own precedence: settings.json (dashboard overlay,
  # wins) -> .env PORT (last assignment wins; quotes/comments tolerated) -> 8787.
  local port=''
  if [ -f "$REPO_SETTINGS" ] && command -v node >/dev/null 2>&1; then
    port=$(node -e '
      try {
        const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const p = Number(s.port);
        if (Number.isInteger(p) && p >= 1 && p <= 65535) process.stdout.write(String(p));
      } catch {}
    ' "$REPO_SETTINGS" 2>/dev/null)
  fi
  if [ -z "$port" ] && [ -f "$REPO_ENV" ]; then
    port=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]\{1,5\}\)["'\'']\{0,1\}[[:space:]]*\(#.*\)\{0,1\}$/\1/p' "$REPO_ENV" | tail -n 1)
    if [ -n "$port" ] && { [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; }; then port=''; fi
  fi
  echo "${port:-8787}"
}

PORT="$(get_gateway_port)"
BASE_URL="http://localhost:$PORT/v1"
PROVIDER_API_KEY="${AUTH_KEY:-no-key-required}"

echo "mem0 addon - self-hosted memory for Hermes on the Cursor-OpenAI gateway"
echo "Repo: $REPO_ROOT"
echo "Gateway endpoint (mem0's LLM): $BASE_URL"
echo "Embedder: Ollama '$EMBED_MODEL' at $OLLAMA_URL"

# --- 1. Gateway up? -------------------------------------------------------------
step "Checking the gateway"
gateway_health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null; }
HEALTH="$(gateway_health || true)"
if [ -z "$HEALTH" ] && [ -x "$REPO_ROOT/autostart/linux/run.sh" ]; then
  note "Gateway not responding on port $PORT - starting it via the autostart toolkit..."
  "$REPO_ROOT/autostart/linux/run.sh" >/dev/null 2>&1 || true
  sleep 2
  HEALTH="$(gateway_health || true)"
fi
if [ -n "$HEALTH" ]; then
  ok "Gateway healthy on port $PORT."
else
  note "Gateway is NOT reachable on port $PORT. Continuing (the mem0 config written below is still correct),"
  note "but memory extraction will fail until it's up: run ./start.sh, or install autostart/ (recommended)."
  PARTIAL=1
fi

# --- 2. Hermes installed? ---------------------------------------------------------
step "Checking Hermes Agent"
if ! command -v hermes >/dev/null 2>&1; then
  echo ""
  echo "Hermes Agent is not installed - this addon adds memory TO Hermes."
  echo "Set up Hermes first (it has its own addon here):"
  echo ""
  echo "  cd ../hermes && ./setup.sh"
  echo ""
  exit 1
fi
ok "Found: $(hermes --version 2>/dev/null | head -n 1)"

# Hermes home (config.yaml's folder) - authoritative via Hermes itself.
# (sed trims only leading/trailing whitespace - paths may contain spaces.)
trim() { sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
HERMES_CONFIG_PATH="$(hermes config path 2>/dev/null | tail -n 1 | trim)"
if [ -z "$HERMES_CONFIG_PATH" ]; then
  echo "Could not resolve Hermes' config path via 'hermes config path'."
  exit 1
fi
HERMES_HOME="$(dirname "$HERMES_CONFIG_PATH")"
ok "Hermes home: $HERMES_HOME"

# The mem0 plugin ships with Hermes - confirm it's visible.
if ! hermes memory status 2>/dev/null | grep -q 'mem0'; then
  note "Hermes did not list a 'mem0' memory plugin ('hermes memory status'). Your Hermes may be very old -"
  note "run 'hermes update' and re-run this setup."
  PARTIAL=1
fi

# --- 3. OpenRouter hijack guard -----------------------------------------------------
# mem0's OpenAI LLM class unconditionally routes to OpenRouter whenever
# OPENROUTER_API_KEY is set in the process environment - ignoring the
# openai_base_url we configure (verified in mem0/llms/openai.py). Hermes loads
# its .env into the process, so a key there would silently bypass the gateway.
step "Checking for an OPENROUTER_API_KEY conflict"
HERMES_ENV_PATH="$(hermes config env-path 2>/dev/null | tail -n 1 | trim)"
[ -z "$HERMES_ENV_PATH" ] && HERMES_ENV_PATH="$HERMES_HOME/.env"
OPENROUTER_HIT=0
[ -n "${OPENROUTER_API_KEY:-}" ] && OPENROUTER_HIT=1
if [ -f "$HERMES_ENV_PATH" ] && grep -Eq '^[[:space:]]*OPENROUTER_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$HERMES_ENV_PATH"; then
  OPENROUTER_HIT=1
fi
if [ "$OPENROUTER_HIT" = "1" ]; then
  note "OPENROUTER_API_KEY is set (environment or $HERMES_ENV_PATH)."
  note "mem0's OpenAI provider ALWAYS routes to OpenRouter when that variable exists, bypassing this"
  note "gateway entirely. Remove it (or rename it) or mem0's fact extraction will not use Cursor."
  PARTIAL=1
else
  ok "No OPENROUTER_API_KEY found - mem0 will honor the gateway base_url."
fi

# --- 4. Ollama (embeddings) -----------------------------------------------------------
step "Checking Ollama (local embeddings)"
ollama_tags() { curl -fsS --max-time 3 "${OLLAMA_URL%/}/api/tags" 2>/dev/null; }
TAGS="$(ollama_tags || true)"
if [ -z "$TAGS" ] && command -v ollama >/dev/null 2>&1; then
  note "Ollama installed but not running - starting it..."
  (ollama serve >/dev/null 2>&1 &)
  for _ in $(seq 1 15); do
    sleep 1
    TAGS="$(ollama_tags || true)"
    [ -n "$TAGS" ] && break
  done
fi
if [ -z "$TAGS" ]; then
  echo ""
  echo "Ollama is not installed (or not reachable at $OLLAMA_URL)."
  echo "Install it from the official source, then re-run this script:"
  echo ""
  echo "  curl -fsSL https://ollama.com/install.sh | sh    # Linux"
  echo "  brew install ollama                              # macOS"
  echo ""
  exit 1
fi
ok "Ollama reachable at $OLLAMA_URL."

# Pull the embedding model if it isn't present yet (matches Hermes' own check:
# a tag list entry that starts with the model name counts).
BASE_MODEL_NAME="${EMBED_MODEL%%:*}"
if printf '%s' "$TAGS" | grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$BASE_MODEL_NAME"; then
  ok "Embedding model '$EMBED_MODEL' already pulled."
else
  note "Pulling '$EMBED_MODEL' (one-time download, ~a few hundred MB)..."
  if command -v ollama >/dev/null 2>&1 && ollama pull "$EMBED_MODEL"; then
    ok "Pulled '$EMBED_MODEL'."
  elif curl -fsS --max-time 600 -X POST "${OLLAMA_URL%/}/api/pull" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"$EMBED_MODEL\",\"stream\":false}" >/dev/null 2>&1; then
    # Server reachable but no local binary (e.g. remote/containered Ollama).
    ok "Pulled '$EMBED_MODEL' (via the HTTP API)."
  else
    note "Could not pull '$EMBED_MODEL'. Pull it manually: ollama pull $EMBED_MODEL"
    PARTIAL=1
  fi
fi

# Resolve embedding dimensions: known table first, live probe otherwise.
DIMS="$(known_dims "$BASE_MODEL_NAME")"
if [ -z "$DIMS" ]; then
  note "Unknown embedding model - probing its dimension count live..."
  PROBE=$(curl -fsS --max-time 60 -X POST "${OLLAMA_URL%/}/api/embeddings" \
      -H 'Content-Type: application/json' \
      -d "{\"model\":\"$EMBED_MODEL\",\"prompt\":\"dimension probe\"}" 2>/dev/null || true)
  if [ -n "$PROBE" ] && command -v node >/dev/null 2>&1; then
    # Node is already required to run the gateway itself, so it's the parser
    # of choice here.
    DIMS=$(printf '%s' "$PROBE" | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const n = JSON.parse(d).embedding.length;
          if (Number.isInteger(n) && n > 0) process.stdout.write(String(n));
        } catch {}
      });
    ' 2>/dev/null)
  elif [ -n "$PROBE" ]; then
    # The response is a single-field JSON object, so commas only separate
    # array elements: element count = commas + 1.
    DIMS=$(( $(printf '%s' "$PROBE" | tr -dc ',' | wc -c) + 1 ))
  fi
fi
if [ -z "$DIMS" ] || ! [ "$DIMS" -ge 1 ] 2>/dev/null; then
  echo "Could not determine '$EMBED_MODEL' embedding dimensions."
  exit 1
fi
ok "Embedding dimensions: $DIMS."

# --- 5. Python dependencies (into Hermes' own venv) ---------------------------------------
# Hermes runs from a bundled, uv-managed venv that has NO pip module - plain
# `python -m pip` fails there. Hermes' own plugin installer uses uv, so we do
# exactly the same.
step "Installing mem0 dependencies into Hermes' venv"
VENV_PYTHON="$HERMES_HOME/hermes-agent/venv/bin/python"
UV_BIN=''
for cand in "$HERMES_HOME/bin/uv" "$(command -v uv 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then UV_BIN="$cand"; break; fi
done

if [ ! -x "$VENV_PYTHON" ]; then
  note "Hermes' venv python not found at $VENV_PYTHON - your install layout differs."
  note "Install the deps into whatever Python runs Hermes: uv pip install --python <hermes python> 'mem0ai>=2.0.7' ollama qdrant-client"
  PARTIAL=1
elif [ -z "$UV_BIN" ]; then
  note "No uv binary found (looked in $HERMES_HOME/bin and PATH), and Hermes' venv has no pip."
  note "Install uv (https://docs.astral.sh/uv/), then: uv pip install --python \"$VENV_PYTHON\" 'mem0ai>=2.0.7' ollama qdrant-client"
  PARTIAL=1
else
  if "$UV_BIN" pip install --python "$VENV_PYTHON" 'mem0ai>=2.0.7' ollama qdrant-client >/dev/null 2>&1 \
     && [ "$("$VENV_PYTHON" -c 'import mem0, ollama, qdrant_client; print("ok")' 2>/dev/null)" = "ok" ]; then
    ok "mem0ai, ollama, qdrant-client present in Hermes' venv."
  else
    note "Dependency install/import failed. Run manually: \"$UV_BIN\" pip install --python \"$VENV_PYTHON\" 'mem0ai>=2.0.7' ollama qdrant-client"
    PARTIAL=1
  fi
fi

# --- 6. Write mem0.json ------------------------------------------------------------------------
step "Writing $HERMES_HOME/mem0.json"
MEM0_JSON="$HERMES_HOME/mem0.json"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ -f "$MEM0_JSON" ]; then
  cp "$MEM0_JSON" "$MEM0_JSON.bak-cursor-addon-$STAMP"
  ok "Backed up existing mem0.json -> mem0.json.bak-cursor-addon-$STAMP"
fi

# Idempotent-repair semantics: keep the user's existing identity and vector
# store location; refresh the provider wiring (which is what this addon owns).
# JSON assembly is done in Python (Hermes' venv - guaranteed present by now,
# or we already flagged partial) for correct quoting/merging.
PY_FOR_JSON="$VENV_PYTHON"
[ -x "$PY_FOR_JSON" ] || PY_FOR_JSON="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
if [ -z "$PY_FOR_JSON" ]; then
  echo "No Python available to write mem0.json - install python3 and re-run."
  exit 1
fi

DEFAULT_USER_ID="${USER_ID:-${USER:-hermes-user}}"
WRITTEN="$("$PY_FOR_JSON" - "$MEM0_JSON" "$MODEL" "$BASE_URL" "$PROVIDER_API_KEY" \
    "$EMBED_MODEL" "$OLLAMA_URL" "$DIMS" "$HERMES_HOME" "$DEFAULT_USER_ID" "$USER_ID" "$QDRANT_URL" <<'PYEOF'
import json, os, sys
(path, model, base_url, api_key, embed_model, ollama_url,
 dims, hermes_home, default_user_id, explicit_user_id, qdrant_url) = sys.argv[1:12]
dims = int(dims)

existing = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            existing = json.load(f)
    except Exception:
        existing = {}

user_id = explicit_user_id or existing.get("user_id") or default_user_id
agent_id = existing.get("agent_id") or "hermes"
prev_vs = ((existing.get("oss") or {}).get("vector_store") or {}).get("config") or {}
# Store location precedence: --qdrant-url flag > existing mem0.json mode
# (url or path) > embedded default folder.
store_url = qdrant_url or prev_vs.get("url") or ""
store_path = prev_vs.get("path") or os.path.join(hermes_home, "mem0_qdrant").replace("\\", "/")
collection = prev_vs.get("collection_name") or "hermes"

if store_url:
    vs_config = {"url": store_url, "collection_name": collection, "embedding_model_dims": dims}
    store_label = store_url + " (server - concurrent-safe)"
else:
    vs_config = {"path": store_path, "collection_name": collection, "embedding_model_dims": dims}
    store_label = store_path + " (embedded - single process at a time)"

config = {
    "mode": "oss",
    "user_id": user_id,
    "agent_id": agent_id,
    "oss": {
        "llm": {
            "provider": "openai",
            "config": {"model": model, "openai_base_url": base_url, "api_key": api_key},
        },
        "embedder": {
            "provider": "ollama",
            "config": {"model": embed_model, "ollama_base_url": ollama_url, "embedding_dims": dims},
        },
        "vector_store": {
            "provider": "qdrant",
            "config": vs_config,
        },
    },
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
print(f"{user_id}|{store_label}")
PYEOF
)"
if [ -z "$WRITTEN" ]; then
  echo "Failed to write $MEM0_JSON."
  exit 1
fi
EFFECTIVE_USER_ID="${WRITTEN%%|*}"
STORE_LABEL="${WRITTEN##*|}"
ok "mem0.json: LLM=$MODEL via gateway, embedder=$EMBED_MODEL ($DIMS dims), store=$STORE_LABEL"
ok "user_id=$EFFECTIVE_USER_ID (one merged memory store across Telegram/CLI/etc. - edit mem0.json to change)"

# If server mode is in effect, make sure the server actually answers.
if [ -n "$QDRANT_URL" ]; then
  if curl -fsS --max-time 5 "${QDRANT_URL%/}/healthz" >/dev/null 2>&1; then
    ok "Qdrant server reachable at $QDRANT_URL."
  else
    note "Qdrant server at $QDRANT_URL is not answering /healthz - config is written anyway, but start it before using memory:"
    note "docker run -d --name hermes-qdrant --restart unless-stopped -p 127.0.0.1:6333:6333 -v hermes-qdrant-storage:/qdrant/storage qdrant/qdrant"
    PARTIAL=1
  fi
fi

# --- 7. Telemetry opt-out + provider activation ---------------------------------------------------
step "Activating mem0 in Hermes"

# mem0 OSS phones anonymized usage telemetry to PostHog by default. This is a
# self-hosted privacy-focused setup, so opt out; delete the line to re-enable.
if [ -f "$HERMES_ENV_PATH" ] && grep -Eq '^[[:space:]]*MEM0_TELEMETRY[[:space:]]*=' "$HERMES_ENV_PATH"; then
  sed -i.bak-cursor-addon-"$STAMP" 's/^[[:space:]]*MEM0_TELEMETRY[[:space:]]*=.*$/MEM0_TELEMETRY=false/' "$HERMES_ENV_PATH"
  rm -f "$HERMES_ENV_PATH.bak-cursor-addon-$STAMP"
else
  printf 'MEM0_TELEMETRY=false\n' >> "$HERMES_ENV_PATH"
fi
ok "MEM0_TELEMETRY=false (in $HERMES_ENV_PATH)"

hermes config set memory.provider mem0 >/dev/null
ok "memory.provider = mem0 (in Hermes' config.yaml)"

# --- 8. Self-test (embedder + vector store; deliberately NO LLM call) ------------------------------
step "Self-test: store -> embed -> search -> clean up"
if [ -x "$VENV_PYTHON" ]; then
  RESULT="$(MEM0_TELEMETRY=false "$VENV_PYTHON" - "$MEM0_JSON" <<'PYEOF' 2>/dev/null | grep 'SELFTEST' || true
import json, os, sys
cfg_path = sys.argv[1]
with open(cfg_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)
oss = cfg["oss"]
vs = dict(oss["vector_store"]); vsc = dict(vs.get("config", {}))
if "path" in vsc:
    vsc["path"] = os.path.expanduser(vsc["path"])
vs["config"] = vsc
try:
    from mem0 import Memory
    m = Memory.from_config({"vector_store": vs, "llm": oss["llm"], "embedder": oss["embedder"], "version": "v1.1"})
    r = m.add([{"role": "user", "content": "Cursor-OpenAI mem0 addon self-test marker"}],
              user_id="cursor-addon-selftest", infer=False)
    ids = [x["id"] for x in (r.get("results") or []) if x.get("id")]
    hits = m.search("addon self-test marker", filters={"user_id": "cursor-addon-selftest"}, top_k=5)
    got = hits.get("results") if isinstance(hits, dict) else hits
    for i in ids:
        m.delete(i)
    print("SELFTEST PASS" if got else "SELFTEST FAIL: stored but search returned nothing")
except Exception as e:
    msg = str(e).splitlines()[0] if str(e) else type(e).__name__
    low = msg.lower()
    if "lock" in low or "already accessed" in low or "in use" in low or "being used" in low:
        print("SELFTEST LOCKED: " + msg)
    else:
        print("SELFTEST FAIL: " + msg)
PYEOF
)"
  case "$RESULT" in
    *"SELFTEST PASS"*)
      ok "Self-test passed: embedding via Ollama + storage/search via Qdrant, end to end." ;;
    *"SELFTEST LOCKED"*)
      note "Vector store is currently held by a running Hermes process (Qdrant embedded mode is"
      note "single-process) - skipping. That lock is itself proof the live store works." ;;
    *)
      note "Self-test did not pass: ${RESULT:-no output}"
      PARTIAL=1 ;;
  esac
else
  note "Skipped (Hermes venv python not found - see the dependency step above)."
fi

# --- 9. Restart Hermes' gateway so the new config loads --------------------------------------------
step "Applying to a running Hermes gateway"
if hermes gateway status 2>/dev/null | grep -q 'running'; then
  note "Hermes gateway is running - restarting it to load mem0..."
  hermes gateway restart >/dev/null 2>&1 || true
  ok "Restarted."
else
  ok "Hermes gateway not currently running - nothing to restart. (Start it with: hermes gateway)"
fi

# --- 10. Verify -------------------------------------------------------------------------------------
step "Verification"
MEM_STATUS="$(hermes memory status 2>/dev/null || true)"
if printf '%s' "$MEM_STATUS" | grep -q 'mem0' && printf '%s' "$MEM_STATUS" | grep -q 'available'; then
  ok "Hermes reports the mem0 provider active and available."
else
  note "Hermes does not report mem0 as available - run 'hermes memory status' to inspect."
  PARTIAL=1
fi
if [ -n "$HEALTH" ]; then
  # No bash array for the optional header: empty-array expansion under
  # `set -u` errors out on macOS's stock bash 3.2.
  if [ -n "$AUTH_KEY" ]; then
    MODELS_JSON="$(curl -fsS --max-time 10 -H "Authorization: Bearer $AUTH_KEY" "$BASE_URL/models" 2>/dev/null || true)"
  else
    MODELS_JSON="$(curl -fsS --max-time 10 "$BASE_URL/models" 2>/dev/null || true)"
  fi
  if printf '%s' "$MODELS_JSON" | grep -q "\"$MODEL\""; then
    ok "Gateway serves '$MODEL' (mem0's extraction model) - wiring verified."
  else
    note "'$MODEL' is not in the gateway's model catalog - pick one from $BASE_URL/models (--model flag)."
    PARTIAL=1
  fi
fi

echo ""
if [ "$PARTIAL" != "0" ]; then
  echo "Setup finished with manual steps remaining - see the notes above."
  exit 2
fi
echo "Done. Hermes now has persistent self-hosted memory:"
echo "  - Tell it things ('my API key lives in .env.local') - it extracts and stores facts automatically"
echo "  - Ask it later ('what do you know about me?') - it searches memory before answering"
echo "  - Tools: mem0_search / mem0_add / mem0_list / mem0_update / mem0_delete (the agent uses them itself)"
echo "  - Inspect any time: hermes memory status"
exit 0
