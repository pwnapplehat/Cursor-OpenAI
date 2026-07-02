# mem0 addon - self-hosted persistent memory for Hermes

Give [Hermes Agent](../hermes/README.md) real long-term memory with
[mem0](https://github.com/mem0ai/mem0) - fully self-hosted, no cloud memory
service, no extra API keys, no per-memory fees. Tell your agent something
once (on Telegram, in the CLI, anywhere) and it remembers it in every future
conversation: facts get extracted, deduplicated, semantically indexed, and
recalled automatically when they're relevant.

```
                                     ┌─────────────────────────────────────────────────┐
Hermes Agent ── mem0 memory plugin ──┤ LLM fact extraction  -> this gateway (Cursor)   │
 (Telegram, CLI, ...)                │ Embeddings           -> Ollama (local, free)    │
                                     │ Vector storage       -> Qdrant (a local folder) │
                                     └─────────────────────────────────────────────────┘
```

Everything runs on your machine. The only network calls are to your own
gateway (which you already run) and to your own Ollama. The one honest cost:
fact extraction is an LLM call, so each remembered conversation turn spends
one (small) metered Cursor request in the background.

## What you get

- **Automatic extraction** - after each conversation turn, mem0's LLM pass
  (through your gateway) distills durable facts ("prefers dark mode",
  "project X uses FastAPI") from the chatter, deduplicates them against what
  it already knows, and stores them. No "remember this" incantations needed -
  though the agent also gets explicit `mem0_add` / `mem0_update` /
  `mem0_delete` tools.
- **Semantic recall** - before answering, Hermes searches memory by meaning
  (Ollama embeddings + Qdrant vector search), not keywords. "What editor do I
  like?" finds the dark-mode-and-vim memory even though no word overlaps.
- **Cross-platform identity** - one `user_id` means the memory store is
  shared across every gateway you talk through: tell it on Telegram, it
  knows in the CLI.
- **Private by default** - memories never leave your machine, and the setup
  disables mem0's anonymized PostHog telemetry (`MEM0_TELEMETRY=false`).

## Quick start

Prerequisites, in dependency order:

1. The gateway is set up and running ([main README](../../README.md#quick-start)).
2. Hermes is installed and pointed at the gateway ([Hermes addon](../hermes/README.md)).
3. [Ollama](https://ollama.com/download) is installed (the script starts it
   and pulls the embedding model for you; it will not *install* it for you).

**Windows (PowerShell):**

```powershell
cd addons\mem0
powershell -ExecutionPolicy Bypass -File setup.ps1
```

**Linux / macOS:**

```bash
cd addons/mem0
chmod +x setup.sh   # first time only
./setup.sh
```

The setup script:

1. Finds and health-checks your gateway (same port resolution the gateway
   itself uses; auto-starts it via [`autostart/`](../../autostart/README.md)
   where available).
2. Confirms Hermes and its bundled mem0 memory plugin are present.
3. Guards against the **OpenRouter hijack**: mem0's OpenAI provider silently
   routes to OpenRouter whenever `OPENROUTER_API_KEY` exists in the
   environment, ignoring your configured base URL entirely (verified in
   mem0's `llms/openai.py`). The script detects this and tells you.
4. Checks Ollama, starts it if installed-but-stopped, pulls the embedding
   model if missing, and resolves its embedding dimensions (known table for
   common models, live probe for anything else).
5. Installs `mem0ai`, `ollama`, and `qdrant-client` **into Hermes' own
   bundled Python venv** using Hermes' own `uv` - never into your system
   Python. (The venv has no `pip`; this is the only correct way in.)
6. **Backs up** and writes `mem0.json` in Hermes' home folder, wiring LLM →
   gateway, embedder → Ollama, storage → local Qdrant. Re-runs preserve your
   existing `user_id`, `agent_id`, and store location.
7. Sets `memory.provider: mem0` in Hermes' `config.yaml` and
   `MEM0_TELEMETRY=false` in Hermes' `.env`.
8. Runs a **self-test** - stores a marker memory, searches it back
   semantically, deletes it - deliberately without any LLM call, so the test
   costs zero Cursor requests.
9. Restarts a running Hermes gateway and verifies `hermes memory status`
   reports mem0 active, and that your chosen extraction model actually
   exists in the gateway's catalog.

Idempotent - re-run any time to repair or update the wiring.

### Flags

| PowerShell | Bash | What it does |
|---|---|---|
| `-Model <id>` | `--model <id>` | Extraction model (default `composer-2.5` - fast and cheap is right for this job; any id from the gateway's `/v1/models`) |
| `-EmbedModel <m>` | `--embed-model <m>` | Ollama embedding model (default `nomic-embed-text`, 768 dims; unknown models get their dimensions probed live) |
| `-UserId <id>` | `--user-id <id>` | Canonical memory identity. Precedence: this flag > the value already in `mem0.json` > your OS username |
| `-OllamaUrl <url>` | `--ollama-url <url>` | Ollama endpoint (default `http://localhost:11434`) |
| `-QdrantUrl <url>` | `--qdrant-url <url>` | Use a Qdrant **server** instead of the embedded folder store - required if more than one Hermes process runs at a time (see [storage modes](#storage-modes-embedded-vs-server)) |
| `-AuthKey <key>` | `--auth-key <key>` | The gateway's `AUTH_KEY`, if configured - becomes mem0's `api_key` for LLM calls |

## What gets configured, exactly

One file does the real work - `mem0.json` in Hermes' home folder (the folder
`hermes config path` prints). [`config/mem0.snippet.json`](config/mem0.snippet.json)
is a copy-paste reference:

```json
{
  "mode": "oss",
  "user_id": "your-name-here",
  "agent_id": "hermes",
  "oss": {
    "llm":          { "provider": "openai", "config": { "model": "composer-2.5", "openai_base_url": "http://localhost:8787/v1", "api_key": "no-key-required" } },
    "embedder":     { "provider": "ollama", "config": { "model": "nomic-embed-text", "ollama_base_url": "http://localhost:11434", "embedding_dims": 768 } },
    "vector_store": { "provider": "qdrant", "config": { "path": "<hermes home>/mem0_qdrant", "collection_name": "hermes", "embedding_model_dims": 768 } }
  }
}
```

Plus two one-liners: `memory.provider: mem0` in Hermes' `config.yaml`
(activation) and `MEM0_TELEMETRY=false` in Hermes' `.env` (privacy).

Notes that save you a debugging session:

- **`openai_base_url` is the whole trick.** Hermes' own
  `hermes memory setup mem0 --mode oss` wizard cannot set it (only Ollama
  providers get a URL flag in its `_setup.py`), which is why this addon
  writes `mem0.json` directly instead of driving that wizard.
- **`embedding_dims` must match the model, in both places.** 768 for
  `nomic-embed-text`, 1024 for `mxbai-embed-large`, etc. If you switch
  embedders later, Hermes' plugin detects the dimension change and recreates
  the collection - which wipes stored memories, so pick your embedder before
  you accumulate a memory bank you care about.
- **`user_id` semantics:** a concrete value here is applied across *every*
  platform - Telegram, Discord, CLI - merging them into one memory store
  (right for a personal setup). Leave it as the literal `hermes-user` and
  Hermes instead falls back to per-platform native ids (Telegram numeric id,
  etc.), keeping platforms' memories separate.
- **`api_key`:** the gateway in server-key mode ignores it, so
  `no-key-required` is fine. If you set an `AUTH_KEY` on the gateway, put it
  here (`-AuthKey` / `--auth-key` does this).

## Storage modes: embedded vs server

Embedded Qdrant (the default, `"path"` in `mem0.json`) keeps everything in a
local folder with zero extra services - but it is **strictly single-process**:
the first Hermes process to open the store takes an exclusive lock, and every
other one gets `Mem0 backend failed to initialize ... already accessed by
another instance`. This is not a rare edge case with Hermes, because the
messaging gateway, `hermes dashboard`, and CLI chats are *separate processes*
that each initialize the memory provider - run any two together and one of
them silently loses memory.

If you run more than one Hermes process (or ever plan to), use a Qdrant
server instead:

```bash
docker run -d --name hermes-qdrant --restart unless-stopped \
  -p 127.0.0.1:6333:6333 -v hermes-qdrant-storage:/qdrant/storage qdrant/qdrant
```

then re-run the setup with `-QdrantUrl http://127.0.0.1:6333` /
`--qdrant-url http://127.0.0.1:6333` (or hand-edit `mem0.json`, replacing
`"path": ...` with `"url": "http://127.0.0.1:6333"`) and restart
`hermes gateway`. The `127.0.0.1` port binding keeps the server
loopback-only, `--restart unless-stopped` brings it back after reboots (once
Docker itself starts), and the named volume persists memories across
container upgrades. Re-runs of the setup preserve whichever mode `mem0.json`
is already in.

Switching modes does not migrate existing memories between stores - do it
early, or ask the agent to `mem0_list` everything first and re-add what
matters.

## Manual setup (no scripts)

```bash
# 1. Deps into Hermes' venv (it has no pip; use uv - Hermes bundles one):
#      Windows: %LOCALAPPDATA%\hermes\bin\uv.exe, venv at %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe
#      Linux/macOS: ~/.hermes/bin/uv, venv at ~/.hermes/hermes-agent/venv/bin/python
uv pip install --python <hermes-venv-python> "mem0ai>=2.0.7" ollama qdrant-client

# 2. Embedding model:
ollama pull nomic-embed-text

# 3. Copy config/mem0.snippet.json to <hermes home>/mem0.json and edit
#    user_id, the vector store path, and the port if you changed it.

# 4. Activate + telemetry opt-out:
hermes config set memory.provider mem0
echo "MEM0_TELEMETRY=false" >> <hermes home>/.env

# 5. Reload + verify:
hermes gateway restart      # if the messaging gateway is running
hermes memory status        # expect: mem0 ... available
```

## Using it

Nothing to invoke - it's ambient. But to see it working:

```
you:    remember that my staging server is athena.internal, port 9443
hermes: [stores it - either via extraction or an explicit mem0_add]

...days later, new session...

you:    what was my staging box again?
hermes: [mem0_search fires] athena.internal, port 9443
```

`hermes memory status` shows provider health. The agent's tools
(`mem0_search`, `mem0_add`, `mem0_list`, `mem0_update`, `mem0_delete`) are
listed in its system prompt automatically; you can also just ask it "list
everything you remember about me."

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `hermes memory status` says plugin missing | Very old Hermes build | `hermes update`, re-run setup |
| Memories stored but recall finds nothing | Embedder mismatch - collection built with different dimensions | Make both `embedding_dims` values match the model. On next start Hermes' plugin detects the mismatch and recreates the collection - note that this wipes previously stored memories (they are not re-embedded) |
| Extraction never happens, `hermes logs` shows OpenRouter errors | `OPENROUTER_API_KEY` in the environment hijacks mem0's OpenAI client | Remove that variable from Hermes' `.env` / your shell |
| `Mem0 backend not initialized ... already accessed by another instance` | Qdrant embedded mode is **single-process**: a second Hermes process (the dashboard, or a CLI chat while the Telegram gateway runs) can't open the same store folder | Switch to a Qdrant server - see [storage modes](#storage-modes-embedded-vs-server). (Or strictly run one Hermes process at a time.) |
| Extraction fails only when the gateway restarts | Gateway was down at that moment; Hermes' circuit breaker pauses mem0 for 2 min after repeated failures | Install [`autostart/`](../../autostart/README.md); the breaker recovers on its own |
| First memory operation after setup is slow | Ollama loads the embedding model into memory on first use | One-time per Ollama start; subsequent embeds are milliseconds |

## Uninstall / revert

```bash
hermes config set memory.provider ""     # deactivate (built-in memory stays)
```

Then optionally: restore the timestamped `mem0.json.bak-cursor-addon-*`
backup (or delete `mem0.json`), remove `MEM0_TELEMETRY=false` from Hermes'
`.env`, and delete the vector store folder (`mem0_qdrant/` in Hermes' home)
if you want the stored memories gone. The Python packages in Hermes' venv
are harmless to leave; remove with
`uv pip uninstall --python <hermes-venv-python> mem0ai ollama qdrant-client`.
