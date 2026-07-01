/**
 * Pure, side-effect-free helpers for the `cursor-gateway` CLI
 * (`bin/cursor-gateway.mjs`). Kept in a separate module - with no network,
 * filesystem, or process access - so argument parsing and value coercion can
 * be unit-tested directly (see `test/cliLib.test.ts`) without spinning up a
 * real gateway.
 */

/**
 * Mirrors the editable field -> type mapping in `src/configStore.ts`
 * (`EDITABLE_STRING_FIELDS`/`EDITABLE_BOOL_FIELDS`/`EDITABLE_INT_FIELDS`/
 * `EDITABLE_ENUM_FIELDS`). Duplicated here rather than imported because this
 * CLI is a standalone script with zero dependency on the compiled server -
 * it can run (and print a useful error) even if `npm run build` was never
 * run. If you add a new editable config field on the server, add it here too.
 */
export const CONFIG_FIELD_TYPES = Object.freeze({
  cursorApiKey: "string",
  defaultModel: "string",
  corsOrigin: "string",
  host: "string",
  cursorKeyMode: "string",
  cursorRuntime: "string",
  cursorAgentMode: "string",
  logLevel: "string",
  cursorWorkdirRoot: "string",
  nodeEnv: "string",
  authKey: "string",
  includeThinking: "boolean",
  sessionsEnabled: "boolean",
  autoSessionEnabled: "boolean",
  toolBridgeEnabled: "boolean",
  logPretty: "boolean",
  autoOpenBrowser: "boolean",
  adminAllowRemote: "boolean",
  sessionTtlMs: "number",
  maxCachedAgents: "number",
  maxConcurrentRuns: "number",
  requestTimeoutMs: "number",
  rateLimitWindowMs: "number",
  rateLimitMax: "number",
  port: "number",
});

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/** Converts a single CLI-supplied string value to the type the server expects for `key`, based on {@link CONFIG_FIELD_TYPES}. Unknown keys pass through as strings unchanged - the server has the final say and will reject anything it doesn't recognize. */
export function coerceConfigValue(key, rawValue) {
  const type = CONFIG_FIELD_TYPES[key];
  if (type === "boolean") {
    const normalized = rawValue.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    throw new Error(`"${key}" expects a boolean value (true/false/yes/no/1/0), got "${rawValue}"`);
  }
  if (type === "number") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) throw new Error(`"${key}" expects a number, got "${rawValue}"`);
    return parsed;
  }
  return rawValue;
}

/** Parses `["key1=value1", "key2=value2"]` (as given to `config set`) into a typed `{ key: value }` object ready to PATCH. Throws on malformed pairs (no `=`, empty key) with a message naming the offending pair. */
export function parseKeyValuePairs(pairs) {
  const result = {};
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) throw new Error(`Expected "key=value", got "${pair}"`);
    const key = pair.slice(0, eqIndex).trim();
    const rawValue = pair.slice(eqIndex + 1);
    if (!key) throw new Error(`Empty key in "${pair}"`);
    result[key] = coerceConfigValue(key, rawValue);
  }
  return result;
}

/**
 * Minimal, dependency-free argv tokenizer. Splits `argv` (already stripped of
 * `node`/script path by the caller) into positional arguments and `--flag`
 * options. Supports `--flag value`, `--flag=value`, and bare boolean
 * `--flag`. A flag "eats" the next token as its value unless that token
 * itself looks like another flag (starts with `--`) or there isn't one.
 */
export function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex !== -1) {
        flags[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

/** Resolves the gateway's base URL: `--url` flag > `GATEWAY_URL` env var > `http://127.0.0.1:<PORT env var, default 8787>`. */
export function resolveBaseUrl({ flags, env }) {
  if (typeof flags.url === "string" && flags.url.length > 0) return flags.url.replace(/\/+$/, "");
  if (env.GATEWAY_URL) return env.GATEWAY_URL.replace(/\/+$/, "");
  const port = env.PORT && env.PORT.trim().length > 0 ? env.PORT.trim() : "8787";
  return `http://127.0.0.1:${port}`;
}

/** Resolves the admin key: `--key` flag > `GATEWAY_ADMIN_KEY` env var > the locally persisted `.cursor-gateway/settings.json`'s `authKey` (only meaningful when the CLI runs on the same machine as the gateway, which is the common case). */
export function resolveAdminKey({ flags, env, settingsAuthKey }) {
  if (typeof flags.key === "string" && flags.key.length > 0) return flags.key;
  if (env.GATEWAY_ADMIN_KEY) return env.GATEWAY_ADMIN_KEY;
  return settingsAuthKey || undefined;
}

/** Strips a leading UTF-8 BOM (U+FEFF), if present. JSON.parse rejects it outright, but it's common in files re-saved by Windows tools (Notepad, PowerShell's `Out-File -Encoding utf8`). */
export function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

/** Splits a raw SSE byte chunk buffer into complete `data: ...` frame payloads (parsed as JSON) plus any leftover partial frame to prepend to the next chunk. Mirrors the `\n\n`-delimited framing `SseWriter` (server-side) writes. */
export function parseSseChunk(buffer) {
  const frames = [];
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      frames.push({ done: true });
      continue;
    }
    try {
      frames.push({ done: false, data: JSON.parse(payload) });
    } catch {
      // Ignore malformed frames rather than crashing the whole stream read.
    }
  }
  return { frames, remainder };
}
