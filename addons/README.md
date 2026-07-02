# Addons

Optional, self-contained integrations that connect other tools to this
gateway. Each addon lives in its own folder with its own README, automated
setup scripts, and manual-setup fallback. Nothing here is required to run
the gateway itself, and no addon modifies the gateway's own code - they
only configure the external tool to talk to your running gateway.

| Addon | What it gives you |
|-------|-------------------|
| [`hermes/`](hermes/README.md) | [Hermes Agent](https://hermes-agent.nousresearch.com) (NousResearch) as a full autonomous agent on top of your Cursor subscription - Telegram/Discord/WhatsApp messaging, tool use (terminal, browser, files), cron jobs, persistent memory, and long-running sessions that survive for days. |
| [`mem0/`](mem0/README.md) | Self-hosted long-term memory for Hermes via [mem0](https://github.com/mem0ai/mem0) OSS - automatic fact extraction through this gateway (your Cursor subscription), local Ollama embeddings, local Qdrant vector storage. Tell your agent something once, it remembers it across every session and platform. |

## Addon conventions

Every addon in this folder follows the same rules:

- **One folder, everything included** - README, automated setup for each OS,
  and a documented manual path for people who don't run scripts they haven't
  read.
- **Idempotent setup** - safe to re-run; re-running repairs/refreshes rather
  than duplicating.
- **Backups before touching anything** - any external config file an addon
  modifies is backed up (timestamped) first, and the setup output tells you
  where the backup is.
- **No silent remote code execution** - if an addon can install the external
  tool for you, that's always behind an explicit opt-in flag; the default
  prints the official install command and lets you run it yourself.
- **Graceful degradation** - if part of the integration can't be applied
  automatically (e.g. a config file needs a manual merge), the setup applies
  what it safely can, prints exactly what's left, and never half-writes.
