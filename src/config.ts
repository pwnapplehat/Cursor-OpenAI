import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function requireString(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw !== undefined && raw !== "") return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`Missing required environment variable: ${name}`);
}

export function optionalString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

export function parseInteger(raw: string, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ConfigError(`${label} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

export function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return parseInteger(raw, `Environment variable ${name}`);
}

export function parseBoolean(raw: string, label: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${label} must be a boolean-like value, got "${raw}"`);
}

export function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return parseBoolean(raw, `Environment variable ${name}`);
}

export type CursorKeyMode = "server" | "passthrough";
export type CursorRuntimeKind = "local" | "cloud";
export type CursorAgentModeOption = "agent" | "plan";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
export type ToolBridgeMode = "hold" | "cancel";

export interface AppConfig {
  cursorApiKey: string | undefined;
  cursorKeyMode: CursorKeyMode;
  port: number;
  host: string;
  nodeEnv: string;
  authKey: string | undefined;
  corsOrigin: string;
  cursorRuntime: CursorRuntimeKind;
  cursorWorkdirRoot: string;
  cursorAgentMode: CursorAgentModeOption;
  defaultModel: string;
  includeThinking: boolean;
  sessionsEnabled: boolean;
  autoSessionEnabled: boolean;
  sessionTtlMs: number;
  maxCachedAgents: number;
  maxConcurrentRuns: number;
  requestTimeoutMs: number;
  toolBridgeEnabled: boolean;
  /**
   * How the OpenAI tool-calling bridge maps onto Cursor's inline-tool SDK:
   * - `hold` (default): keep ONE Cursor run alive across the whole tool loop
   *   by parking its tool callbacks until the client returns results - so a
   *   multi-step tool conversation is one metered Cursor run, like the native
   *   app. Captures parallel tool calls in a turn.
   * - `cancel`: legacy behavior - cancel the run on the first tool call and
   *   let the client's follow-up start a fresh run (N runs per loop, only the
   *   first tool call per turn observed). Kept as an escape hatch.
   */
  toolBridgeMode: ToolBridgeMode;
  /** Hold mode only: how long (ms) a held run may wait for the client's tool result before it's torn down, freeing the agent + concurrency slot. */
  toolResultTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  logLevel: LogLevel;
  logPretty: boolean;
  /** Automatically opens the admin dashboard in the default browser on startup - interactive (TTY) starts only; unattended launches (autostart/systemd/launchd/Docker) never spawn a browser regardless. Set to false to disable even for interactive starts. */
  autoOpenBrowser: boolean;
  /** When false (default), the /api/admin/* endpoints only accept requests from loopback addresses, regardless of AUTH_KEY. */
  adminAllowRemote: boolean;
  /**
   * Max JSON request body size in megabytes (default 25, in line with major
   * provider APIs - e.g. Anthropic caps requests at 32 MB). Oversized bodies
   * get a proper HTTP 413, which vision-heavy clients like Hermes use as the
   * signal to compress their history and continue. Deliberately bounded:
   * the body is buffered (and parsed) in RAM, so an unbounded limit would
   * let a single request OOM a LAN-exposed gateway.
   */
  jsonBodyLimitMb: number;
}

function resolveDefaultWorkdirRoot(): string {
  return path.join(process.cwd(), ".cursor-gateway", "workspaces");
}

export function validateKeyMode(raw: string): CursorKeyMode {
  if (raw === "server" || raw === "passthrough") return raw;
  throw new ConfigError(`CURSOR_KEY_MODE must be "server" or "passthrough", got "${raw}"`);
}

export function validateRuntime(raw: string): CursorRuntimeKind {
  if (raw === "local" || raw === "cloud") return raw;
  throw new ConfigError(`CURSOR_RUNTIME must be "local" or "cloud", got "${raw}"`);
}

export function validateAgentMode(raw: string): CursorAgentModeOption {
  if (raw === "agent" || raw === "plan") return raw;
  throw new ConfigError(`CURSOR_AGENT_MODE must be "agent" or "plan", got "${raw}"`);
}

export function validateToolBridgeMode(raw: string): ToolBridgeMode {
  if (raw === "hold" || raw === "cancel") return raw;
  throw new ConfigError(`TOOL_BRIDGE_MODE must be "hold" or "cancel", got "${raw}"`);
}

export const LOG_LEVELS: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export function validateLogLevel(raw: string): LogLevel {
  if ((LOG_LEVELS as string[]).includes(raw)) return raw as LogLevel;
  throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${raw}"`);
}

/**
 * True once the gateway has enough configuration to actually serve requests:
 * either a server-side Cursor API key is set, or the gateway is in
 * `passthrough` mode (where each client supplies its own key). When false,
 * the admin UI shows the first-run setup wizard instead of the dashboard.
 */
export function isSetupComplete(config: Pick<AppConfig, "cursorKeyMode" | "cursorApiKey">): boolean {
  return config.cursorKeyMode === "passthrough" || Boolean(config.cursorApiKey && config.cursorApiKey.length > 0);
}

/**
 * Loads configuration from environment variables (`.env` / process env).
 * Unlike earlier versions of this gateway, a missing `CURSOR_API_KEY` no
 * longer crashes the process - it boots successfully with
 * `isSetupComplete(config) === false`, and the admin web UI (or `PATCH
 * /api/admin/config`) is expected to supply it. This is what makes the
 * zero-config "open the browser and paste your key" first-run flow possible.
 * Everything else is still validated strictly.
 */
export function loadConfig(): AppConfig {
  const cursorKeyMode = validateKeyMode(optionalString("CURSOR_KEY_MODE", "server"));
  const cursorApiKeyRaw = process.env["CURSOR_API_KEY"]?.trim();

  const cursorWorkdirRoot = optionalString("CURSOR_WORKDIR", resolveDefaultWorkdirRoot());
  fs.mkdirSync(cursorWorkdirRoot, { recursive: true });

  const config: AppConfig = {
    cursorApiKey: cursorApiKeyRaw && cursorApiKeyRaw.length > 0 ? cursorApiKeyRaw : undefined,
    cursorKeyMode,
    port: optionalInt("PORT", 8787),
    host: optionalString("HOST", "0.0.0.0"),
    nodeEnv: optionalString("NODE_ENV", "production"),
    authKey: process.env["AUTH_KEY"]?.trim() || undefined,
    corsOrigin: optionalString("CORS_ORIGIN", "*"),
    cursorRuntime: validateRuntime(optionalString("CURSOR_RUNTIME", "local")),
    cursorWorkdirRoot,
    cursorAgentMode: validateAgentMode(optionalString("CURSOR_AGENT_MODE", "agent")),
    defaultModel: requireString("DEFAULT_MODEL", "composer-2.5"),
    includeThinking: optionalBool("CURSOR_INCLUDE_THINKING", true),
    sessionsEnabled: optionalBool("CURSOR_ENABLE_SESSIONS", true),
    autoSessionEnabled: optionalBool("CURSOR_AUTO_SESSION", true),
    sessionTtlMs: optionalInt("SESSION_TTL_MS", 1_800_000),
    maxCachedAgents: optionalInt("MAX_CACHED_AGENTS", 50),
    maxConcurrentRuns: optionalInt("MAX_CONCURRENT_RUNS", 8),
    requestTimeoutMs: optionalInt("REQUEST_TIMEOUT_MS", 300_000),
    toolBridgeEnabled: optionalBool("ENABLE_TOOL_BRIDGE", true),
    toolBridgeMode: validateToolBridgeMode(optionalString("TOOL_BRIDGE_MODE", "hold")),
    toolResultTimeoutMs: optionalInt("TOOL_RESULT_TIMEOUT_MS", 900_000),
    rateLimitWindowMs: optionalInt("RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMax: optionalInt("RATE_LIMIT_MAX", 120),
    logLevel: validateLogLevel(optionalString("LOG_LEVEL", "info")),
    logPretty: optionalBool("LOG_PRETTY", false),
    autoOpenBrowser: optionalBool("AUTO_OPEN_BROWSER", true),
    adminAllowRemote: optionalBool("ADMIN_ALLOW_REMOTE", false),
    jsonBodyLimitMb: optionalInt("JSON_BODY_LIMIT_MB", 25),
  };

  if (config.maxCachedAgents < 1) {
    throw new ConfigError("MAX_CACHED_AGENTS must be at least 1");
  }
  if (config.maxConcurrentRuns < 1) {
    throw new ConfigError("MAX_CONCURRENT_RUNS must be at least 1");
  }
  if (config.jsonBodyLimitMb < 1 || config.jsonBodyLimitMb > 1024) {
    throw new ConfigError("JSON_BODY_LIMIT_MB must be between 1 and 1024");
  }

  return config;
}
