import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../../src/config";

/** Builds a fully-populated `AppConfig` for tests, with sane defaults and a fresh, uniquely-named scratch data dir per call (isolating any ConfigStore settings.json writes too - see ConfigStore's constructor). */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-gw-test-"));
  const workdirRoot = path.join(dataDir, "workspaces");
  fs.mkdirSync(workdirRoot, { recursive: true });
  return {
    cursorApiKey: "test-key",
    cursorKeyMode: "server",
    port: 0,
    host: "127.0.0.1",
    nodeEnv: "test",
    authKey: undefined,
    corsOrigin: "*",
    cursorRuntime: "local",
    cursorWorkdirRoot: workdirRoot,
    cursorAgentMode: "agent",
    defaultModel: "composer-2.5",
    includeThinking: true,
    sessionsEnabled: true,
    autoSessionEnabled: true,
    sessionTtlMs: 1_800_000,
    maxCachedAgents: 50,
    maxConcurrentRuns: 8,
    requestTimeoutMs: 300_000,
    toolBridgeEnabled: true,
    toolBridgeMode: "hold",
    toolResultTimeoutMs: 900_000,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    logLevel: "silent",
    logPretty: false,
    autoOpenBrowser: false,
    adminAllowRemote: false,
    jsonBodyLimitMb: 25,
    ...overrides,
  };
}
