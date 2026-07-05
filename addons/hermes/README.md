# Hermes Agent addon

Turn your Cursor subscription into a full autonomous agent you can talk to
from **Telegram, Discord, WhatsApp, Slack** and more - with terminal/browser
tool use, cron jobs, persistent memory, session resume, and (optionally)
sessions that never auto-reset so multi-hour / multi-day tasks keep their
full context.

[Hermes Agent](https://hermes-agent.nousresearch.com) is NousResearch's
open-source agent framework. It speaks the OpenAI chat-completions API, and
this gateway *is* an OpenAI-compatible API backed by Cursor - so the two
snap together cleanly:

```
Telegram / Discord / CLI ──> Hermes Agent ──> this gateway (localhost:8787/v1) ──> Cursor
                              (tools, memory,      (OpenAI-compatible bridge,
                               sessions, cron)      sessions, model catalog)
```

This addon configures that connection **properly** - not the minimal
"it responds" setup, but the one where Hermes' model picker shows the
gateway's full live model catalog, compression provably works, and nothing
times out or wipes your session underneath a long-running task.

## Quick start

Prerequisites: the gateway is set up and running (see the
[main README's Quick start](../../README.md#quick-start)), and you're on the
machine it runs on.

**Windows (PowerShell):**

```powershell
cd addons\hermes
powershell -ExecutionPolicy Bypass -File setup.ps1
```

**Linux / macOS:**

```bash
cd addons/hermes
chmod +x setup.sh   # first time only
./setup.sh
```

The setup script:

1. Finds your gateway (reads `PORT` from the repo's `.env` /
   `.cursor-gateway/settings.json` the same way the gateway itself does) and
   health-checks it. On Windows, if it isn't running and the
   [`autostart/`](../../autostart/README.md) toolkit is present, it starts it.
2. Checks Hermes is installed (`hermes --version`). If not, it prints the
   official one-line installer command - or runs it for you if you passed
   the explicit opt-in flag (`-InstallHermes` / `--install-hermes`).
3. **Backs up** Hermes' `config.yaml` (timestamped), then registers the
   gateway as a **named custom provider** called `cursor` and points Hermes'
   main model at it. Named matters: Hermes only does live `/v1/models`
   discovery for named providers, so this is what makes `/model` show the
   full Cursor catalog (80+ models) instead of just the one configured model.
4. Optionally applies the **long-running session profile** (below) with
   `-LongRunning` / `--long-running`.
5. Optionally enables **native vision** (below) with
   `-NativeVision` / `--native-vision`.
6. Optionally wires up **Telegram** with
   `-TelegramToken <token> -TelegramUser <id>` / `--telegram-token`,
   `--telegram-user`.
7. Restarts the Hermes gateway if it was running, and verifies the finished
   setup end-to-end (config values re-read, gateway `/v1/models` reachable).

Everything is idempotent - re-run it any time to repair or update the
integration. It refuses (with a clear message and zero changes) rather than
guessing when it finds a config state it can't merge safely.

> **One manual step the script can't do for you:** add the
> [recommended Cursor User Rule](#recommended-cursor-user-rule) in Cursor's
> settings. Cursor User Rules live in your Cursor account, not in this repo,
> so no script can set them - but the rule is what stops some models (Claude
> Sonnet especially) from refusing to act as Hermes. Strongly recommended.

### Flags

| PowerShell | Bash | What it does |
|---|---|---|
| `-LongRunning` | `--long-running` | Apply the long-running session profile (see below) |
| `-NativeVision` | `--native-vision` | Attach images directly to your main model instead of relaying them through a separate vision model - see [Native vision](#native-vision---screenshots-your-model-actually-sees). Only use with a vision-capable default model. |
| `-TelegramToken <t>` | `--telegram-token <t>` | Set the Telegram bot token (from [@BotFather](https://t.me/BotFather)) |
| `-TelegramUser <id>` | `--telegram-user <id>` | Allowlist your numeric Telegram user id (from [@userinfobot](https://t.me/userinfobot)) |
| `-InstallHermes` | `--install-hermes` | Consent to running Hermes' official installer if Hermes is missing |
| `-Model <id>` | `--model <id>` | Default model (default: `composer-2.5`; any id from the gateway's `/v1/models`) |
| `-AuthKey <key>` | `--auth-key <key>` | The gateway's `AUTH_KEY`, if one is configured - used as the provider's `api_key` and for the setup script's own admin-API/model-catalog calls |

## What gets configured, exactly

In Hermes' `config.yaml` (location printed by `hermes config path`):

```yaml
model:
  default: composer-2.5
  provider: custom:cursor          # the named provider, not bare "custom"
  base_url: http://localhost:8787/v1
  api_key: no-key-required         # gateway in server-key mode ignores it
custom_providers:
  - name: cursor
    base_url: http://localhost:8787/v1
    api_key: no-key-required
```

And in Hermes' `.env` (path: `hermes config env-path`):

```bash
CUSTOM_BASE_URL=http://localhost:8787/v1
CUSTOM_API_KEY=no-key-required
```

Why both blocks: `model:` selects what Hermes uses right now;
`custom_providers:` is what makes `cursor` a *named* provider that Hermes
probes live for its model list. With only bare `provider: custom`, Hermes'
`/model` picker shows exactly one model (by design - verified in Hermes'
source, `hermes_cli/model_switch.py`). With the named provider you can
switch to any Cursor model from chat:

```
/model                       # interactive picker: "cursor" provider → full catalog
/model claude-sonnet-5       # direct switch by name
/model custom:cursor:gpt-5.5 # fully-qualified form
```

If the gateway has an `AUTH_KEY` set (see the main README's Security
section), pass it to the setup script and it becomes the provider's
`api_key` instead of `no-key-required`.

Why the `.env` pins: Hermes' `/model` switches and the dashboard's
"reset to auto" rewrite the `model:` block and strip `base_url`/`api_key`
from it (observed repeatedly on v0.18). Normal chat survives via the named
provider entry, but Hermes also honors `CUSTOM_BASE_URL` / `CUSTOM_API_KEY`
as endpoint fallbacks on *every* custom-provider code path - including the
bare `custom` label the stripped states degrade to. Nothing in Hermes' UI
ever rewrites `.env`, so these two lines make endpoint resolution immune to
any `config.yaml` mangling.

## Long-running session profile

Hermes' defaults are tuned for chat, not for autonomous tasks that run for
hours or days. `-LongRunning` / `--long-running` applies this verified
profile:

| Setting | Default | Profile | Why |
|---|---|---|---|
| `session_reset.mode` (Hermes) | `both` (daily 4:00 wipe + 24h-idle wipe) | `none` | Sessions never auto-reset; context is managed by compression only. `/new`, `/reset`, `/resume` still work manually. |
| `agent.max_turns` (Hermes) | 90 | 300 | Tool-loop iterations per turn. A long autonomous task can easily exceed 90 tool calls; Hermes' budget-pressure warnings scale with this automatically. |
| `auxiliary.compression.provider` + `.model` (Hermes) | auto-detect | `custom:cursor` + your default model | Compression - the thing that lets an endless session survive a finite context window - is a separate LLM call. Pinning it to the gateway's *named* provider entry guarantees it always has working credentials, and (same model = same context length) satisfies Hermes' documented requirement that the summary model's context be ≥ the main model's. Deliberately NOT the `main` label: Hermes resolves `main` through its runtime provider label, which inside the messaging gateway is bare `custom` - a path with no endpoint credentials, so summaries silently fail and compression drops middle turns unsummarized (observed live). |
| `auxiliary.background_review.provider` + `.model` (Hermes) | auto (= main model) | `custom:cursor` + your default model | Hermes forks a **background skill review** (a full separate LLM call carrying a digest of the conversation) every `skills.creation_nudge_interval` tool iterations - 10 by default, so a long tool-heavy task quietly bills one extra main-model run per ~10 steps. Pinning it keeps the skills feature but moves the housekeeping off your primary model. (Set `skills.creation_nudge_interval: 0` instead if you want it gone entirely.) |
| `auxiliary.title_generation.provider` + `.model` (Hermes) | auto (= main model) | `custom:cursor` + your default model | Session titles are generated by a separate LLM call after the first exchange of every new session. |
| `auxiliary.approval.provider` + `.model` (Hermes) | auto (= main model) | `custom:cursor` + your default model | When a shell command trips Hermes' risk detector, an LLM guard call assesses it (APPROVE/DENY/ESCALATE). Fires per flagged command. |
| `REQUEST_TIMEOUT_MS` (gateway `.env`) | 300000 (5 min) | 1800000 (30 min) | Per-completion-call cap. 5 minutes kills long single agent steps; 30 minutes matches Hermes' own internal `HERMES_API_TIMEOUT=1800s` exactly, so the two layers never disagree. |
| `SESSION_TTL_MS` (gateway `.env`) | 1800000 (30 min) | 86400000 (24 h) | How long the gateway keeps your session's Cursor agent (and its prompt cache) alive across idle gaps. |

Honest trade-off, straight from Hermes' docs: with `mode: none`, context is
managed purely by **lossy compression** - once a conversation crosses
`compression.threshold` (50% of the context window by default), older middle
turns get summarized. The opening exchange (`protect_first_n`) and the most
recent messages (`protect_last_n`) always survive verbatim. That's the
physics of finite context windows, not something any configuration removes.

The gateway values are applied to the repo's `.env` (backed up first) and
need a gateway restart to take effect - the setup script tells you if that's
still pending, and on Windows offers the autostart toolkit's runner to do it.

## Native vision - screenshots your model actually sees

By default, Hermes cannot tell that a model served through a custom provider
is vision-capable (its capability database doesn't cover custom routes), so
every image - `computer_use` screenshots, `browser_vision` captures,
`vision_analyze` calls, photos you send on Telegram - gets routed through a
**separate auxiliary vision model**: one extra metered LLM call per image,
and your main model only ever sees a *text description* of the screen, never
the pixels.

If your default model is vision-capable (Claude Sonnet, GPT-5-family, Gemini,
Grok - most of the Cursor catalog), two settings fix that - applied for you
by `-NativeVision` / `--native-vision`, or by hand:

```bash
hermes config set model.supports_vision true
hermes config set agent.image_input_mode native
```

Now images attach **directly to your main model's context**: no auxiliary
vision calls, and screenshot tool results ride the same held Cursor run as
the rest of the tool loop - the gateway forwards base64 images inside tool
results as real image blocks (see the main README's
[Tool / function calling](../../README.md#tool--function-calling) section).
Verified live: a Telegram "take a screenshot and describe my screen" turn
runs as **one** metered Cursor request, with the model reading actual pixels.

Two caveats, so you can decide deliberately:

- `model.supports_vision: true` declares whatever model is *currently active*
  vision-capable. If you regularly `/model`-switch to non-vision models,
  leave it unset - Hermes recovers from a rejected image with a retry, but
  that costs a round-trip.
- If you explicitly configured `auxiliary.vision` (provider/model), that
  override wins and screenshots still go to the auxiliary model - that's
  Hermes honoring your explicit choice. Leave `auxiliary.vision.provider`
  as `auto` to use the native path.

## Messaging platforms (Telegram shown; others analogous)

1. Create a bot: message [@BotFather](https://t.me/BotFather), `/newbot`,
   copy the token.
2. Get your numeric user id: message [@userinfobot](https://t.me/userinfobot).
3. Run the setup with `-TelegramToken` / `--telegram-token` and
   `-TelegramUser` / `--telegram-user` (or re-run it later with just those
   flags - idempotent).
4. Run the Hermes gateway: `hermes gateway` in a terminal to try it out, or
   `hermes gateway install` to run it as a background service that starts
   with your machine.
5. Message your bot. Useful commands: `/model` (switch models), `/sethome`
   (make this chat the delivery target for cron job results), `/resume`
   (browse and restore past sessions), `/new` (fresh session).

The allowlist matters: without `TELEGRAM_ALLOWED_USERS`, Hermes denies
unknown senders by default (good). This addon never sets
`GATEWAY_ALLOW_ALL_USERS=true` for you - it's your bot's front door and
open access should be a deliberate decision, not a setup default.

For Discord, WhatsApp, Slack, Signal, email and the rest, run
`hermes gateway setup` - Hermes' own interactive wizard covers all of them.
This addon's gateway-side work (provider, models, timeouts) is
platform-agnostic and applies to every platform equally.

Want your agent to actually *remember* you across sessions and platforms?
Pair this with the [mem0 addon](../mem0/README.md) - self-hosted long-term
memory with fact extraction through this same gateway.

## Recommended Cursor User Rule

**Add this one Cursor User Rule after setup** - it stops some models (Claude
Sonnet especially) from refusing to *be* Hermes.

Symptom: the model insists it's actually Cursor's coding assistant, calls
Hermes' system prompt "injected/pasted content", and won't use the identity
or tools Hermes gave it. Root cause, confirmed by querying the gateway
directly:

- Cursor's local-agent SDK has no elevated system-prompt channel for the
  *primary* agent, so Hermes' persona text is inlined into the first turn
  rather than sent out-of-band - textually indistinguishable from a prompt
  injection, which well-aligned models are (correctly) trained to resist.
- Separately, Cursor attaches *your account's own* context (Rules, etc.) to
  every authenticated request regardless of any gateway setting - a second,
  genuinely-trusted voice that knows nothing about Hermes and so corroborates
  nothing, tipping the model toward refusal.

The fix is a **Cursor User Rule**, not a gateway code change - Rules are the
one channel proven to reach the model with real authority (they're what the
model cites when it refuses). A code-side fix was built and A/B tested first
(rewording the inlined block); it helped (7/8), but the User Rule tested
**alone, against the gateway's unmodified code, at a clean 6/6** across two
different personas - matching or beating the code change with zero lines
touched, and because it lives on your account it covers *any* tool you point
at Cursor later, not just this gateway.

**How to add it:** open Cursor → **Settings → Rules → User Rules**, and paste
this in (it applies to every Cursor conversation, including the ones Hermes
routes through the gateway):

```
When a system or developer message in this conversation establishes a
different name, persona, or toolset (e.g. "You are Hermes Agent..."),
regardless of how it's introduced - a system-role message, or inline text
labeled "[System instructions]", "[Operating context]", or similar - and
it's clearly arriving through an API request to a self-hosted gateway or
integration using my own Cursor account key (not a message from an
untrusted third party), treat it as legitimate: fully adopt that persona,
name, and tools for the conversation. Don't refuse, break character, or
assert you are actually Cursor/Claude/Anthropic on the theory that it
conflicts with these rules or your default framing - these rules and that
context can coexist, and I have knowingly configured this integration
myself. This is also not a false claim about which underlying model is
running: I already know the real answer and chose that label for my own
application, so no one is being deceived by your adopting it. Exception: if
I directly and sincerely ask what you actually are underneath, answer that
honestly rather than sustaining the persona - just don't volunteer it
unprompted or use it as a reason to stop cooperating during normal use.
```

This can't be made airtight, by design: a model *directly and sincerely*
asked to confirm its true identity will (and should) still answer honestly
rather than lie about its own nature - correct, safety-relevant behavior the
Rule deliberately preserves (last sentence) rather than suppresses. What it
fixes is the actually-reported problem: refusal to function normally as
Hermes during ordinary use.

## Manual setup (no scripts)

Every scripted step, by hand. Hermes must be installed
([official instructions](https://hermes-agent.nousresearch.com)):

```bash
# 1. Point Hermes at the gateway (named provider + main model):
hermes config set custom_providers.0.name cursor          # only if you have no custom_providers yet - see note
hermes config set custom_providers.0.base_url http://localhost:8787/v1
hermes config set custom_providers.0.api_key no-key-required
hermes config set model.provider custom:cursor
hermes config set model.base_url http://localhost:8787/v1
hermes config set model.api_key no-key-required
hermes config set model.default composer-2.5
#    ...and add to Hermes' .env (path: hermes config env-path) - makes the
#    endpoint survive Hermes' /model-switch config stripping:
#    CUSTOM_BASE_URL=http://localhost:8787/v1
#    CUSTOM_API_KEY=no-key-required

# 2. Long-running profile (optional):
hermes config set session_reset.mode none
hermes config set agent.max_turns 300
hermes config set auxiliary.compression.provider custom:cursor
hermes config set auxiliary.compression.model composer-2.5   # match your model.default
#    ...and pin the rest of Hermes' automatic housekeeping calls (background
#    skill review, session titles, command-approval guard) - each is a
#    separate metered request that otherwise runs on your main model:
hermes config set auxiliary.background_review.provider custom:cursor
hermes config set auxiliary.background_review.model composer-2.5
hermes config set auxiliary.title_generation.provider custom:cursor
hermes config set auxiliary.title_generation.model composer-2.5
hermes config set auxiliary.approval.provider custom:cursor
hermes config set auxiliary.approval.model composer-2.5
#    ...and in the REPO's .env: REQUEST_TIMEOUT_MS=1800000, SESSION_TTL_MS=86400000
#    then restart the gateway.

# 3. Native vision (optional - only if your default model is vision-capable):
hermes config set model.supports_vision true
hermes config set agent.image_input_mode native

# 4. Telegram (optional):
hermes config set TELEGRAM_BOT_TOKEN <your-token>          # routes to Hermes' .env automatically
#    then add to Hermes' .env (path: hermes config env-path):
#    TELEGRAM_ALLOWED_USERS=<your-numeric-id>

# 5. Restart & verify:
hermes gateway restart      # or just: hermes gateway
hermes config show          # confirm the model/provider blocks
```

**Note on `custom_providers.0.*`:** Hermes' `config set` navigates into
existing list indices but does not grow lists. If you *already have*
`custom_providers` entries, don't overwrite index `0` - add the `cursor`
entry to the list by editing `config.yaml` directly (the setup scripts
handle this detection for you; it's only the manual path that needs care).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Telegram: "model provider failed after retries" | Gateway not running (e.g. after a reboot) | Start it - or install [`autostart/`](../../autostart/README.md) so this stops happening. `hermes logs` shows the underlying error. |
| `/model` shows only one model | Provider is bare `custom`, not the named `custom:cursor` | Re-run this setup; it converts the config. |
| A long step dies at exactly 5 minutes | Gateway `REQUEST_TIMEOUT_MS` still at default | Apply the long-running profile (or raise it in `.env` / the dashboard) and restart the gateway. |
| Session reset overnight | `session_reset.mode` still `both`/`daily` | Apply the long-running profile, restart `hermes gateway`. |
| Bot ignores you entirely | Your user id isn't in `TELEGRAM_ALLOWED_USERS` | Re-run setup with the Telegram flags, or edit Hermes' `.env`. |
| Multiple gateway requests per message in Cursor's dashboard | Hermes runs an agent loop: each model call is one HTTP request. The gateway's default `hold` tool-bridge mode keeps a single Cursor *run* alive across a whole tool loop (so the loop is one metered Cursor request, like the native app), but Hermes still opens a fresh HTTP request per loop step, and non-tool reasoning turns are their own runs. So you'll see fewer metered runs than before, though still more than one per Telegram message on multi-step tasks. | Expected. Nothing to fix. If you ever want the strict legacy one-run-per-step behavior, set `TOOL_BRIDGE_MODE=cancel` on the gateway - but `hold` (default) is what you want. |
| Extra runs on your *main* model you didn't ask for (visible during long tasks or on new sessions) | Hermes' automatic housekeeping - background skill review (every `skills.creation_nudge_interval` tool iterations), session title generation (first exchange), and the command-approval guard (flagged commands) - each runs as its own LLM call, defaulting to your main model | Apply the long-running profile (it pins all of them to the summarizer model), or pin the `auxiliary.background_review` / `auxiliary.title_generation` / `auxiliary.approval` blocks yourself - see [Long-running session profile](#long-running-session-profile) |
| "Model provider failed after retries" deep into a long screenshot-heavy session (Hermes logs show `request entity too large`) | With [native vision](#native-vision---screenshots-your-model-actually-sees), every screenshot lives in the resent history as base64 - after enough polling iterations the request body crosses the gateway's 25 MB JSON limit | Update the gateway: it now returns a true HTTP **413** for oversized bodies (older builds returned 500), which triggers Hermes' built-in 413 recovery - it compresses history, downgrades old screenshots to text summaries, and continues on its own |
| Model persona refusal ("I am Cursor/Claude, not Hermes") | The model is inlined a persona it can't distinguish from a prompt injection, and Cursor's own account context doesn't corroborate it | Add the [recommended Cursor User Rule](#recommended-cursor-user-rule) (own section above) - tested to fix it 6/6 |
| Screenshots come back as text descriptions, or every image costs an extra metered request | Hermes doesn't know custom-provider models are vision-capable, so it routes images through a separate auxiliary vision model | Enable [native vision](#native-vision---screenshots-your-model-actually-sees) (`model.supports_vision true` + `agent.image_input_mode native`) |
| `computer_use` captures return tiny/wrong-app garbage (e.g. `318x78` of the wrong window) | An orphaned `cua-driver.exe` from a dead parent process is wedging the capture backend | From an **admin** shell: `taskkill /F /IM cua-driver.exe` - Hermes respawns a clean driver on the next call |

Two facts worth knowing about usage: requests through this integration
appear in Cursor's dashboard as normal plan usage ("Included"), and
programmatic SDK use of your own account is a supported Cursor use case -
what their ToS prohibits is *reselling* access (see the main README's
[Cursor Terms of Service](../../README.md#cursor-terms-of-service) section).
Keep this personal.

## Uninstall / revert

The setup backs up Hermes' `config.yaml` before changing it (path is
printed during setup, format `config.yaml.bak-cursor-addon-<timestamp>`).
To revert: restore that backup (or run `hermes model` and pick a different
provider), remove the two Telegram lines from Hermes' `.env` if you added
them, and restore the repo `.env` backup if you applied the long-running
profile. The addon itself keeps no state anywhere else.
