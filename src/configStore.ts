import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isSetupComplete, validateAgentMode, validateKeyMode, validateLogLevel, validateRuntime, type AppConfig } from "./config";
import { HttpError } from "./errors";
import type { Logger } from "./logger";

export type RestartRequirement = "none" | "http-rebind";

export interface ConfigUpdateResult {
  restart: RestartRequirement;
}

/** Fields the admin API/UI is allowed to change. Deliberately excludes `cursorWorkdirRoot` and `nodeEnv` - changing an agent working-directory root or the runtime environment mid-process is not something this gateway attempts to support live. */
const EDITABLE_STRING_FIELDS = ["cursorApiKey", "defaultModel", "corsOrigin", "host"] as const;
const EDITABLE_BOOL_FIELDS = [
  "includeThinking",
  "sessionsEnabled",
  "autoSessionEnabled",
  "toolBridgeEnabled",
  "logPretty",
  "autoOpenBrowser",
  "adminAllowRemote",
] as const;
const EDITABLE_INT_FIELDS = [
  "sessionTtlMs",
  "maxCachedAgents",
  "maxConcurrentRuns",
  "requestTimeoutMs",
  "rateLimitWindowMs",
  "rateLimitMax",
  "port",
] as const;

function maskSecretForApi(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Owns the single, shared, mutable `AppConfig` instance for the whole
 * process. Every other module (`SessionManager`, `ModelCatalog`, middleware,
 * routes) is handed a reference to `configStore.config` once at construction
 * and reads its fields live on every request - so mutating those fields here
 * (via `update()`) takes effect immediately, with no restart, for every
 * consumer, without them needing to know a config store exists at all.
 *
 * Persists user-editable overrides (from the setup wizard or admin
 * dashboard) to `<data dir>/settings.json`, layered on top of whatever
 * `loadConfig()` read from the environment at boot. Environment variables
 * remain the right tool for headless/Docker/CI deployments; the persisted
 * overlay is what makes the web UI's changes durable across restarts
 * without needing to rewrite `.env`.
 */
export class ConfigStore {
  readonly config: AppConfig;
  private readonly filePath: string;
  private readonly log: Logger;
  private onPortOrHostChange: ((port: number, host: string) => Promise<void>) | undefined;

  constructor(initial: AppConfig, log: Logger) {
    this.config = initial;
    this.log = log;
    // `cursorWorkdirRoot` is `<data dir>/workspaces`; settings.json lives
    // alongside it. Deriving the path this way (rather than a second
    // independent `process.cwd()`-based computation) means tests that give
    // `cursorWorkdirRoot` a temp directory automatically get an isolated,
    // side-effect-free settings file for free.
    this.filePath = path.join(path.dirname(initial.cursorWorkdirRoot), "settings.json");
    this.applyPersistedOverlay();
  }

  /**
   * Registers a callback invoked after `port`/`host` change via `update()`,
   * so the HTTP listener can be rebound without a process restart. If the
   * callback rejects (e.g. the new port is already in use), `update()`
   * rolls the in-memory `port`/`host` fields back to their previous values
   * and rethrows, so a bad value can never leave the gateway unreachable.
   */
  onServerRebindNeeded(callback: (port: number, host: string) => Promise<void>): void {
    this.onPortOrHostChange = callback;
  }

  get setupComplete(): boolean {
    return isSetupComplete(this.config);
  }

  /** Snapshot safe to serialize in an API response - secrets are masked, never returned in full once set. */
  redactedSnapshot(): Record<string, unknown> {
    const { cursorApiKey, authKey, ...rest } = this.config;
    return {
      ...rest,
      cursorApiKey: maskSecretForApi(cursorApiKey),
      authKey: maskSecretForApi(authKey),
      hasCursorApiKey: Boolean(cursorApiKey),
      hasAuthKey: Boolean(authKey),
      isSetupComplete: this.setupComplete,
    };
  }

  /** Generates and persists a new random admin key, returning the plaintext value once (never retrievable again after this call returns). */
  generateAuthKey(): string {
    const key = `gwk_${randomBytes(24).toString("hex")}`;
    this.applyUpdate({ authKey: key });
    this.persist();
    return key;
  }

  clearAuthKey(): void {
    this.applyUpdate({ authKey: undefined });
    this.persist();
  }

  /**
   * Validates and applies a partial update from the admin API. Throws
   * `HttpError.badRequest` (with the offending field named) on any invalid
   * value - nothing is applied unless the entire input is valid, so a
   * request can't leave the live config half-updated. If the update changes
   * `port`/`host` and rebinding the HTTP listener on the new value fails
   * (e.g. the port is already taken), the change is rolled back and the
   * original error is rethrown - the gateway is never left unreachable by a
   * bad port/host value.
   */
  async update(input: Record<string, unknown>): Promise<ConfigUpdateResult> {
    const patch = this.validate(input);

    const previousPort = this.config.port;
    const previousHost = this.config.host;
    const needsRebind = (patch.port !== undefined && patch.port !== previousPort) || (patch.host !== undefined && patch.host !== previousHost);

    this.applyUpdate(patch);
    const attemptedPort = this.config.port;
    const attemptedHost = this.config.host;

    if (needsRebind && this.onPortOrHostChange) {
      try {
        await this.onPortOrHostChange(attemptedPort, attemptedHost);
      } catch (err) {
        this.applyUpdate({ port: previousPort, host: previousHost });
        throw HttpError.badRequest(
          `Could not bind the server to ${attemptedHost}:${attemptedPort} ` +
            `(${err instanceof Error ? err.message : "unknown error"}). Reverted to the previous ${previousHost}:${previousPort}.`,
          "port",
        );
      }
    }

    this.persist();
    return { restart: needsRebind ? "http-rebind" : "none" };
  }

  private validate(input: Record<string, unknown>): Partial<AppConfig> {
    const patch: Partial<AppConfig> = {};

    for (const field of EDITABLE_STRING_FIELDS) {
      if (!(field in input)) continue;
      const value = input[field];
      if (value === null) {
        if (field === "cursorApiKey") {
          patch.cursorApiKey = undefined;
          continue;
        }
        throw HttpError.badRequest(`"${field}" cannot be cleared`, field);
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        throw HttpError.badRequest(`"${field}" must be a non-empty string`, field);
      }
      patch[field] = value.trim();
    }

    for (const field of EDITABLE_BOOL_FIELDS) {
      if (!(field in input)) continue;
      const value = input[field];
      if (typeof value !== "boolean") {
        throw HttpError.badRequest(`"${field}" must be a boolean`, field);
      }
      patch[field] = value;
    }

    for (const field of EDITABLE_INT_FIELDS) {
      if (!(field in input)) continue;
      const value = input[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw HttpError.badRequest(`"${field}" must be a non-negative integer`, field);
      }
      patch[field] = value;
    }

    if ("cursorKeyMode" in input) {
      const value = input["cursorKeyMode"];
      if (typeof value !== "string") throw HttpError.badRequest('"cursorKeyMode" must be a string', "cursorKeyMode");
      try {
        patch.cursorKeyMode = validateKeyMode(value);
      } catch {
        throw HttpError.badRequest('"cursorKeyMode" must be "server" or "passthrough"', "cursorKeyMode");
      }
    }

    if ("cursorRuntime" in input) {
      const value = input["cursorRuntime"];
      if (typeof value !== "string") throw HttpError.badRequest('"cursorRuntime" must be a string', "cursorRuntime");
      try {
        patch.cursorRuntime = validateRuntime(value);
      } catch {
        throw HttpError.badRequest('"cursorRuntime" must be "local" or "cloud"', "cursorRuntime");
      }
    }

    if ("cursorAgentMode" in input) {
      const value = input["cursorAgentMode"];
      if (typeof value !== "string") throw HttpError.badRequest('"cursorAgentMode" must be a string', "cursorAgentMode");
      try {
        patch.cursorAgentMode = validateAgentMode(value);
      } catch {
        throw HttpError.badRequest('"cursorAgentMode" must be "agent" or "plan"', "cursorAgentMode");
      }
    }

    if ("logLevel" in input) {
      const value = input["logLevel"];
      if (typeof value !== "string") throw HttpError.badRequest('"logLevel" must be a string', "logLevel");
      try {
        patch.logLevel = validateLogLevel(value);
      } catch {
        throw HttpError.badRequest('"logLevel" is not a recognized log level', "logLevel");
      }
    }

    if (patch.maxCachedAgents !== undefined && patch.maxCachedAgents < 1) {
      throw HttpError.badRequest('"maxCachedAgents" must be at least 1', "maxCachedAgents");
    }
    if (patch.maxConcurrentRuns !== undefined && patch.maxConcurrentRuns < 1) {
      throw HttpError.badRequest('"maxConcurrentRuns" must be at least 1', "maxConcurrentRuns");
    }
    if (patch.port !== undefined && (patch.port < 1 || patch.port > 65535)) {
      throw HttpError.badRequest('"port" must be between 1 and 65535', "port");
    }

    return patch;
  }

  private applyUpdate(patch: Partial<AppConfig>): void {
    Object.assign(this.config, patch);
  }

  private applyPersistedOverlay(): void {
    const overlay = this.readOverlayFile();
    if (Object.keys(overlay).length > 0) {
      Object.assign(this.config, overlay);
      this.log.info({ fields: Object.keys(overlay) }, "applied persisted gateway settings overlay");
    }
  }

  private readOverlayFile(): Partial<AppConfig> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Partial<AppConfig>;
    } catch (err) {
      this.log.warn({ err, filePath: this.filePath }, "failed to read persisted gateway settings; starting from environment defaults only");
      return {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), "utf8");
    } catch (err) {
      this.log.error({ err, filePath: this.filePath }, "failed to persist gateway settings to disk - changes will not survive a restart");
    }
  }
}
