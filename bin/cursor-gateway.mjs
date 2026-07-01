#!/usr/bin/env node
/**
 * `cursor-gateway` - a real command-line client for a *running* gateway
 * instance's admin API, covering the same ground as the web dashboard
 * (status, every live-editable setting, models, sessions, activity, and a
 * chat/test command) for scripting, automation, and headless/CI use.
 *
 * This intentionally talks to the admin HTTP API rather than reading/writing
 * `.env`/`settings.json` directly - `ConfigStore` is the single source of
 * truth for validation, live-reload, and persistence, and duplicating that
 * logic here would risk drifting out of sync with it. That does mean the
 * gateway process must actually be running for any command except `--help`.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgv, parseKeyValuePairs, resolveBaseUrl, resolveAdminKey, parseSseChunk, stripBom } from "./cli-lib.mjs";

const HELP_TEXT = `cursor-gateway - manage a running Cursor OpenAI Gateway from the command line

Usage:
  cursor-gateway <command> [subcommand] [args] [options]

Commands:
  status                        Gateway + Cursor account health at a glance
  system                        Node/gateway version, platform, workdir, uptime
  config get [key]              Print the full config, or one field
  config set key=value ...      Update one or more settings (live, no restart for most)
  config export [file]          Save the full config as JSON (default: stdout)
  config import <file>          Apply a previously exported config JSON file
  models                        List every model available to the configured Cursor account
  sessions list                 List cached multi-turn Cursor agent sessions
  sessions evict <id>           Evict one cached session by id
  sessions clear                Evict every cached session
  activity [--limit N]          Recent request activity + aggregate stats
  activity clear                Clear the in-memory activity log
  chat "<message>"              Send a message and print the reply (streams by default)
  restart                       Respawn the gateway process (applies any "restart required" setting)

Options (apply to any command):
  --url <baseUrl>       Gateway base URL (default: $GATEWAY_URL, else http://127.0.0.1:$PORT or :8787)
  --key <adminKey>      Admin key (default: $GATEWAY_ADMIN_KEY, else the local settings.json's key)
  --json                Print raw JSON instead of a formatted table
  -h, --help            Show this help

Chat-specific options:
  --model <id>          Model to use for this message (default: the gateway's configured default)
  --session <id>        Reuse/continue a specific conversation (omit for a one-off stateless message)
  --no-stream           Wait for the full reply instead of streaming it as it's generated

Examples:
  cursor-gateway status
  cursor-gateway config set defaultModel=composer-2.5 maxConcurrentRuns=16
  cursor-gateway config export my-backup.json
  cursor-gateway chat "Say hello in one word" --model composer-2.5
  cursor-gateway sessions clear
`;

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

/** Best-effort discovery of a locally persisted admin key, walking up from cwd (covers running the CLI from a subdirectory of the project). Returns `undefined` if none is found - never throws. */
function findLocalSettingsAuthKey() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, ".cursor-gateway", "settings.json");
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (parsed && typeof parsed.authKey === "string" && parsed.authKey.length > 0) return parsed.authKey;
        return undefined;
      }
    } catch {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function apiRequest(baseUrl, adminKey, method, urlPath, body) {
  const headers = { "Content-Type": "application/json" };
  if (adminKey) headers["Authorization"] = `Bearer ${adminKey}`;
  let res;
  try {
    res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach the gateway at ${baseUrl} (${err instanceof Error ? err.message : String(err)}). Is it running? Use --url to point elsewhere.`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // No/invalid JSON body - fall through with data = null.
  }
  if (!res.ok) {
    const message = data && data.error && data.error.message ? data.error.message : `Request failed (${res.status} ${res.statusText})`;
    throw new Error(message);
  }
  return data;
}

function printTable(rows, columns) {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const widths = columns.map((col) => Math.max(col.header.length, ...rows.map((row) => String(row[col.key] ?? "").length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  process.stdout.write(`${line(columns.map((c) => c.header))}\n`);
  process.stdout.write(`${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map((c) => row[c.key] ?? ""))}\n`);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function streamChat(baseUrl, adminKey, body) {
  const headers = { "Content-Type": "application/json" };
  if (adminKey) headers["Authorization"] = `Bearer ${adminKey}`;
  let res;
  try {
    res = await fetch(`${baseUrl}/api/admin/test-chat/stream`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Could not reach the gateway at ${baseUrl} (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!res.ok || !res.body) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new Error((data && data.error && data.error.message) || `Request failed (${res.status} ${res.statusText})`);
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let finalFrame = null;
  let receivedText = false;
  for await (const chunk of res.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const { frames, remainder } = parseSseChunk(buffered);
    buffered = remainder;
    for (const frame of frames) {
      if (frame.done) continue;
      const payload = frame.data;
      if (payload.type === "text") {
        receivedText = true;
        process.stdout.write(payload.delta);
      } else if (payload.type === "error") throw new Error(payload.message);
      else if (payload.type === "done") finalFrame = payload;
    }
  }
  // The model can legitimately finish with no text content at all (e.g. a
  // reply that was pure reasoning) - say so explicitly rather than leaving
  // the user staring at silent, unexplained output.
  if (!receivedText) process.stdout.write("(empty response)");
  process.stdout.write("\n");
  return finalFrame;
}

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgv(argv);

  if (flags.h || flags.help || positionals.length === 0) {
    printHelp();
    return;
  }

  const env = process.env;
  const baseUrl = resolveBaseUrl({ flags, env });
  const adminKey = resolveAdminKey({ flags, env, settingsAuthKey: findLocalSettingsAuthKey() });
  const asJson = Boolean(flags.json);
  const [command, ...rest] = positionals;

  if (command === "status") {
    const [health, status] = await Promise.all([
      apiRequest(baseUrl, adminKey, "GET", "/health"),
      apiRequest(baseUrl, adminKey, "GET", "/api/admin/status"),
    ]);
    const combined = { ...health, setupComplete: status.setupComplete, authRequired: status.authRequired };
    if (asJson) return printJson(combined);
    process.stdout.write(`Gateway:        ${baseUrl}\n`);
    process.stdout.write(`Status:         ${combined.status}\n`);
    process.stdout.write(`Setup complete: ${combined.setupComplete}\n`);
    process.stdout.write(`Auth required:  ${combined.authRequired}\n`);
    process.stdout.write(`Uptime:         ${combined.uptimeSeconds}s\n`);
    process.stdout.write(`Runtime:        ${combined.runtime}\n`);
    process.stdout.write(`Key mode:       ${combined.keyMode}\n`);
    process.stdout.write(`Sessions:       ${combined.sessions.cachedAgents} / ${combined.sessions.maxCachedAgents} cached\n`);
    process.stdout.write(`Concurrency:    ${combined.concurrency.inUse} active, ${combined.concurrency.queued} queued\n`);
    return;
  }

  if (command === "system") {
    const [system, config] = await Promise.all([
      apiRequest(baseUrl, adminKey, "GET", "/api/admin/system"),
      apiRequest(baseUrl, adminKey, "GET", "/api/admin/config"),
    ]);
    const combined = { ...system, cursorWorkdirRoot: config.cursorWorkdirRoot, nodeEnv: config.nodeEnv };
    if (asJson) return printJson(combined);
    for (const [key, value] of Object.entries(combined)) {
      process.stdout.write(`${key}: ${value}\n`);
    }
    return;
  }

  if (command === "config") {
    const [sub, ...subArgs] = rest;
    if (sub === "get") {
      const config = await apiRequest(baseUrl, adminKey, "GET", "/api/admin/config");
      if (subArgs[0]) {
        const value = config[subArgs[0]];
        if (value === undefined) return fail(`Unknown config field "${subArgs[0]}".`);
        return asJson ? printJson({ [subArgs[0]]: value }) : process.stdout.write(`${value}\n`);
      }
      return printJson(config);
    }
    if (sub === "set") {
      if (subArgs.length === 0) return fail('config set needs at least one "key=value" pair.');
      const patch = parseKeyValuePairs(subArgs);
      const result = await apiRequest(baseUrl, adminKey, "PATCH", "/api/admin/config", patch);
      if (asJson) return printJson(result);
      process.stdout.write(`Updated: ${Object.keys(patch).join(", ")}\n`);
      if (result.restartRequired) process.stdout.write("The server address changed - it has rebound automatically.\n");
      return;
    }
    if (sub === "export") {
      const config = await apiRequest(baseUrl, adminKey, "GET", "/api/admin/config/export");
      const target = subArgs[0];
      if (!target || target === "-") return printJson(config);
      fs.writeFileSync(target, JSON.stringify(config, null, 2), "utf8");
      process.stdout.write(`Saved configuration to ${target}\n`);
      return;
    }
    if (sub === "import") {
      const file = subArgs[0];
      if (!file) return fail("config import needs a file path.");
      let parsed;
      try {
        parsed = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
      } catch (err) {
        return fail(`Could not read/parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const result = await apiRequest(baseUrl, adminKey, "POST", "/api/admin/config/import", parsed);
      if (asJson) return printJson(result);
      process.stdout.write(`Applied: ${result.applied.join(", ") || "(nothing)"}\n`);
      if (result.ignored.length > 0) process.stdout.write(`Ignored: ${result.ignored.join(", ")}\n`);
      if (result.restartRequired) process.stdout.write("The server address changed - it has rebound automatically.\n");
      return;
    }
    printHelp();
    return;
  }

  if (command === "models") {
    const { models } = await apiRequest(baseUrl, adminKey, "GET", "/api/admin/models");
    if (asJson) return printJson(models);
    return printTable(
      models.map((m) => ({ id: m.id, displayName: m.displayName || "", aliases: (m.aliases || []).join(", ") })),
      [
        { key: "id", header: "ID" },
        { key: "displayName", header: "NAME" },
        { key: "aliases", header: "ALIASES" },
      ],
    );
  }

  if (command === "sessions") {
    const [sub, ...subArgs] = rest;
    if (sub === "evict") {
      const id = subArgs[0];
      if (!id) return fail("sessions evict needs a session id (see `sessions list`).");
      await apiRequest(baseUrl, adminKey, "DELETE", `/api/admin/sessions/${encodeURIComponent(id)}`);
      process.stdout.write(`Evicted ${id}\n`);
      return;
    }
    if (sub === "clear") {
      const result = await apiRequest(baseUrl, adminKey, "DELETE", "/api/admin/sessions");
      process.stdout.write(`Evicted ${result.evicted} session(s)\n`);
      return;
    }
    const { sessions } = await apiRequest(baseUrl, adminKey, "GET", "/api/admin/sessions");
    if (asJson) return printJson(sessions);
    return printTable(sessions, [
      { key: "id", header: "ID" },
      { key: "type", header: "TYPE" },
      { key: "model", header: "MODEL" },
      { key: "messageCount", header: "MESSAGES" },
    ]);
  }

  if (command === "activity") {
    const [sub] = rest;
    if (sub === "clear") {
      await apiRequest(baseUrl, adminKey, "DELETE", "/api/admin/activity");
      process.stdout.write("Activity log cleared.\n");
      return;
    }
    const { entries, stats } = await apiRequest(baseUrl, adminKey, "GET", "/api/admin/activity");
    const limit = flags.limit ? Number(flags.limit) : entries.length;
    const limited = entries.slice(0, Number.isFinite(limit) ? limit : entries.length);
    if (asJson) return printJson({ entries: limited, stats });
    process.stdout.write(
      `Total requests: ${stats.totalRequests}  |  Errors: ${stats.totalErrors}  |  Tokens (in/out): ${stats.totalPromptTokens}/${stats.totalCompletionTokens}\n\n`,
    );
    return printTable(
      limited.map((e) => ({
        time: new Date(e.timestamp).toLocaleString(),
        status: e.status,
        model: e.model,
        endpoint: e.endpoint,
        durationMs: e.durationMs,
      })),
      [
        { key: "time", header: "TIME" },
        { key: "status", header: "STATUS" },
        { key: "model", header: "MODEL" },
        { key: "endpoint", header: "ENDPOINT" },
        { key: "durationMs", header: "MS" },
      ],
    );
  }

  if (command === "chat") {
    const message = rest[0];
    if (!message) return fail('chat needs a message, e.g. cursor-gateway chat "Hello"');
    const body = {
      message,
      model: typeof flags.model === "string" ? flags.model : undefined,
      sessionId: typeof flags.session === "string" ? flags.session : undefined,
    };
    if (flags["no-stream"]) {
      const result = await apiRequest(baseUrl, adminKey, "POST", "/api/admin/test-chat", body);
      if (asJson) return printJson(result);
      process.stdout.write(`${result.content || "(empty response)"}\n`);
      return;
    }
    const finalFrame = await streamChat(baseUrl, adminKey, body);
    if (asJson && finalFrame) printJson(finalFrame);
    return;
  }

  if (command === "restart") {
    const result = await apiRequest(baseUrl, adminKey, "POST", "/api/admin/restart");
    if (asJson) return printJson(result);
    process.stdout.write(`${result.message || "Restarting."}\n`);
    return;
  }

  fail(`Unknown command "${command}". Run with --help to see available commands.`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  // Deliberately NOT calling process.exit() here (fail() already sets
  // process.exitCode, which is enough) - forcing an immediate exit right
  // after a failed fetch() races with undici's own socket/handle cleanup
  // and reliably crashes the process on Windows with a native libuv
  // assertion (`UV_HANDLE_CLOSING`), found via actually running this CLI's
  // error paths live, not by reasoning about the code. Letting the event
  // loop drain naturally avoids the race entirely.
});
