#!/usr/bin/env bash
# setup.sh - Hermes Agent addon for the Cursor-OpenAI gateway (Linux/macOS).
#
# Configures Hermes Agent (https://hermes-agent.nousresearch.com) to use this
# gateway as a NAMED custom provider ("cursor"), which is what enables live
# /v1/models discovery in Hermes' /model picker (bare "provider: custom"
# deliberately shows only the configured model - verified in Hermes' source,
# hermes_cli/model_switch.py).
#
# Safe by design (mirrors setup.ps1 exactly):
#   - Idempotent: re-running repairs/refreshes, never duplicates.
#   - Backs up Hermes' config.yaml (timestamped) before changing it.
#   - Never grows Hermes' custom_providers list via `hermes config set`
#     (its _set_nested would create a dict where a list belongs) - appends a
#     fresh block only when the key is absent, and refuses with the exact
#     snippet to paste when a manual merge is needed.
#   - Never auto-runs Hermes' remote installer without --install-hermes.
#
# Usage:
#   ./setup.sh
#   ./setup.sh --long-running
#   ./setup.sh --native-vision
#   ./setup.sh --telegram-token 123:ABC --telegram-user 111222333
#   ./setup.sh --install-hermes --long-running --native-vision
#
# Exit codes: 0 = fully configured, 1 = prerequisite missing, 2 = partial
# (something needs a manual step; details printed).
set -uo pipefail

LONG_RUNNING=0
NATIVE_VISION=0
TELEGRAM_TOKEN=""
TELEGRAM_USER=""
INSTALL_HERMES=0
MODEL="composer-2.5"
AUTH_KEY=""
PARTIAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --long-running) LONG_RUNNING=1 ;;
    --native-vision) NATIVE_VISION=1 ;;
    --telegram-token) TELEGRAM_TOKEN="${2:-}"; shift ;;
    --telegram-user) TELEGRAM_USER="${2:-}"; shift ;;
    --install-hermes) INSTALL_HERMES=1 ;;
    --model) MODEL="${2:-composer-2.5}"; shift ;;
    --auth-key) AUTH_KEY="${2:-}"; shift ;;
    -h|--help)
      sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '   %s\n' "$1"; }
note() { printf '   NOTE: %s\n' "$1"; }

# --- Locate the repo and resolve the gateway port -------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ENV="$REPO_ROOT/.env"
REPO_SETTINGS="$REPO_ROOT/.cursor-gateway/settings.json"

resolve_port() {
  # Mirrors the gateway's own precedence: settings.json (dashboard overlay,
  # wins) -> .env PORT (last assignment wins; quotes/comments tolerated) -> 8787.
  port=""
  if [ -f "$REPO_SETTINGS" ]; then
    port="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]{1,5}' "$REPO_SETTINGS" 2>/dev/null | grep -oE '[0-9]{1,5}' | head -n1)"
  fi
  if [ -z "$port" ] && [ -f "$REPO_ENV" ]; then
    port="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$REPO_ENV" 2>/dev/null | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | grep -oE '[0-9]{1,5}' | head -n1)"
  fi
  if [ -z "$port" ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    port=8787
  fi
  printf '%s' "$port"
}

PORT="$(resolve_port)"
BASE_URL="http://localhost:$PORT/v1"
PROVIDER_API_KEY="${AUTH_KEY:-no-key-required}"

check_health() {
  curl -sf --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}

echo "Hermes Agent addon - Cursor-OpenAI gateway integration"
echo "Repo: $REPO_ROOT"
echo "Gateway endpoint: $BASE_URL"

# --- 1. Gateway up? -----------------------------------------------------------------
step "Checking the gateway"
GATEWAY_UP=0
if ! command -v curl >/dev/null 2>&1; then
  note "curl is not installed - skipping the gateway health check."
elif check_health; then
  GATEWAY_UP=1
  ok "Gateway healthy on port $PORT."
else
  note "Gateway is NOT reachable on port $PORT. Continuing (the Hermes config written below is still correct),"
  note "but start the gateway before using Hermes: ./start.sh, or install autostart/ (recommended)."
  PARTIAL=1
fi

# --- 2. Hermes installed? --------------------------------------------------------------
step "Checking Hermes Agent"
if ! command -v hermes >/dev/null 2>&1; then
  if [ "$INSTALL_HERMES" -eq 1 ]; then
    note "Hermes not found - running the official installer (you passed --install-hermes)..."
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
    # The installer links into ~/.local/bin - make sure this shell can see it.
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if ! command -v hermes >/dev/null 2>&1; then
    echo ""
    echo "Hermes Agent is not installed."
    echo "Install it with the official one-liner, then re-run this script:"
    echo ""
    echo "  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
    echo ""
    echo "(or re-run this script with --install-hermes to consent to running that for you)"
    exit 1
  fi
fi
ok "Found: $(hermes --version 2>/dev/null | head -n1)"

# --- 3. Locate + back up Hermes' config --------------------------------------------------
step "Backing up Hermes config"
HERMES_CONFIG="$(hermes config path 2>/dev/null | tail -n1 | tr -d '[:space:]')"
if [ -z "$HERMES_CONFIG" ]; then
  echo "Could not resolve Hermes' config path via 'hermes config path'." >&2
  exit 1
fi
STAMP="$(date +%Y%m%d_%H%M%S)"
if [ -f "$HERMES_CONFIG" ]; then
  cp "$HERMES_CONFIG" "$HERMES_CONFIG.bak-cursor-addon-$STAMP"
  ok "Backed up $HERMES_CONFIG -> $HERMES_CONFIG.bak-cursor-addon-$STAMP"
else
  note "No existing config.yaml yet (fresh Hermes install) - it will be created."
fi

# --- 4. Named custom provider ("cursor") ---------------------------------------------------
step "Registering the gateway as named provider 'cursor'"

hermes config set model.provider "custom:cursor" >/dev/null
hermes config set model.base_url "$BASE_URL" >/dev/null
hermes config set model.api_key "$PROVIDER_API_KEY" >/dev/null
hermes config set model.default "$MODEL" >/dev/null
ok "model: provider=custom:cursor, base_url=$BASE_URL, default=$MODEL"

# Belt-and-suspenders: Hermes' /model switches and dashboard "reset to auto"
# rewrite the model: block and strip base_url/api_key from it (observed
# repeatedly on v0.18). The named custom_providers entry below covers normal
# chat, but Hermes ALSO honors CUSTOM_BASE_URL / CUSTOM_API_KEY env fallbacks
# (hermes_cli/runtime_provider.py) on every custom-provider code path -
# including the bare "custom" label the stripped states degrade to. Pin them
# in Hermes' .env, which no UI action ever rewrites, so endpoint resolution
# survives any config.yaml mangling permanently.
HERMES_ENV_EARLY="$(hermes config env-path 2>/dev/null | tail -n1 | tr -d '[:space:]')"
[ -z "$HERMES_ENV_EARLY" ] && HERMES_ENV_EARLY="$(dirname "$HERMES_CONFIG")/.env"
touch "$HERMES_ENV_EARLY"
for kv in "CUSTOM_BASE_URL=$BASE_URL" "CUSTOM_API_KEY=$PROVIDER_API_KEY"; do
  key="${kv%%=*}"
  if grep -qE "^[[:space:]]*$key[[:space:]]*=" "$HERMES_ENV_EARLY"; then
    sed "s|^[[:space:]]*$key[[:space:]]*=.*|$kv|" "$HERMES_ENV_EARLY" > "$HERMES_ENV_EARLY.tmp" && mv "$HERMES_ENV_EARLY.tmp" "$HERMES_ENV_EARLY"
  else
    echo "$kv" >> "$HERMES_ENV_EARLY"
  fi
done
ok "CUSTOM_BASE_URL / CUSTOM_API_KEY pinned in Hermes' .env (survives /model-switch config stripping)"

# custom_providers needs care: `hermes config set` can navigate into an
# EXISTING list index but cannot create/grow the list. Scan the block.
CURSOR_INDEX=-1
BLOCK_EXISTS=0
if [ -f "$HERMES_CONFIG" ]; then
  CURSOR_INDEX="$(awk '
    /^custom_providers[[:space:]]*:/ { inblock=1; idx=-1; next }
    inblock && /^[^[:space:]]/ { inblock=0 }
    inblock && /^[[:space:]]*-[[:space:]]/ { idx++ }
    inblock && /^[[:space:]]*-?[[:space:]]*name[[:space:]]*:[[:space:]]*["'\'']?cursor["'\'']?[[:space:]]*$/ { print idx; found=1; exit }
    END { if (!found) print -1 }
  ' "$HERMES_CONFIG")"
  if grep -qE '^custom_providers[[:space:]]*:' "$HERMES_CONFIG"; then
    BLOCK_EXISTS=1
  fi
fi

if [ "$CURSOR_INDEX" -ge 0 ]; then
  hermes config set "custom_providers.$CURSOR_INDEX.base_url" "$BASE_URL" >/dev/null
  hermes config set "custom_providers.$CURSOR_INDEX.api_key" "$PROVIDER_API_KEY" >/dev/null
  ok "custom_providers[$CURSOR_INDEX] 'cursor' already present - refreshed base_url/api_key."
elif [ "$BLOCK_EXISTS" -eq 0 ]; then
  {
    echo "custom_providers:"
    echo "  - name: cursor"
    echo "    base_url: $BASE_URL"
    echo "    api_key: $PROVIDER_API_KEY"
  } >> "$HERMES_CONFIG"
  ok "Added custom_providers block with the 'cursor' entry."
else
  note "You already have a custom_providers list without a 'cursor' entry."
  note "Add this entry to it manually in $HERMES_CONFIG:"
  echo ""
  echo "  - name: cursor"
  echo "    base_url: $BASE_URL"
  echo "    api_key: $PROVIDER_API_KEY"
  echo ""
  PARTIAL=1
fi

# --- 5. Long-running session profile (optional) ------------------------------------------------
if [ "$LONG_RUNNING" -eq 1 ]; then
  step "Applying the long-running session profile"
  hermes config set session_reset.mode none >/dev/null
  hermes config set agent.max_turns 300 >/dev/null
  # Pin the compression summarizer to the NAMED provider, not the "main"
  # label. "main" is resolved through Hermes' runtime provider label, which
  # inside its messaging gateway is bare "custom" - a path with no endpoint
  # credentials of its own, so summaries silently die and compression drops
  # middle turns unsummarized (observed live). The named entry always
  # carries its base_url/api_key.
  hermes config set auxiliary.compression.provider "custom:cursor" >/dev/null
  hermes config set auxiliary.compression.model "$MODEL" >/dev/null
  # Pin Hermes' other automatic housekeeping calls too. Each of these fires
  # as its own SEPARATE metered gateway request and defaults to the MAIN
  # model ("auto" = inherit the main runtime): background skill review every
  # skills.creation_nudge_interval tool iterations (the big one on long
  # tool-heavy tasks), session title generation on the first exchange, and
  # the LLM command-approval guard on flagged shell commands. Pinning them
  # to the summarizer model keeps long-running housekeeping off the primary
  # (usually more expensive) model without disabling the features.
  hermes config set auxiliary.background_review.provider "custom:cursor" >/dev/null
  hermes config set auxiliary.background_review.model "$MODEL" >/dev/null
  hermes config set auxiliary.title_generation.provider "custom:cursor" >/dev/null
  hermes config set auxiliary.title_generation.model "$MODEL" >/dev/null
  hermes config set auxiliary.approval.provider "custom:cursor" >/dev/null
  hermes config set auxiliary.approval.model "$MODEL" >/dev/null
  ok "Hermes: session_reset.mode=none, agent.max_turns=300"
  ok "Hermes: auxiliary compression/background_review/title_generation/approval = custom:cursor/$MODEL"

  APPLIED=0
  if [ "$GATEWAY_UP" -eq 1 ]; then
    AUTH_HEADER=()
    [ -n "$AUTH_KEY" ] && AUTH_HEADER=(-H "Authorization: Bearer $AUTH_KEY")
    if curl -sf --max-time 10 -X PATCH "http://127.0.0.1:$PORT/api/admin/config" \
        -H 'Content-Type: application/json' "${AUTH_HEADER[@]}" \
        -d '{"requestTimeoutMs":1800000,"sessionTtlMs":86400000}' >/dev/null 2>&1; then
      ok "Gateway (live via admin API): requestTimeoutMs=1800000 (30 min), sessionTtlMs=86400000 (24 h)"
      APPLIED=1
    else
      note "Admin API update failed - falling back to .env."
    fi
  fi
  if [ "$APPLIED" -eq 0 ]; then
    if [ -f "$REPO_ENV" ]; then
      cp "$REPO_ENV" "$REPO_ENV.bak-cursor-addon-$STAMP"
      for pair in "REQUEST_TIMEOUT_MS=1800000" "SESSION_TTL_MS=86400000"; do
        name="${pair%%=*}"
        if grep -qE "^[[:space:]]*${name}[[:space:]]*=" "$REPO_ENV"; then
          # Portable in-place edit (BSD/macOS sed needs a suffix arg for -i).
          sed "s|^[[:space:]]*${name}[[:space:]]*=.*|$pair|" "$REPO_ENV" > "$REPO_ENV.tmp" && mv "$REPO_ENV.tmp" "$REPO_ENV"
        else
          echo "$pair" >> "$REPO_ENV"
        fi
      done
      ok "Gateway .env updated (backup: .env.bak-cursor-addon-$STAMP)."
      note "Restart the gateway for these to take effect (autostart/, or ./start.sh)."
    else
      note "No repo .env found (gateway not configured yet?) - set REQUEST_TIMEOUT_MS=1800000 and SESSION_TTL_MS=86400000 once it exists."
      PARTIAL=1
    fi
  fi
fi

# --- 6. Native vision (optional) --------------------------------------------------------------------
if [ "$NATIVE_VISION" -eq 1 ]; then
  step "Enabling native vision (images attach directly to the main model)"
  # Hermes can't detect vision capability for custom-provider models (its
  # capability DB doesn't cover custom routes), so without this override
  # every image is relayed through a separate auxiliary vision model as a
  # text description - one extra metered call per image. With it, images
  # (computer_use/browser screenshots, Telegram photos, vision_analyze)
  # ride the main model's context; the gateway forwards tool-result images
  # as native image blocks inside the same held run. Only enable this when
  # the default model is actually vision-capable - that's why it's opt-in.
  hermes config set model.supports_vision true >/dev/null
  hermes config set agent.image_input_mode native >/dev/null
  ok "Hermes: model.supports_vision=true, agent.image_input_mode=native"
  note "Only keep this on while your active model is vision-capable (Claude/GPT-5/Gemini/Grok etc)."
fi

# --- 7. Telegram (optional) -----------------------------------------------------------------------
if [ -n "$TELEGRAM_TOKEN" ] || [ -n "$TELEGRAM_USER" ]; then
  step "Configuring Telegram"
  if [ -n "$TELEGRAM_TOKEN" ]; then
    # Routes to Hermes' .env automatically (its config-set recognizes *_TOKEN keys).
    hermes config set TELEGRAM_BOT_TOKEN "$TELEGRAM_TOKEN" >/dev/null
    ok "TELEGRAM_BOT_TOKEN set."
  fi
  if [ -n "$TELEGRAM_USER" ]; then
    HERMES_ENV="$(hermes config env-path 2>/dev/null | tail -n1 | tr -d '[:space:]')"
    if [ -n "$HERMES_ENV" ]; then
      touch "$HERMES_ENV"
      if grep -qE '^[[:space:]]*TELEGRAM_ALLOWED_USERS[[:space:]]*=' "$HERMES_ENV"; then
        sed "s|^[[:space:]]*TELEGRAM_ALLOWED_USERS[[:space:]]*=.*|TELEGRAM_ALLOWED_USERS=$TELEGRAM_USER|" "$HERMES_ENV" > "$HERMES_ENV.tmp" && mv "$HERMES_ENV.tmp" "$HERMES_ENV"
      else
        echo "TELEGRAM_ALLOWED_USERS=$TELEGRAM_USER" >> "$HERMES_ENV"
      fi
      ok "TELEGRAM_ALLOWED_USERS=$TELEGRAM_USER (in $HERMES_ENV)"
    else
      note "Could not resolve Hermes' .env path - add TELEGRAM_ALLOWED_USERS=$TELEGRAM_USER manually."
      PARTIAL=1
    fi
  fi
fi

# --- 8. Restart Hermes' gateway if it's running -----------------------------------------------------
step "Applying to a running Hermes gateway"
if hermes gateway status 2>/dev/null | grep -qi 'running'; then
  note "Hermes gateway is running - restarting it to load the new config..."
  hermes gateway restart >/dev/null 2>&1 || true
  ok "Restarted."
else
  ok "Hermes gateway not currently running - nothing to restart. (Start it with: hermes gateway)"
fi

# --- 9. Verify -----------------------------------------------------------------------------------------
step "Verification"
if grep -qE '^[[:space:]]*provider[[:space:]]*:[[:space:]]*custom:cursor[[:space:]]*$' "$HERMES_CONFIG"; then
  ok "model.provider = custom:cursor"
else
  note "model.provider does not read back as custom:cursor - inspect $HERMES_CONFIG"
  PARTIAL=1
fi
if [ "$GATEWAY_UP" -eq 1 ]; then
  AUTH_HEADER=()
  [ -n "$AUTH_KEY" ] && AUTH_HEADER=(-H "Authorization: Bearer $AUTH_KEY")
  MODEL_COUNT="$(curl -sf --max-time 10 "${AUTH_HEADER[@]}" "$BASE_URL/models" 2>/dev/null | grep -o '"id"' | wc -l | tr -d '[:space:]')"
  if [ -n "$MODEL_COUNT" ] && [ "$MODEL_COUNT" -gt 0 ]; then
    ok "Gateway model catalog reachable: $MODEL_COUNT models (Hermes' /model picker will show these)."
  else
    note "Could not list models from the gateway."
    PARTIAL=1
  fi
fi

echo ""
if [ "$PARTIAL" -eq 1 ]; then
  echo "Setup finished with manual steps remaining - see the notes above."
  exit 2
fi
echo "Done. Try it:"
echo "  hermes                    # chat in the terminal"
echo "  hermes gateway            # run the messaging gateway (Telegram etc.)"
echo "  hermes gateway install    # ...or install it as a background service"
echo "  /model (in chat)          # switch between all the gateway's models"
exit 0
