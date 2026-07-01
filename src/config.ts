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

function requireString(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw !== undefined && raw !== "") return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`Missing required environment variable: ${name}`);
}

function optionalString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ConfigError(`Environment variable ${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`Environment variable ${name} must be a boolean-like value, got "${raw}"`);
}

export type CursorKeyMode = "server" | "passthrough";
export type CursorRuntimeKind = "local" | "cloud";
export type CursorAgentModeOption = "agent" | "plan";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

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
  rateLimitWindowMs: number;
  rateLimitMax: number;
  logLevel: LogLevel;
  logPretty: boolean;
}

function resolveDefaultWorkdirRoot(): string {
  return path.join(process.cwd(), ".cursor-gateway", "workspaces");
}

function validateKeyMode(raw: string): CursorKeyMode {
  if (raw === "server" || raw === "passthrough") return raw;
  throw new ConfigError(`CURSOR_KEY_MODE must be "server" or "passthrough", got "${raw}"`);
}

function validateRuntime(raw: string): CursorRuntimeKind {
  if (raw === "local" || raw === "cloud") return raw;
  throw new ConfigError(`CURSOR_RUNTIME must be "local" or "cloud", got "${raw}"`);
}

function validateAgentMode(raw: string): CursorAgentModeOption {
  if (raw === "agent" || raw === "plan") return raw;
  throw new ConfigError(`CURSOR_AGENT_MODE must be "agent" or "plan", got "${raw}"`);
}

function validateLogLevel(raw: string): LogLevel {
  const allowed: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
  if ((allowed as string[]).includes(raw)) return raw as LogLevel;
  throw new ConfigError(`LOG_LEVEL must be one of ${allowed.join(", ")}, got "${raw}"`);
}

export function loadConfig(): AppConfig {
  const cursorKeyMode = validateKeyMode(optionalString("CURSOR_KEY_MODE", "server"));
  const cursorApiKeyRaw = process.env["CURSOR_API_KEY"]?.trim();

  if (cursorKeyMode === "server" && !cursorApiKeyRaw) {
    throw new ConfigError(
      "CURSOR_API_KEY is required when CURSOR_KEY_MODE=server. Set it in your .env file, or switch " +
        'CURSOR_KEY_MODE to "passthrough" to require clients to supply their own key via the ' +
        "Authorization header on every request.",
    );
  }

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
    rateLimitWindowMs: optionalInt("RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMax: optionalInt("RATE_LIMIT_MAX", 120),
    logLevel: validateLogLevel(optionalString("LOG_LEVEL", "info")),
    logPretty: optionalBool("LOG_PRETTY", false),
  };

  if (config.maxCachedAgents < 1) {
    throw new ConfigError("MAX_CACHED_AGENTS must be at least 1");
  }
  if (config.maxConcurrentRuns < 1) {
    throw new ConfigError("MAX_CONCURRENT_RUNS must be at least 1");
  }

  return config;
}
