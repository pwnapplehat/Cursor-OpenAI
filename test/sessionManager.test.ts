import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { Agent } from "@cursor/sdk";
import type { SDKAgent } from "@cursor/sdk";
import { SessionManager } from "../src/cursor/sessionManager";
import type { AppConfig } from "../src/config";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    cursorApiKey: "test-key",
    cursorKeyMode: "server",
    port: 0,
    host: "127.0.0.1",
    nodeEnv: "test",
    authKey: undefined,
    corsOrigin: "*",
    cursorRuntime: "local",
    cursorWorkdirRoot: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-gw-test-")),
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
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    logLevel: "silent",
    logPretty: false,
    ...overrides,
  };
}

function makeFakeAgent(id: string): SDKAgent {
  return {
    agentId: id,
    model: undefined,
    send: () => Promise.reject(new Error("not used in this test")),
    close: () => {},
    reload: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
    listArtifacts: () => Promise.resolve([]),
    downloadArtifact: () => Promise.resolve(Buffer.from("")),
  };
}

const silentLog = pino({ level: "silent" });

test("SessionManager keeps an explicit session_id's cache entry under the same key across turns (regression test for a re-keying bug)", async (t) => {
  let createCount = 0;
  const originalCreate = Agent.create;
  Agent.create = (() => {
    createCount += 1;
    return Promise.resolve(makeFakeAgent(`agent-${createCount}`));
  }) as typeof Agent.create;
  t.after(() => {
    Agent.create = originalCreate;
  });

  const manager = new SessionManager(makeConfig(), silentLog);
  t.after(() => manager.shutdown());

  const metadata = { session_id: "abc-123" };
  const model = { id: "composer-2.5" };

  const handle1 = await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "hi" }], metadata });
  assert.equal(createCount, 1);
  manager.remember({
    apiKey: "k",
    model,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    handle: handle1,
  });

  const handle2 = await manager.resolve({
    apiKey: "k",
    model,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "more" },
    ],
    metadata,
  });

  assert.equal(createCount, 1, "should reuse the same agent for the same explicit session_id, not create a second one");
  assert.equal(handle2.agent.agentId, handle1.agent.agentId);
  assert.deepEqual(handle2.newMessages, [{ role: "user", content: "more" }], "should send only the new trailing message, not replay history");
});

test("SessionManager treats an explicit session_id's messages as all-new when the client sends only deltas (not full history)", async (t) => {
  let createCount = 0;
  const originalCreate = Agent.create;
  Agent.create = (() => {
    createCount += 1;
    return Promise.resolve(makeFakeAgent(`agent-${createCount}`));
  }) as typeof Agent.create;
  t.after(() => {
    Agent.create = originalCreate;
  });

  const manager = new SessionManager(makeConfig(), silentLog);
  t.after(() => manager.shutdown());
  const metadata = { session_id: "delta-client-1" };
  const model = { id: "composer-2.5" };

  const handle1 = await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "remember pineapple" }], metadata });
  manager.remember({
    apiKey: "k",
    model,
    messages: [
      { role: "user", content: "remember pineapple" },
      { role: "assistant", content: "ok" },
    ],
    handle: handle1,
  });

  // This client only sends the new message each turn, not full history.
  const handle2 = await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "what was the word?" }], metadata });

  assert.equal(createCount, 1, "should still reuse the same agent");
  assert.equal(handle2.agent.agentId, handle1.agent.agentId);
  assert.deepEqual(handle2.newMessages, [{ role: "user", content: "what was the word?" }]);
});

test("SessionManager auto-session reuses a cached agent when a new request's prefix matches a prior conversation", async (t) => {
  let createCount = 0;
  const originalCreate = Agent.create;
  Agent.create = (() => {
    createCount += 1;
    return Promise.resolve(makeFakeAgent(`agent-${createCount}`));
  }) as typeof Agent.create;
  t.after(() => {
    Agent.create = originalCreate;
  });

  const manager = new SessionManager(makeConfig(), silentLog);
  t.after(() => manager.shutdown());
  const model = { id: "composer-2.5" };

  const turn1Messages = [{ role: "user" as const, content: "hi" }];
  const handle1 = await manager.resolve({ apiKey: "k", model, messages: turn1Messages, metadata: undefined });
  assert.equal(createCount, 1);

  const turn1WithReply = [...turn1Messages, { role: "assistant" as const, content: "hello" }];
  manager.remember({ apiKey: "k", model, messages: turn1WithReply, handle: handle1 });

  const handle2 = await manager.resolve({
    apiKey: "k",
    model,
    messages: [...turn1WithReply, { role: "user", content: "more" }],
    metadata: undefined,
  });

  assert.equal(createCount, 1, "auto-session should recognize the matching prefix and reuse the same agent");
  assert.equal(handle2.agent.agentId, handle1.agent.agentId);
});

test("SessionManager creates a fresh agent when no session id matches and there is no cached prefix", async (t) => {
  let createCount = 0;
  const originalCreate = Agent.create;
  Agent.create = (() => {
    createCount += 1;
    return Promise.resolve(makeFakeAgent(`agent-${createCount}`));
  }) as typeof Agent.create;
  t.after(() => {
    Agent.create = originalCreate;
  });

  const manager = new SessionManager(makeConfig(), silentLog);
  t.after(() => manager.shutdown());
  const model = { id: "composer-2.5" };

  const handle1 = await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "hi" }], metadata: undefined });
  const handle2 = await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "unrelated" }], metadata: undefined });

  assert.equal(createCount, 2);
  assert.notEqual(handle1.agent.agentId, handle2.agent.agentId);
});
