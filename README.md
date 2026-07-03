# cursor-openai-gateway

A production-grade, OpenAI-compatible API gateway backed by the [Cursor Agent SDK](https://cursor.com/docs/sdk/typescript). Point any OpenAI-compatible client, library, or tool at this server instead of `api.openai.com`, and your requests run through a real Cursor agent using your own Cursor subscription/API key.

```
OpenAI-compatible client            cursor-openai-gateway                 Cursor
(openai SDK, LangChain,     ──▶     Express + @cursor/sdk        ──▶      Agent SDK / Cloud API
LiteLLM, Continue, curl...)         (this project)                       (your CURSOR_API_KEY)
```

Comes with a built-in **web dashboard** (a setup wizard on first run, then a full sidebar-navigated control panel: live activity, session management, a model browser, a real streaming chat, and every setting there is) so you don't need to touch a config file, a terminal command, or a single line of code to use it - see [Admin dashboard](#admin-dashboard). Everything the dashboard does is *also* available from a real **command-line client** (`bin/cursor-gateway.mjs`) for scripting/automation - see [Command-line interface (CLI)](#command-line-interface-cli) - and headlessly via environment variables for Docker/CI/servers - see [Advanced: headless configuration](#advanced-headless-configuration). Three ways to drive the exact same gateway; use whichever fits the moment.

Built directly against the real `@cursor/sdk` v1.0.x type definitions (not guesswork) and verified end-to-end against the live Cursor API - streaming, multi-turn sessions, OpenAI-style tool/function calling, and the dashboard's own setup/config API all actually work, not just on paper. See [Testing and verification](#testing-and-verification) for the real test transcripts.

## Table of contents

- [Quick start](#quick-start)
- [Cross-platform support](#cross-platform-support)
- [Admin dashboard](#admin-dashboard)
- [Command-line interface (CLI)](#command-line-interface-cli)
- [Features](#features)
- [Advanced: headless configuration](#advanced-headless-configuration)
- [Endpoints](#endpoints)
- [Client examples](#client-examples)
- [Sessions and multi-turn conversations](#sessions-and-multi-turn-conversations)
- [Tool / function calling](#tool--function-calling)
- [Security](#security)
- [Cursor Terms of Service](#cursor-terms-of-service)
- [Deployment](#deployment)
- [Addons](#addons)
- [Testing and verification](#testing-and-verification)
- [Known dependency vulnerability](#known-dependency-vulnerability-upstream-no-fix-available)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [License](#license)

## Quick start

**Requires [Node.js](https://nodejs.org) 22.13 or newer** (installing Node is the only prerequisite - everything else is handled for you). This matches `@cursor/sdk`'s own declared minimum exactly - see [Cross-platform support](#cross-platform-support) for why this gateway doesn't try to support older Node versions Cursor itself doesn't.

**Windows:** double-click `start.bat`.
**Mac/Linux:** open a terminal in this folder and run `./start.sh` (already executable in the repo; if your download/transfer method stripped that bit, `chmod +x start.sh` first).

Either way, the script installs dependencies, builds the project, starts the gateway, and opens your browser to the setup wizard automatically - paste in a Cursor API key (get one from [Cursor Dashboard -> API Keys](https://cursor.com/dashboard/api)), pick a default model, and you're done. No `.env` file, no terminal commands, no code required.

Both launchers are also safe to run when a gateway from this folder is *already* running (say, as the [`autostart/`](autostart/README.md) background service): they detect it and open the existing dashboard instead of starting a second copy - which would otherwise silently land on the next port up via the initial-boot port fallback, leaving two gateways for one repo.

Prefer the command line? Same result:

```bash
npm install
npm run build
npm start
```

This also opens the dashboard in your browser (set `AUTO_OPEN_BROWSER=false` to disable that). If the port it tries (`8787` by default) is already taken by something else, it automatically tries the next few ports instead of failing to start - see [Advanced: headless configuration](#advanced-headless-configuration) for the full list of settings, and [Admin dashboard](#admin-dashboard) for what you can do once it's running.

For local development with hot reload: `npm run dev` (tsx watch) instead of `npm run build && npm start`.

## Cross-platform support

This isn't a "should work" claim - Windows and Linux support were each specifically engineered for and verified with real, running instances (not just reasoning about the code), because early versions genuinely broke in platform-specific ways that reasoning alone did not catch. What was actually verified, and how:

- **Windows** - developed on and continuously tested against throughout, including every endpoint, the admin dashboard, and all smoke-test suites.
- **Linux** - verified with a real, fresh `git clone` of this repository run inside Ubuntu 24.04 (WSL2), on **Node 22.13.0 (this project's exact declared minimum) and Node 24**, exercising: `npm ci`/`typecheck`/`lint`/`build`/`test` (145/145 passing), a real chat completion, streaming, session continuity, the OpenAI tool-calling bridge round trip, the admin dashboard's static assets and API (including the Activity/Sessions endpoints and config export), and - critically - running the actual `start.sh` script from a clean checkout with no `node_modules`/`dist` present, exactly as a new user would. The CLI (`bin/cursor-gateway.mjs`) was separately re-verified end-to-end on real Node 22.13.0 on Linux too: `status`/`system`/`models`/streaming `chat` (including multi-turn via `--session`)/`config get`/`config set` (including `cursorWorkdirRoot`, `nodeEnv`, and a custom `authKey`)/`sessions list`/`sessions clear`/**`restart`** all exercised against a live instance, not just reasoned about - including confirming the respawned process actually comes back up and stays fully functional (a real chat message succeeds against it).
- **macOS** - not physically tested (no Mac was available), but every platform-specific code path is written and reasoned about the same way as the Linux one it shares a POSIX shell and Node.js runtime with: `start.sh` is plain POSIX-compatible bash verified against real bash on Linux, and `src/utils/openBrowser.ts` has a dedicated `darwin` branch (`open <url>`) parallel to the verified Linux (`xdg-open`) and Windows (`start`) branches. macOS is the one platform here where "should work" is an informed judgment rather than a demonstrated fact - please open an issue if something doesn't.

Real, previously-invisible bugs this process found and fixed (each covered by a regression test so they can't silently come back):

- **`npm test`'s file glob silently didn't work on Linux at all** - `node --import tsx --test test/**/*.test.ts` relies on *something* expanding that `**` glob, and what actually does differs by shell. It happened to resolve correctly on this project's Windows dev machine, but failed outright on Linux (`sh`/`dash`, npm's default script-shell there, doesn't do bash-style `**` recursion) - this had already broken this repository's first GitHub Actions CI runs on `ubuntu-latest` before it was caught. Fixed with a small, shell-independent launcher (`scripts/run-tests.mjs`) that finds test files in plain Node instead of relying on shell glob expansion at all.
- **`start.sh` had no executable bit in git**, so a fresh clone failed with "Permission denied" even after the instructions said to run it. Fixed (`git update-index --chmod=+x start.sh`) and locked in with `.gitattributes` (`* text=auto eol=lf`) so line endings stay LF in the repository regardless of a contributor's local `core.autocrlf` setting - Windows' Git defaults to converting LF to CRLF on checkout, and a CRLF shebang line (`#!/usr/bin/env bash\r`) fails on Linux/macOS with "bad interpreter" errors.

**Why Node >=22.13 and not something lower:** earlier versions of this gateway tried to also support Node 18 (with an explicit `JsonlLocalAgentStore` override and a `WebCrypto` polyfill working around real gaps in `@cursor/sdk`'s behavior below Node 22.13, plus a CI matrix including 18/20). All of that was removed. `@cursor/sdk`'s own `package.json` declares `engines.node: ">=22.13"` - Cursor doesn't test or support anything older for this SDK, so every Node-18/20 workaround was code that existed solely to route around versions Cursor itself doesn't support, could silently break again in new ways with any future SDK update, and bought nothing real: anyone who can install Node at all can install Node 22. Matching Cursor's own requirement exactly is simpler, more honest, and more maintainable than quietly promising a compatibility range this project can't actually keep up.

## Admin dashboard

Opening the gateway in a browser (`http://localhost:8787` by default) gets you a full sidebar-navigated control panel, not just a settings page:

- **First run: a 3-step setup wizard** - paste your Cursor API key (validated live against the real Cursor API before you can continue), pick a default model from your account's actual catalog with search/filter, and optionally generate a secure admin key to protect the dashboard and API. Takes under a minute.
- **Overview** - live status (uptime, cached sessions, concurrency), your connected Cursor account, current default model, total requests/errors/tokens, a 24-hour requests chart, a per-model request breakdown, and a preview of the most recent activity.
- **Activity** - a live, auto-refreshing table of every request this gateway process has actually handled (endpoint, model, status, streamed or not, duration, token usage), backed by an in-memory ring buffer (`src/observability/activityLog.ts`, last 200 requests - intentionally not persisted to disk, since it's an operations view, not an analytics warehouse). Clearable from the dashboard.
- **Sessions** - every cached Cursor agent currently keeping a multi-turn conversation alive (type - explicit/auto/resume/fresh, agent id, model, message count, created/last-used times), with a one-click **Evict** per session or **Clear all**, backed by `SessionManager.listSessions()`/`evict()`/`evictAll()`. Evicting just means that conversation's next message starts a fresh agent - nothing else is affected.
- **Models** - the full model catalog available to the configured Cursor account (not just a dropdown): name, description, aliases, and any variants (e.g. reasoning-effort presets) Cursor reports for that model, searchable, with a one-click "Set as default" per model.
- **Chat** - a real, streaming conversation through the gateway (Markdown-rendered replies, live "typing" text, per-reply model/token/duration caption, copy-to-clipboard) - not a stub "test box". Each open chat tab gets its own private conversation (a random id kept in that tab's `sessionStorage`); **New conversation** starts a fresh one instantly. This is a genuine conversation through the same pipeline as `/v1/chat/completions`, useful for both trying things out and just using the gateway directly.
- **Connect** - copy-paste-ready snippets (curl, Python, Node, LiteLLM, Continue.dev, and the CLI - see below) for whatever you're hooking up, pre-filled with this gateway's actual base URL, key, and your chosen model.
- **Settings** - organized into sub-sections (General, Sessions & memory, Behavior & tools, Performance & limits, Network & server, Security, Logging, **Advanced**, Backup & restore, System info) instead of one long scroll. **Every single field `AppConfig` has is editable here** - including the workdir root and the "Node env" label, which used to be permanently fixed at startup - and applies **live**, with no restart, for all but a couple of things (like the rate-limit window size) that libraries outside this gateway's control fix at process startup. For those, there's a real **Restart gateway** action (Advanced section) that respawns the process and reconnects the dashboard automatically - nothing here requires shell/console access to actually finish taking effect. **Security** now also lets you type in your own custom admin key, not just generate a random one. **Backup & restore** covers both directions: download the full current config as JSON, or upload a previously exported file to restore it - unrecognized/non-editable fields (and anything that still looks like a *masked* key rather than a real one, e.g. from re-uploading a redacted export by mistake) are safely skipped and reported back, never silently corrupting your setup. **System info** is a read-only panel (gateway/Node version, platform, PID, uptime) for at-a-glance transparency into exactly what's running.

Settings changed from the dashboard are saved to `.cursor-gateway/settings.json` (git-ignored, created automatically) and take precedence over `.env` on the next boot, so the two approaches don't fight each other - use whichever is convenient at the time.

### Live config reload (how)

Almost every setting change - from the dashboard, the CLI, or a direct `PATCH /api/admin/config` - takes effect immediately on the running process, no restart, including changing the server's own `PORT`/`HOST` (the gateway opens a new listener on the new address, drains the old one in the background, and the dashboard follows you to the new URL automatically). This works because `ConfigStore` (`src/configStore.ts`) owns one shared, mutable config object that every other module already reads live on each request; updating it and persisting it to disk is enough.

The one exception is `RATE_LIMIT_WINDOW_MS` (the rate-limit *window size*, not the request count within it) - `express-rate-limit` fixes that at startup, so changing it is saved but needs a restart to actually take effect. That restart doesn't have to mean "someone opens a terminal": `POST /api/admin/restart` (the dashboard's **Restart gateway** button, or `cursor-gateway restart`) respawns the exact same process (`spawn(process.execPath, process.argv.slice(1), ...)` - whatever command originally started it) on the same port, so this is fully self-service from the dashboard or CLI too. Verified live on both Windows and Linux - see [Cross-platform support](#cross-platform-support).

### Dashboard security

The dashboard and its API (`/api/admin/*`) only accept requests from this machine (127.0.0.1/::1) by default, independent of whether you set an admin key - so exposing the OpenAI endpoints on your LAN (`HOST=0.0.0.0`) doesn't also expose configuration to that network. See [Security](#security) for the full picture, including the admin-key/loopback interaction and how secrets are masked.

## Command-line interface (CLI)

Everything the dashboard can do is also available as a real command-line client - `bin/cursor-gateway.mjs` - for scripting, automation, and headless/CI use. It's a standalone Node script (no build step of its own) that talks to a *running* gateway's admin API - the same one the dashboard uses - so it needs the gateway process to actually be up.

```bash
# From the project directory:
node bin/cursor-gateway.mjs --help

# Or run `npm link` once to get a global `cursor-gateway` command instead.
npm link
cursor-gateway --help
```

It auto-detects the gateway's URL (`http://127.0.0.1:<PORT>`, `PORT` from the environment, default `8787`) and, if run on the same machine, the admin key from the local `.cursor-gateway/settings.json` - so on a typical local setup you don't need to pass either explicitly. Override with `--url`/`--key` (or `GATEWAY_URL`/`GATEWAY_ADMIN_KEY` env vars) for a remote instance.

```bash
cursor-gateway status                                          # health + account at a glance
cursor-gateway system                                           # gateway/Node version, platform, workdir
cursor-gateway config get                                       # full current config
cursor-gateway config get defaultModel                          # one field
cursor-gateway config set defaultModel=composer-2.5 maxConcurrentRuns=16   # update settings (typed: numbers/booleans auto-detected)
cursor-gateway config export my-backup.json                     # back up the full config
cursor-gateway config import my-backup.json                     # restore it later (masked/unknown fields are safely skipped)
cursor-gateway models                                           # full catalog for the configured account
cursor-gateway sessions list                                    # cached multi-turn conversations
cursor-gateway sessions evict <id>                               # evict one
cursor-gateway sessions clear                                    # evict all
cursor-gateway activity --limit 20                               # recent request activity + aggregate stats
cursor-gateway chat "Say hello in one word" --model composer-2.5 # streams the reply to stdout
cursor-gateway restart                                           # respawn the process, applying any pending restart-only change
```

Every command also accepts `--json` for machine-readable output instead of a formatted table - handy for scripting (`cursor-gateway config get --json | jq .defaultModel`). `config set` coerces `key=value` pairs to the right type automatically (`sessionsEnabled=false`, `port=9000`, `defaultModel=auto`) and rejects anything the server itself would reject - **every** `AppConfig` field is settable this way, including `cursorWorkdirRoot`, `nodeEnv`, and `authKey` (set your own admin key directly, or `authKey=` with nothing after the `=` to remove it), with the exact same validation `ConfigStore` applies to the dashboard - there's exactly one source of truth for what a valid config looks like, not two. An unrecognized field name is rejected outright with a clear error naming it, rather than silently doing nothing.

## Features

- **A built-in setup wizard and admin dashboard** - see [Admin dashboard](#admin-dashboard) above. Nothing below requires it, but it's there so non-technical users never have to touch a terminal.
- **`/v1/chat/completions`** - streaming (SSE) and non-streaming, system/user/assistant/tool messages, images (`image_url`, including base64 data URLs), usage accounting.
- **`/v1/completions`** - legacy text-completion endpoint, implemented as a thin adapter over the chat pipeline.
- **`/v1/models`** / **`/v1/models/:id`** - live catalog pulled from `Cursor.models.list()` for the authenticated key, including aliases **and model variants**. Cursor models expose parameters (reasoning effort, thinking, context size, fast mode); every variant that differs from the default in one parameter is listed as its own id using Cursor's slug convention - `gpt-5.4-mini-xhigh`, `claude-sonnet-5-max`, `claude-opus-4-8-fast`, `grok-4.3-200k` - and requesting one runs that exact parameterized variant (hand-typed multi-parameter combos like `claude-sonnet-5-thinking-1m` resolve too, including on aliases). Each entry also carries a non-standard `context_length` field (tokens) derived from the variant it denotes (default variant for base ids) - e.g. `claude-sonnet-5` reports `1000000` while `claude-sonnet-5-300k` reports `300000`. Agent frameworks (Hermes, LiteLLM-style routers, etc.) that probe `/models` for context metadata pick this up automatically to size their context-compression thresholds; strict OpenAI clients ignore the extra field. Models whose catalog entry declares no context parameter (e.g. `composer-2.5`) omit the field rather than inventing a number.
- **`/v1/embeddings`** - returns a clear, correctly-shaped `501` error rather than a fabricated vector (Cursor's Agent SDK has no embeddings API - see [Known limitations](#known-limitations)).
- **Streaming with real deltas** - chain-of-thought/"thinking" text can be streamed as `reasoning_content`, matching the convention used by DeepSeek/o1-style OpenAI-compatible clients.
- **Multi-turn sessions** with three ways to keep context across requests: automatic conversation-hash detection, an explicit `session_id`, or resuming a real Cursor agent by id. See [Sessions](#sessions-and-multi-turn-conversations).
- **OpenAI tool/function-calling bridge** - your `tools[]` schemas are registered as native Cursor custom tools; when the model calls one, the gateway hands control back to your application as a standard `tool_calls` response, exactly like talking to OpenAI directly. In the default `hold` mode the entire tool loop runs as **one metered Cursor run** (the run stays alive while your app executes each tool), and parallel tool calls are captured. See [Tool calling](#tool--function-calling) for how this actually works and the trade-offs of each mode.
- **Concurrency controls** - a global semaphore (`MAX_CONCURRENT_RUNS`) plus per-agent mutexes prevent overwhelming the Cursor backend or triggering `AgentBusyError`.
- **Two auth modes** - a single server-side `CURSOR_API_KEY` for personal use, or `passthrough` mode where each client supplies its own Cursor key via `Authorization: Bearer`, so one running gateway can serve multiple Cursor accounts.
- **Robust error mapping** - every `CursorSdkError` subclass (`AuthenticationError`, `RateLimitError`, `AgentBusyError`, `ConfigurationError`, `NetworkError`, ...) maps to the correct HTTP status and an OpenAI-shaped error body.
- **Client-disconnect handling** - aborts the underlying Cursor run when the calling HTTP client disconnects mid-stream, so you don't pay for work nobody reads.
- Structured logging (pino, with secrets redacted), rate limiting, Helmet security headers, graceful shutdown, Docker image, and a real end-to-end smoke test suite.

## Advanced: headless configuration

Everything the dashboard does is also configurable via environment variables - useful for Docker, CI, or anyone who just prefers editing a file. This is exactly equivalent to the dashboard; use either, or both (dashboard changes are saved separately and take precedence, so they won't be clobbered by a stale `.env`).

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `CURSOR_API_KEY` to a user API key from [Cursor Dashboard -> API Keys](https://cursor.com/dashboard/api), or a team service-account key from Team Settings -> Service accounts. Leaving it blank is fine too - the gateway boots anyway and serves the setup wizard until it's configured one way or another.

```bash
npm run dev      # tsx watch, for local development
# or
npm run build && npm start   # compiled production run
```

The server verifies your `CURSOR_API_KEY` against the real Cursor API on startup and logs the result. Then:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

See [`.env.example`](./.env.example) for the full, documented list of every variable (auth mode, runtime, sessions, tool bridge, concurrency limits, rate limiting, logging, dashboard behavior). The important ones to know up front:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_API_KEY` | *(none - triggers the setup wizard)* | Your Cursor API key. |
| `CURSOR_KEY_MODE` | `server` | `server` uses `CURSOR_API_KEY` for everyone; `passthrough` uses each client's own bearer token as their Cursor key. |
| `AUTH_KEY` | *(none)* | Optional bearer token clients must send to use this gateway; also doubles as the admin dashboard's password. Ignored in `passthrough` mode. |
| `CURSOR_RUNTIME` | `local` | `local` runs agents on this machine; `cloud` runs on a Cursor-hosted VM. The tool-calling bridge requires `local`. |
| `DEFAULT_MODEL` | `composer-2.5` | Used when a client's requested model isn't in your account's catalog. |
| `MAX_CONCURRENT_RUNS` | `8` | Global cap on simultaneous Cursor agent runs; extra requests queue. A held run (awaiting tool results, see [Tool calling](#tool--function-calling)) holds its slot for the whole loop. |
| `TOOL_BRIDGE_MODE` | `hold` | `hold` keeps one Cursor run alive across a whole tool loop (one metered request, native-app-like); `cancel` is the legacy one-run-per-step behavior. See [Tool calling](#tool--function-calling). |
| `TOOL_RESULT_TIMEOUT_MS` | `900000` | Hold mode only: how long a run waits for the client's tool result before it's torn down (frees the agent + concurrency slot). |
| `AUTO_OPEN_BROWSER` | `true` | Opens the dashboard automatically on startup - interactive (TTY) starts only; unattended launches (the [`autostart/`](autostart/README.md) toolkit, systemd, launchd, Docker, CI) never spawn a browser regardless of this setting. Set `false` to disable it even for interactive starts (the provided Dockerfile already does, belt-and-suspenders). |
| `ADMIN_ALLOW_REMOTE` | `false` | Allows the admin dashboard/API from non-localhost addresses. See [Dashboard security](#dashboard-security). |

## Endpoints

| Method & path | Notes |
| --- | --- |
| `POST /v1/chat/completions` | Streaming and non-streaming. |
| `POST /v1/completions` | Legacy text completions. |
| `GET /v1/models`, `GET /v1/models/:id` | Live catalog for the authenticated key. |
| `POST /v1/embeddings` | Always returns `501` - see [Known limitations](#known-limitations). |
| `GET /health` | Liveness/readiness, no auth required. Reports cached session count and concurrency stats. |

## Client examples

**curl (streaming):**

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","stream":true,"messages":[{"role":"user","content":"Count to 5."}]}'
```

**OpenAI Python SDK:**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")
resp = client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Say hello."}],
)
print(resp.choices[0].message.content)
```

**OpenAI Node SDK:**

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "unused" });
const resp = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Say hello." }],
});
console.log(resp.choices[0].message.content);
```

If `AUTH_KEY` is set, pass it as the client's `apiKey` instead of `"unused"`. In `passthrough` mode, pass your real `CURSOR_API_KEY` as the client's `apiKey`.

**LiteLLM / Continue.dev / any "OpenAI-compatible" provider config:** set `base_url` (or `apiBase`) to `http://localhost:8787/v1` and the API key to whatever this gateway expects per the auth mode above.

## Sessions and multi-turn conversations

A Cursor `SDKAgent` is a stateful object, not a stateless completion call, so this gateway maintains a cache of live agents and figures out, for every request, which of the message(s) are actually *new* to a given agent (see `src/cursor/sessionManager.ts` and `src/utils/hash.ts::computeNewSuffix`). Three mechanisms, checked in order:

1. **`metadata.cursor_agent_id`** - resume a specific real Cursor agent (`Agent.resume`). Runtime (local/cloud) is auto-detected from the id.
2. **`metadata.session_id`** - an opaque id you control. Works with *either* client behavior: resend full history every turn (standard OpenAI pattern), or send only the new message(s) each turn (a lighter, session-native pattern) - the gateway diffs against what it last sent this agent and figures out which applies automatically.
3. **Auto-session (default on)** - no id needed. The gateway hashes `messages[0..-2]` and looks for a cached agent it last left in exactly that state. This is what makes ordinary, session-unaware OpenAI clients "just work" across turns, as long as they resend full history (which is the standard behavior for essentially every OpenAI client library).

If none of these match (cold start, cache eviction, or a brand-new conversation), a fresh agent is created. If the request already contains multiple turns of history at that point, they're folded into one message with explicit framing telling the model "this is context, not something to re-answer" - since a brand-new Cursor agent has no way to actually remember turns it didn't itself generate.

Sessions are cached in memory (`MAX_CACHED_AGENTS`, LRU-evicted) and expire after `SESSION_TTL_MS` of inactivity. They do not survive a process restart (use `metadata.cursor_agent_id` with a real, server-side-persisted agent id if you need that).

## Tool / function calling

Cursor's SDK executes tools *inline*, inside its own agent loop - it has no concept of "pause and ask an external caller to run this function," which is exactly OpenAI's tool-calling contract. This gateway bridges the two, and it does so in one of two modes (`TOOL_BRIDGE_MODE`, default `hold`).

### Hold mode (default) - one Cursor run for the whole tool loop

This mirrors how the native Cursor app behaves: a single agent run stays alive for an entire tool-calling conversation, so the whole loop is **one metered Cursor request**, not one per step.

1. Each of your `tools[]` function schemas is registered as a real Cursor `SDKCustomTool` (native tool-calling, not a prompt-based hack - the model sees a proper JSON schema).
2. When the model invokes one, the tool's `execute()` callback fires - and the gateway *parks* it (returns a still-pending Promise). From Cursor's side the one run is simply "waiting on its tools," exactly as it would be in the app. The gateway returns the parked call(s) to you as a standard OpenAI `tool_calls` response (`finish_reason: "tool_calls"`) while keeping the run alive.
3. You execute the tool yourself and send the result back as a normal `{"role": "tool", "tool_call_id": ..., "content": ...}` message on your next request. The gateway matches that `tool_call_id` to the still-open run, resolves the parked callback, and the *same run* continues.
4. Repeat until the model stops calling tools; that final turn is `finish_reason: "stop"`. Every response in the loop carries the same `cursor_agent_id`.

Because the run stays open, hold mode also captures **parallel tool calls** - if a turn invokes several tools at once, they're all returned together in one `tool_calls` array for you to answer in a single follow-up.

Continuation is matched by `tool_call_id` (globally unique, echoed back in your `tool` message), so this works whether or not you set a `session_id` and regardless of whether you resend full history. A held run that never receives its result is torn down after `TOOL_RESULT_TIMEOUT_MS` (default 15 min) so a disappearing client can't pin an agent and its concurrency slot forever.

Verified end-to-end against the real Cursor API (`npm run smoke:hold-mode`): a two-tool sequential loop, answered over three separate HTTP requests, runs entirely on **one** `cursor_agent_id`. The SDK's ability to keep a run alive across long, real cross-request gaps (30-45s each) and multiple sequential/parallel tool calls was confirmed with direct live tests before this was built.

### Cancel mode (`TOOL_BRIDGE_MODE=cancel`) - legacy, one run per step

The original behavior, kept as an escape hatch. On the first tool call the underlying run is **cancelled**; your follow-up request starts a fresh run that re-reads the (replayed) history. This turns one logical tool loop into N separately-metered Cursor runs and observes only the *first* tool call per turn (parallel calls in a single turn are lost, since the run is gone as soon as the first fires). Sequential tool calls across turns still work. Prefer `hold` unless you have a specific reason not to.

### Common to both modes

The bridge only works when `CURSOR_RUNTIME=local` (custom tools are a local-agent-only SDK feature) - requests with `tools[]` are logged and ignored (tools stripped) if `CURSOR_RUNTIME=cloud` or `ENABLE_TOOL_BRIDGE=false`. The classic single-turn round trip (`npm run smoke:tools`) and its streaming variant (`npm run smoke:streaming-tools`) pass under both modes.

## Security

- **Secrets:** `CURSOR_API_KEY` and `AUTH_KEY` live only in `.env` (git-ignored), your process environment, or the git-ignored `.cursor-gateway/settings.json` overlay - never in source, never in a commit. They're masked in logs and API responses (`GET /api/admin/config` returns e.g. `************mnop`, never the full value) and compared using a constant-time comparison (`src/utils/safeCompare.ts`) to avoid leaking timing information.
- **`AUTH_KEY`:** set this (or generate one from the setup wizard) to require clients to authenticate to the gateway itself (`Authorization: Bearer <AUTH_KEY>`) - it doubles as the admin dashboard's password. Not used to gate the OpenAI-compatible endpoints in `passthrough` mode, since the bearer slot there is already the client's own Cursor key.
- **Admin dashboard/API is loopback-only by default:** `/api/admin/*` and the dashboard itself only accept requests from `127.0.0.1`/`::1`, regardless of whether `AUTH_KEY` is set (`src/middleware/loopbackOnly.ts`) - so binding `HOST=0.0.0.0` to expose the OpenAI endpoints on a LAN doesn't also expose configuration/credentials to that same network. This guard is **tunnel-aware**: a request carrying proxy-forwarding headers (`X-Forwarded-For`, `CF-Connecting-IP`, etc.) is refused even when its socket peer is loopback, so running a local tunnel (cloudflared/ngrok) can't expose the admin surface to the internet the way a naive loopback check would. `trust proxy` is intentionally left off, so `req.ip` stays the real, unspoofable socket peer. Set `ADMIN_ALLOW_REMOTE=true` only if you understand the risk and need to configure this gateway from another device.
- **Open-to-network warning:** when bound to all interfaces (`HOST=0.0.0.0`) in `server` mode with no `AUTH_KEY`, the gateway logs a prominent startup warning and flags it in the dashboard's System info - because in that state any device that can reach the port can use your Cursor plan unauthenticated. Set `AUTH_KEY`, or bind `HOST=127.0.0.1`.
- **Agent sandboxing:** by default, Cursor local agents can read/write files and run shell commands within their working directory and reach the network - there is no human-in-the-loop approval step in headless SDK runs (this is documented SDK behavior, not something this gateway can fully turn off). This gateway limits blast radius by giving every session its own isolated scratch directory under `CURSOR_WORKDIR` (default `./.cursor-gateway/workspaces/<hash>`) rather than pointing agents at a real project checkout. If you need agents to operate on a real codebase, set `CURSOR_WORKDIR` deliberately and understand the exposure that implies.
- **Rate limiting:** `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` apply per resolved Cursor API key (or per IP if none).

## Cursor Terms of Service

This is a self-hosted tool that uses the official Cursor SDK/API with your own key - it is not a way to circumvent Cursor's pricing or an unofficial reverse-engineered API. Per [Cursor's Terms of Service](https://cursor.com/terms-of-service) §1.5(iii), you may not "rent, lease, lend, or sell" the Service. Embedding Cursor as a backend AI service inside your own application or workflow via the SDK/API is an explicitly supported use case (see Cursor's own [Notion SDK case study](https://cursor.com/blog/notion)); what's restricted is reselling access to your account/usage to third parties (e.g. selling people time on your subscription). Run this gateway for your own personal or internal use; don't turn it into a paid multi-tenant service reselling your Cursor plan.

## Deployment

**Just running it locally:** `start.bat` (Windows) or `./start.sh` (Mac/Linux) - see [Quick start](#quick-start).

**Start automatically at login (hidden, background):** see [`autostart/`](autostart/README.md) - per-OS install/uninstall/status scripts (Windows Startup-folder shortcut, Linux `systemd --user` with a cron fallback, macOS launchd) with single-instance and port-conflict guards, so the gateway survives reboots without a terminal window staying open.

**Docker:**

```bash
cp .env.example .env   # fill in CURSOR_API_KEY
docker compose up --build -d
```

**Docker (no compose):**

```bash
docker build -t cursor-openai-gateway .
docker run -d --name cursor-openai-gateway -p 8787:8787 --env-file .env cursor-openai-gateway
```

**Bare metal / VM (systemd):** build once (`npm run build`), then run `node dist/index.js` under your process supervisor of choice (systemd unit, PM2, etc.) with the environment variables from `.env.example` set. The process handles `SIGTERM`/`SIGINT` gracefully (drains in-flight requests, disposes cached agents) and force-exits after 10s if shutdown hangs.

### Exposing it on your network or the internet

The gateway binds `HOST=0.0.0.0` by default, so it's **already reachable from other devices on your LAN** - no code change needed. On startup (when bound to all interfaces) it logs the exact base URLs to use, and the dashboard's **Settings -> System info** panel lists them too, e.g.:

```
reachable from other devices on your network:
  http://192.168.1.42:8787/v1   (Wi-Fi)
```

**On the same network (LAN):**

1. Point the other device's OpenAI client at `http://<this-machine-ip>:8787/v1` (the URL from the startup log / System info panel).
2. If it can't connect, allow the port through this machine's OS firewall (on Windows, "allow an app through the firewall" for Node, or open TCP 8787).
3. Bind to a single interface with `HOST=127.0.0.1` if you ever want to make it local-only again.

**Over the internet:** don't port-forward the raw port - put it behind a tunnel that terminates TLS, and require a token first:

1. **Set `AUTH_KEY`** (env, or the dashboard's **Security** tab). Without it, in `server` mode, anyone who reaches the port can spend your Cursor plan with no authentication - the gateway logs a loud warning at startup when it detects this. Clients then send `Authorization: Bearer <AUTH_KEY>`.
2. Run a tunnel on this machine, e.g. `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`. Point remote clients at the public URL the tunnel prints, with `/v1` appended.
3. The **admin dashboard/API stays protected**: it refuses any request that arrived through a proxy/tunnel (even though such requests reach the gateway over loopback), independent of `AUTH_KEY`. So a public tunnel exposes only the OpenAI endpoints, never your configuration/credentials. Manage settings from the machine itself, or set `ADMIN_ALLOW_REMOTE=true` only if you deliberately want remote admin (behind your own auth).

Keep it personal either way - see [Cursor Terms of Service](#cursor-terms-of-service). This is for reaching *your own* gateway from *your own* devices, not running a public multi-tenant service on your plan.

## Addons

The [`addons/`](addons/README.md) folder holds optional, self-contained integrations that connect other tools to this gateway. None of them are required to run the gateway, and none modify the gateway's own code - each one only configures the external tool to talk to your running instance, following shared conventions ([`addons/README.md`](addons/README.md)): idempotent setup scripts, timestamped backups of every file they touch, no remote code execution without an explicit opt-in flag, and graceful refusal (with the exact manual step printed) instead of guessing when a config state can't be merged safely.

### Hermes Agent - use the gateway from Telegram, Discord, WhatsApp, and more

[`addons/hermes/`](addons/hermes/README.md) turns your Cursor subscription into a full autonomous agent you can message from your phone, built on [Hermes Agent](https://hermes-agent.nousresearch.com) (NousResearch's open-source agent framework):

```
Telegram / Discord / CLI ──▶ Hermes Agent ──▶ this gateway (localhost:8787/v1) ──▶ Cursor
                             (tools, memory,      (OpenAI-compatible bridge,
                              sessions, cron)      sessions, model catalog)
```

- **One-command setup** - `setup.ps1` (Windows) / `setup.sh` (Linux/macOS) health-checks the gateway (on Windows it can auto-start it via [`autostart/`](autostart/README.md)), registers the gateway as a *named* Hermes provider, wires up Telegram credentials if you pass them, restarts a running Hermes gateway, and verifies the result end-to-end. Idempotent; re-run any time to repair or update.
- **Full live model catalog** - the addon deliberately registers a *named* custom provider (`custom:cursor`) rather than Hermes' bare `provider: custom`, because only named providers get live `/v1/models` discovery - so Hermes' `/model` picker shows every model your Cursor account can use (80+ ids including aliases) and you can switch mid-conversation (`/model claude-sonnet-5`). Context windows are detected dynamically too, via the `context_length` field this gateway's [`/v1/models`](#features) exposes.
- **Long-running session profile** (`-LongRunning` / `--long-running`) - opt-in tuning for autonomous tasks that run for hours or days: Hermes sessions never auto-reset (no daily/idle wipes; context is managed by compression), a raised per-turn tool budget, the compression summarizer pinned to this gateway, and matched gateway-side timeouts (30-minute per-call cap aligning with Hermes' own internal API timeout, 24-hour cached-agent TTL). Applied live through the admin API when the gateway is running.
- **Agent tool use, cron jobs, persistent memory, voice notes** - all of Hermes' own capabilities, powered by your Cursor models. Its tool loop executes each step as its own gateway request, so expect several metered Cursor requests per conversational turn - inherent to any agent driving a stateless OpenAI-style API, and explained honestly in the addon's troubleshooting table.
- **Manual path included** - every scripted step is documented as plain `hermes config set` commands plus a reference YAML snippet, for people who don't run scripts they haven't read.

Keep it personal: usage through the addon is normal plan usage under Cursor's supported SDK use case, but the same [Terms of Service](#cursor-terms-of-service) boundary applies - don't resell access.

### mem0 - self-hosted long-term memory for Hermes

[`addons/mem0/`](addons/mem0/README.md) gives the Hermes addon persistent memory via [mem0](https://github.com/mem0ai/mem0) OSS, with every component running on your own machine - tell your agent something once and it remembers it across sessions, days, and platforms:

```
Hermes ── mem0 plugin ──▶ LLM fact extraction  -> this gateway (your Cursor subscription)
                          Embeddings           -> Ollama, local (nomic-embed-text, free)
                          Vector storage       -> Qdrant embedded mode (a local folder)
```

- **Automatic fact extraction** - after each conversation turn, mem0 distills durable facts from the chatter through a gateway LLM call (`composer-2.5` by default - fast/cheap is right for the job), deduplicates them against existing memories, and indexes them for semantic recall. The agent also gets explicit `mem0_search` / `mem0_add` / `mem0_list` / `mem0_update` / `mem0_delete` tools.
- **One-command setup** - `setup.ps1` / `setup.sh` health-checks the gateway and Hermes, verifies Ollama (starts it if stopped, pulls the embedding model, resolves embedding dimensions - live-probed for models it doesn't know), installs the Python deps into Hermes' own bundled venv via `uv` (it has no `pip` - a real trap), writes `mem0.json`, activates the provider, and runs a store→search→delete self-test that deliberately makes **no** LLM call, so verifying the setup costs zero Cursor requests.
- **Guards against real failure modes it found** - mem0's OpenAI client silently reroutes to OpenRouter whenever `OPENROUTER_API_KEY` exists in the environment (ignoring your base URL); the setup detects and flags this. It also pins `MEM0_TELEMETRY=false` - a self-hosted memory store shouldn't phone home.
- **Why a script instead of Hermes' own wizard** - `hermes memory setup mem0 --mode oss` cannot point mem0's LLM at a custom OpenAI-compatible base URL, so the gateway wiring has to be written to `mem0.json` directly; the addon README documents the exact file for manual setup.

The honest cost model: each remembered turn spends one small metered Cursor request on extraction. Storage defaults to embedded Qdrant (a local folder, zero services) which is single-process; since Hermes' messaging gateway, dashboard, and CLI are separate processes that each open the store, the addon also supports a Qdrant server out of the box (`-QdrantUrl` / `--qdrant-url`, one `docker run` documented in its README) for concurrent access.

## Testing and verification

```bash
npm run typecheck   # tsc --noEmit, zero errors
npm run lint         # eslint, zero errors
npm test             # unit tests (pure logic: translators, hashing, concurrency, tool bridge, session manager - Cursor SDK calls mocked)
npm run smoke                    # end-to-end against a RUNNING instance + a real Cursor account - costs real usage
npm run smoke:tools              # end-to-end tool-calling round trip against a RUNNING instance
npm run smoke:streaming-tools    # verifies the tool-calling bridge over an SSE stream specifically
npm run smoke:hold-mode          # verifies a multi-step tool loop runs on ONE Cursor run/agent (hold mode)
```

There's also `scripts/smoke-test-admin.ts` for the setup wizard/admin API (`SMOKE_CURSOR_API_KEY=crsr_... npx tsx scripts/smoke-test-admin.ts` against a freshly-booted, unconfigured instance) - not wired to an npm script since it expects the server to be in the pre-setup state, unlike the others.

`npm run smoke*` and the admin smoke script make real calls to the Cursor API (they need a running instance and a valid Cursor key). Everything under `npm test` is fully offline. CI (`.github/workflows/ci.yml`) runs the offline checks (typecheck, lint, unit tests, build) on Node 22.13 and 24 for every push and pull request; it deliberately does **not** run the live smoke tests, since that would mean handing a real `CURSOR_API_KEY` to untrusted PR runs.

This project's behavior was verified live, not just type-checked, and that process caught real bugs unit tests alone did not:

- An earlier implementation naively assumed Cursor's streamed assistant text was a growing cumulative snapshot, and it silently truncated every reply to just its last fragment (a live test surfaced `"banana"` coming back as `"ana"`). Fixed and covered by `test/textAccumulator.test.ts`.
- Explicit `session_id`s were only *incorrectly* appearing to work via a full-history-replay fallback that masked a re-keying bug. Fixed and covered by `test/sessionManager.test.ts`.
- The first implementation of live port/host reconfiguration (`PATCH /api/admin/config`) deadlocked: it awaited the old HTTP server fully draining before responding, but the very request making that change was itself being served by the old server and couldn't finish until the handler returned - a live test hung indefinitely instead of completing. Fixed by not awaiting the drain (see the comment in `src/index.ts`) and covered by `test/serverRebind.test.ts`, which binds a real server and asserts the triggering request resolves within a timeout instead of hanging.
- Two genuine, previously-invisible cross-platform bugs (a completely broken `npm test` on Linux, and a non-executable `start.sh` in git) - see [Cross-platform support](#cross-platform-support) for the full account of each, and `test/findAvailablePort.test.ts` for the port-fallback logic's own regression tests.
- The CLI's `config import` rejected its own exported files outright when they'd been re-saved by a common Windows tool (Notepad, PowerShell's `Out-File`) in between, because those tools prepend a UTF-8 BOM (`\uFEFF`) that `JSON.parse` doesn't tolerate - caught by actually round-tripping a file through PowerShell during live testing, not by reasoning about the code. Fixed (`stripBom()` in `bin/cli-lib.mjs`, applied on both the CLI and the dashboard's own file-upload import path) and covered by `test/cliLib.test.ts`.
- `PATCH /api/admin/config` used to silently do *nothing* for a field name it didn't recognize, instead of erroring - caught live when a CLI test using the dashboard's UI-only convenience name (`rateLimitWindowSeconds`, seconds, for display) instead of the real API field (`rateLimitWindowMs`) reported "Updated" while actually changing nothing at all. `ConfigStore.update()` now rejects any unrecognized field outright, naming it - covered by a regression test in `test/configStore.test.ts`. (`/config/import` intentionally keeps its separate, lenient "ignore what a full export legitimately contains but can't apply" behavior - the two have different jobs.)
- The CLI crashed outright with a native `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv) error on **Windows specifically**, but only on its *error* paths (e.g. the unrecognized-field case right above) - reproduced consistently by actually triggering that error repeatedly, not caught by any offline test. Root cause: calling `process.exit()` immediately after a failed `fetch()` races with undici's own socket cleanup on Windows. Fixed by letting the process exit naturally via `process.exitCode` instead of forcing it, and confirmed fixed with 8+ repeated runs of the exact failing command on Windows, plus the same command on Linux (where it never crashed to begin with, confirming this was Windows/libuv-specific).
- **The entire sidebar navigation could silently fail to render**, leaving Settings/Models/Chat/etc completely unreachable - found from a real user screenshot, not caught by any of the "does the HTML contain the right elements" checks this project had been relying on, because those never actually render the page. The desktop sidebar and mobile top bar were toggled purely by Tailwind's CDN-runtime-generated `hidden lg:flex` / `lg:hidden` utility classes; installing a headless browser (Playwright) to actually screenshot the rendered page at several real viewport widths confirmed the sidebar wasn't appearing even well above the 1024px breakpoint. Fixed by moving that show/hide logic to plain hand-written CSS in this project's own stylesheet (`.app-sidebar`/`.app-topbar` in `public/styles.css`), which is under this project's full control and behaves predictably regardless of any third-party CDN script's runtime behavior - and added a second, independent way into navigation (a hamburger-triggered slide-out drawer, reachable at any viewport width) so this specific failure mode can never fully lock a user out of the UI again. The same screenshot-based check also caught the Models tab rendering a model's own name repeated 20+ times with zero useful information (Cursor's `variants` field has no per-variant display name at all) - fixed by rendering the actually-descriptive `parameters` field instead (e.g. "Effort: Low, Medium, High, Extra High, Max").

Each of these is also described in a code comment at the exact call site that caused it, so they don't get silently reintroduced.

## Known dependency vulnerability (upstream, no fix available)

`npm audit` reports 3 advisories (1 high, 2 moderate) against `undici`, pulled in transitively via `@cursor/sdk` -> `@connectrpc/connect-node@1.7.0` -> `undici@^5.28.4`. The fixed releases only exist in `undici@7+`, but `@connectrpc/connect-node` pins `^5.28.4`, so there is no version of `undici` that is both patched and compatible with the current `@cursor/sdk` release (`npm audit` itself reports "No fix available"). Forcing a newer `undici` via a package-manager override would silently run an unsupported, untested combination against Cursor's own HTTP client - worse than the known issue. This is being tracked upstream; re-run `npm audit` after bumping `@cursor/sdk` to see if a newer release has picked up a fixed `@connectrpc/connect-node`.

## Known limitations

Documented honestly rather than glossed over:

- **No embeddings.** `POST /v1/embeddings` returns a `501` - Cursor's Agent SDK has no embeddings API. Fabricating a fake vector would silently corrupt any real similarity search, so this gateway refuses instead of pretending.
- **`max_tokens`/`max_completion_tokens` are accepted but not enforced.** The Cursor SDK's `AgentOptions`/`SendOptions` expose no per-request output-token cap, so these fields currently have no effect on generation length.
- **Tool calling:** in the default `hold` mode the whole tool loop is one Cursor run and parallel tool calls are captured; only the legacy `cancel` mode has the "first tool call per turn only" limitation (see [Tool / function calling](#tool--function-calling)).
- **Sessions are in-memory and per-process.** They don't survive a restart or scale across multiple gateway instances; use `metadata.cursor_agent_id` if you need durability across processes.
- **Cold-start replay cost.** When a conversation's agent isn't cached (first turn, TTL expiry, or eviction), prior history is folded into one text block for the model to read - this costs more input tokens than a warm, natively-continued agent would.
- **Agent tool access.** See the sandboxing note under [Security](#security) - this is inherent to headless Cursor SDK agents, not specific to this gateway.
- **Persona/system-prompt strength when embedding via another agent framework (Hermes, etc.).** Cursor's local-agent SDK has no elevated system-prompt channel for the *primary* agent - `AgentOptions.agents` is sub-agent delegation only (confirmed against `subagent-conversion.ts`), not an identity override - so a client's `system`/`developer` message(s) are necessarily inlined into the first turn's text rather than sent out-of-band. Separately, and regardless of the local `settingSources` option, Cursor's own account-level context (Rules, etc.) is attached to authenticated local-runtime requests - verified live: a model asked an identity question through this gateway quoted the account's actual configured Rules back. A model that has no reason to trust in-band text can side with that account context over a client's persona instructions and refuse to adopt it (verified live with Claude Sonnet: it called an inlined "you are Hermes Agent" system message "injected/pasted content" and refused). The gateway mitigates this by wrapping the system block with an honest explanation of its real, legitimate provenance (see `formatSystemBlock` in `src/translate/requestTranslator.ts`) rather than a bare label - verified live to fix normal-use refusal - and a **Cursor User Rule** closes the loop further since Rules are the one channel proven to reach the model with real authority; see the [Hermes addon README](addons/hermes/README.md#model-persona-refusal-i-am-cursorclaude-not-hermes) for the exact rule text. None of this changes if a model is *directly and sincerely* asked to confirm its true underlying identity - it will (and should) answer that honestly rather than sustain a persona under direct interrogation; the fix targets refusal during normal task use, not that disclosure.

## Troubleshooting

- **401 on startup / every request:** check `CURSOR_API_KEY` for whitespace, confirm it was minted for the right account, and that the key's owner has the plan/access you expect. The server logs a `verified Cursor API key on startup` line via `Cursor.me()` if the key is good.
- **429 / `AgentBusyError`:** you're exceeding `MAX_CONCURRENT_RUNS`, or an agent is receiving overlapping requests faster than it can process them (the gateway serializes per-agent sends, but a very bursty client can still queue up). Raise `MAX_CONCURRENT_RUNS` or slow down the client.
- **Requests hang, then time out:** raise `REQUEST_TIMEOUT_MS` if the task genuinely needs longer, and check the logged `runId`/`agentId` against the Cursor dashboard.
- **Tool calls aren't triggering:** confirm `CURSOR_RUNTIME=local` and `ENABLE_TOOL_BRIDGE=true`, and check server logs for a warning about tools being ignored.
- **Started on a different port than expected:** if the configured `PORT` (8787 by default) was already in use, the gateway automatically tries the next few ports instead of failing - check the startup log line ("Port X was already in use - started on Y instead.") or the dashboard for the actual port. This only happens on initial startup; an explicit port change from the admin dashboard fails clearly instead of silently substituting a different one.
- **Can't reach the admin dashboard from another device:** it's loopback-only by default - see [Dashboard security](#dashboard-security). Set `ADMIN_ALLOW_REMOTE=true` if you need that.
- **Changed the port/host from the dashboard and lost connection:** the gateway rebinds automatically and the dashboard follows via `location.href`, but if that redirect doesn't fire (browser blocked it, etc.), just navigate to the new `host:port` yourself - it's logged (`HTTP server rebind complete`) and saved in `.cursor-gateway/settings.json`.

## Architecture

```
src/
  index.ts                 entrypoint: config, startup key check, port-fallback HTTP listen + live rebind, graceful shutdown
  server.ts                Express app wiring (middleware, routes, static dashboard assets)
  config.ts                environment variable loading/validation (tolerates a missing CURSOR_API_KEY)
  configStore.ts            the one shared, mutable AppConfig instance - validates/applies/persists live admin updates
  logger.ts                pino logger with secret redaction
  errors.ts                HttpError + CursorSdkError -> OpenAI error body mapping
  validation.ts            request body validation
  types/openai.ts          hand-rolled OpenAI wire types (no runtime dependency on the openai package)
  cursor/
    modelCatalog.ts         Cursor.models.list() caching + OpenAI model-id resolution + per-model context_length derivation
    sessionManager.ts       agent cache: resume / explicit session / auto-session / fresh; also lists/evicts sessions for the dashboard
    toolBridge.ts            OpenAI tools[] -> Cursor SDKCustomTool (cancel-mode capture)
    heldToolGate.ts          hold-mode tool bridge: parks tool callbacks, batches parallel calls, resolves them from client results
    heldRunManager.ts        keeps one Cursor run alive across an entire tool loop (one metered run), keyed by tool_call_id, with an inactivity timeout
    runController.ts         drives agent.send()/Run.stream(), text accumulation, tool-call race, cancellation
  translate/
    requestTranslator.ts     OpenAI messages[] -> the single turn text/images to send
    responseTranslator.ts    RunOutcome -> OpenAI response / SSE chunks
    usage.ts                 Cursor TokenUsage -> OpenAI usage
  observability/activityLog.ts  in-memory ring buffer + aggregate stats (requests, errors, tokens, per-model, hourly) for the dashboard
  gateway/orchestrator.ts    ties the above together for both chat + legacy completions routes AND the admin test-chat endpoints (streaming + non-streaming); records every outcome to the activity log
  routes/                   Express route handlers, including admin.ts (setup wizard + full dashboard/CLI API: config get/set/export/import, system info, activity, sessions, streaming + non-streaming chat)
  middleware/                auth (constant-time compare), admin loopback restriction, rate limiting, request id, error handling
  utils/                     ids, SSE writer, hashing/diffing, concurrency primitives, token estimate, safe compare, browser launcher, port fallback, package version lookup
public/                     the admin dashboard itself - sidebar-navigated Overview/Activity/Sessions/Models/Chat/Connect/Settings, static HTML/CSS/vanilla JS + Chart.js/marked/DOMPurify (CDN), no build step, no framework
bin/
  cursor-gateway.mjs         the CLI entrypoint - see Command-line interface (CLI) above
  cli-lib.mjs                pure argument-parsing/value-coercion helpers the CLI uses, unit-tested independently of any network call
test/                       unit tests (Cursor SDK calls mocked, no network) + one real-server integration test (serverRebind.test.ts)
scripts/
  run-tests.mjs             portable, shell/Node-version-independent *.test.ts file discovery for `npm test` (see Cross-platform support)
  check-running.mjs          start.bat/start.sh pre-flight: detects an already-running gateway (same port precedence as the gateway itself) so the launchers open its dashboard instead of double-starting
  smoke-test*.ts             real end-to-end smoke tests against a running instance
autostart/                  per-OS start-at-login toolkit (install/uninstall/status/runner scripts) - see Deployment above
addons/                     optional integrations that configure external tools to use this gateway (Hermes Agent, mem0 memory) - see Addons above
start.bat / start.sh        one-click launchers for non-technical users (install, build, run, open browser)
.gitattributes              forces LF line endings in the repository regardless of a contributor's local git config
```

## License

MIT - see [LICENSE](./LICENSE).
