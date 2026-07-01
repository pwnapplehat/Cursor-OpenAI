# cursor-openai-gateway

A production-grade, OpenAI-compatible API gateway backed by the [Cursor Agent SDK](https://cursor.com/docs/sdk/typescript). Point any OpenAI-compatible client, library, or tool at this server instead of `api.openai.com`, and your requests run through a real Cursor agent using your own Cursor subscription/API key.

```
OpenAI-compatible client            cursor-openai-gateway                 Cursor
(openai SDK, LangChain,     ──▶     Express + @cursor/sdk        ──▶      Agent SDK / Cloud API
LiteLLM, Continue, curl...)         (this project)                       (your CURSOR_API_KEY)
```

Built directly against the real `@cursor/sdk` v1.0.x type definitions (not guesswork) and verified end-to-end against the live Cursor API - streaming, multi-turn sessions, and OpenAI-style tool/function calling all actually work, not just on paper. See [Verification](#verification) for the real test transcripts.

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Endpoints](#endpoints)
- [Client examples](#client-examples)
- [Sessions and multi-turn conversations](#sessions-and-multi-turn-conversations)
- [Tool / function calling](#tool--function-calling)
- [Security](#security)
- [Cursor Terms of Service](#cursor-terms-of-service)
- [Deployment](#deployment)
- [Testing and verification](#testing-and-verification)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [License](#license)

## Features

- **`/v1/chat/completions`** - streaming (SSE) and non-streaming, system/user/assistant/tool messages, images (`image_url`, including base64 data URLs), usage accounting.
- **`/v1/completions`** - legacy text-completion endpoint, implemented as a thin adapter over the chat pipeline.
- **`/v1/models`** / **`/v1/models/:id`** - live catalog pulled from `Cursor.models.list()` for the authenticated key, including aliases.
- **`/v1/embeddings`** - returns a clear, correctly-shaped `501` error rather than a fabricated vector (Cursor's Agent SDK has no embeddings API - see [Known limitations](#known-limitations)).
- **Streaming with real deltas** - chain-of-thought/"thinking" text can be streamed as `reasoning_content`, matching the convention used by DeepSeek/o1-style OpenAI-compatible clients.
- **Multi-turn sessions** with three ways to keep context across requests: automatic conversation-hash detection, an explicit `session_id`, or resuming a real Cursor agent by id. See [Sessions](#sessions-and-multi-turn-conversations).
- **OpenAI tool/function-calling bridge** - your `tools[]` schemas are registered as native Cursor custom tools; when the model calls one, the gateway hands control back to your application as a standard `tool_calls` response, exactly like talking to OpenAI directly. See [Tool calling](#tool--function-calling) for how this actually works and its one real limitation.
- **Concurrency controls** - a global semaphore (`MAX_CONCURRENT_RUNS`) plus per-agent mutexes prevent overwhelming the Cursor backend or triggering `AgentBusyError`.
- **Two auth modes** - a single server-side `CURSOR_API_KEY` for personal use, or `passthrough` mode where each client supplies its own Cursor key via `Authorization: Bearer`, so one running gateway can serve multiple Cursor accounts.
- **Robust error mapping** - every `CursorSdkError` subclass (`AuthenticationError`, `RateLimitError`, `AgentBusyError`, `ConfigurationError`, `NetworkError`, ...) maps to the correct HTTP status and an OpenAI-shaped error body.
- **Client-disconnect handling** - aborts the underlying Cursor run when the calling HTTP client disconnects mid-stream, so you don't pay for work nobody reads.
- Structured logging (pino, with secrets redacted), rate limiting, Helmet security headers, graceful shutdown, Docker image, and a real end-to-end smoke test suite.

## Quick start

Requires Node.js >= 18.17.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `CURSOR_API_KEY` to a user API key from [Cursor Dashboard -> Integrations](https://cursor.com/dashboard/integrations), or a team service-account key from Team Settings -> Service accounts.

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

## Configuration

All configuration is environment variables - see [`.env.example`](./.env.example) for the full, documented list (auth mode, runtime, sessions, tool bridge, concurrency limits, rate limiting, logging). The important ones to know up front:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_API_KEY` | *(required in server mode)* | Your Cursor API key. |
| `CURSOR_KEY_MODE` | `server` | `server` uses `CURSOR_API_KEY` for everyone; `passthrough` uses each client's own bearer token as their Cursor key. |
| `AUTH_KEY` | *(none)* | Optional bearer token clients must send to use this gateway (ignored in `passthrough` mode). |
| `CURSOR_RUNTIME` | `local` | `local` runs agents on this machine; `cloud` runs on a Cursor-hosted VM. The tool-calling bridge requires `local`. |
| `DEFAULT_MODEL` | `composer-2.5` | Used when a client's requested model isn't in your account's catalog. |
| `MAX_CONCURRENT_RUNS` | `8` | Global cap on simultaneous Cursor agent runs; extra requests queue. |

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

Cursor's SDK executes tools *inline*, inside its own agent loop - it has no concept of "pause and ask an external caller to run this function," which is exactly OpenAI's tool-calling contract. This gateway bridges the two:

1. Each of your `tools[]` function schemas is registered as a real Cursor `SDKCustomTool` (native tool-calling, not a prompt-based hack - the model sees a proper JSON schema and decides to call it like any other tool).
2. When the model invokes one, the tool's `execute()` callback fires with the arguments. Instead of running anything (the gateway doesn't have your function's real implementation, only its schema), it captures the call and the gateway immediately cancels the underlying Cursor run.
3. The captured call is returned to you as a standard OpenAI `tool_calls` response (`finish_reason: "tool_calls"`).
4. You execute the tool yourself and send the result back as a normal `{"role": "tool", "tool_call_id": ..., "content": ...}` message on your next request (with the same `session_id`/history) - the gateway feeds it back into the same agent and the conversation continues, exactly like a normal OpenAI tool-calling loop.

This was verified end-to-end against the real Cursor API (`npm run smoke:tools`), including the full round trip: model requests a tool, gateway returns `tool_calls`, caller submits the result, agent's follow-up correctly uses it.

**Known limitation:** only the *first* tool call requested in a turn is captured, because the underlying run is cancelled as soon as it fires. If a turn wants to call multiple tools in parallel, only the first is observed. Sequential tool calls across multiple turns work fine. This bridge also only works when `CURSOR_RUNTIME=local` (custom tools are a local-agent-only SDK feature) - requests with `tools[]` are logged and ignored (tools stripped) if `CURSOR_RUNTIME=cloud` or `ENABLE_TOOL_BRIDGE=false`.

## Security

- **Secrets:** `CURSOR_API_KEY` lives only in `.env` (git-ignored) or your process environment, is masked in logs, and is never returned in any response body.
- **`AUTH_KEY`:** set this to require clients to authenticate to the gateway itself (`Authorization: Bearer <AUTH_KEY>`). Not used in `passthrough` mode, since the bearer slot there is already the client's own Cursor key.
- **Agent sandboxing:** by default, Cursor local agents can read/write files and run shell commands within their working directory and reach the network - there is no human-in-the-loop approval step in headless SDK runs (this is documented SDK behavior, not something this gateway can fully turn off). This gateway limits blast radius by giving every session its own isolated scratch directory under `CURSOR_WORKDIR` (default `./.cursor-gateway/workspaces/<hash>`) rather than pointing agents at a real project checkout. If you need agents to operate on a real codebase, set `CURSOR_WORKDIR` deliberately and understand the exposure that implies.
- **Rate limiting:** `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` apply per resolved Cursor API key (or per IP if none).

## Cursor Terms of Service

This is a self-hosted tool that uses the official Cursor SDK/API with your own key - it is not a way to circumvent Cursor's pricing or an unofficial reverse-engineered API. Per [Cursor's Terms of Service](https://cursor.com/terms-of-service) §1.5(iii), you may not "rent, lease, lend, or sell" the Service. Embedding Cursor as a backend AI service inside your own application or workflow via the SDK/API is an explicitly supported use case (see Cursor's own [Notion SDK case study](https://cursor.com/blog/notion)); what's restricted is reselling access to your account/usage to third parties (e.g. selling people time on your subscription). Run this gateway for your own personal or internal use; don't turn it into a paid multi-tenant service reselling your Cursor plan.

## Deployment

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

## Testing and verification

```bash
npm run typecheck   # tsc --noEmit, zero errors
npm run lint         # eslint, zero errors
npm test             # unit tests (pure logic: translators, hashing, concurrency, tool bridge, session manager - Cursor SDK calls mocked)
npm run smoke        # end-to-end against a RUNNING instance + a real Cursor account - costs real usage
npm run smoke:tools  # end-to-end tool-calling round trip against a RUNNING instance
```

`npm run smoke` and `npm run smoke:tools` make real calls to the Cursor API (they need `npm run dev`/`npm start` running first, and a valid `CURSOR_API_KEY`). Everything else is fully offline.

This project's behavior was verified live, not just type-checked: an earlier implementation naively assumed Cursor's streamed assistant text was a growing cumulative snapshot, and it silently truncated every reply to just its last fragment (a live test surfaced `"banana"` coming back as `"ana"`). That bug, and a related one where explicit `session_id`s were only *incorrectly* appearing to work via a full-history-replay fallback, are both covered by regression tests in `test/textAccumulator.test.ts` and `test/sessionManager.test.ts`, and both are described in code comments at the exact call sites, so they don't get silently reintroduced.

## Known limitations

Documented honestly rather than glossed over:

- **No embeddings.** `POST /v1/embeddings` returns a `501` - Cursor's Agent SDK has no embeddings API. Fabricating a fake vector would silently corrupt any real similarity search, so this gateway refuses instead of pretending.
- **`max_tokens`/`max_completion_tokens` are accepted but not enforced.** The Cursor SDK's `AgentOptions`/`SendOptions` expose no per-request output-token cap, so these fields currently have no effect on generation length.
- **Tool calling captures only the first tool call per turn** (see [Tool / function calling](#tool--function-calling)).
- **Sessions are in-memory and per-process.** They don't survive a restart or scale across multiple gateway instances; use `metadata.cursor_agent_id` if you need durability across processes.
- **Cold-start replay cost.** When a conversation's agent isn't cached (first turn, TTL expiry, or eviction), prior history is folded into one text block for the model to read - this costs more input tokens than a warm, natively-continued agent would.
- **Agent tool access.** See the sandboxing note under [Security](#security) - this is inherent to headless Cursor SDK agents, not specific to this gateway.

## Troubleshooting

- **401 on startup / every request:** check `CURSOR_API_KEY` for whitespace, confirm it was minted for the right account, and that the key's owner has the plan/access you expect. The server logs a `verified Cursor API key on startup` line via `Cursor.me()` if the key is good.
- **429 / `AgentBusyError`:** you're exceeding `MAX_CONCURRENT_RUNS`, or an agent is receiving overlapping requests faster than it can process them (the gateway serializes per-agent sends, but a very bursty client can still queue up). Raise `MAX_CONCURRENT_RUNS` or slow down the client.
- **Requests hang, then time out:** raise `REQUEST_TIMEOUT_MS` if the task genuinely needs longer, and check the logged `runId`/`agentId` against the Cursor dashboard.
- **Tool calls aren't triggering:** confirm `CURSOR_RUNTIME=local` and `ENABLE_TOOL_BRIDGE=true`, and check server logs for a warning about tools being ignored.

## Architecture

```
src/
  index.ts                 entrypoint: config, startup key check, graceful shutdown
  server.ts                Express app wiring (middleware, routes)
  config.ts                environment variable loading/validation
  logger.ts                pino logger with secret redaction
  errors.ts                HttpError + CursorSdkError -> OpenAI error body mapping
  validation.ts            request body validation
  types/openai.ts          hand-rolled OpenAI wire types (no runtime dependency on the openai package)
  cursor/
    modelCatalog.ts         Cursor.models.list() caching + OpenAI model-id resolution
    sessionManager.ts       agent cache: resume / explicit session / auto-session / fresh
    toolBridge.ts            OpenAI tools[] -> Cursor SDKCustomTool + call capture
    runController.ts         drives agent.send()/Run.stream(), text accumulation, tool-call race, cancellation
  translate/
    requestTranslator.ts     OpenAI messages[] -> the single turn text/images to send
    responseTranslator.ts    RunOutcome -> OpenAI response / SSE chunks
    usage.ts                 Cursor TokenUsage -> OpenAI usage
  gateway/orchestrator.ts    ties the above together for both chat + legacy completions routes
  routes/                   Express route handlers
  middleware/                auth, rate limiting, request id, error handling
  utils/                     ids, SSE writer, hashing/diffing, concurrency primitives, token estimate
test/                       unit tests (Cursor SDK calls mocked, no network)
scripts/                    real end-to-end smoke tests against a running instance
```

## License

MIT - see [LICENSE](./LICENSE).
