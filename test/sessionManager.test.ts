import { test } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { Agent } from "@cursor/sdk";
import type { SDKAgent } from "@cursor/sdk";
import { SessionManager } from "../src/cursor/sessionManager";
import { makeTestConfig as makeConfig } from "./helpers/testConfig";

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

test("SessionManager.listSessions returns display-safe metadata for every cached session, newest-used first", async (t) => {
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

  await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "first" }], metadata: { session_id: "s1" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "second" }], metadata: { session_id: "s2" } });

  const sessions = manager.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]!.type, "explicit");
  assert.equal(sessions[0]!.agentId, "agent-2", "most recently used (s2) should be listed first");
  assert.equal(sessions[1]!.agentId, "agent-1");
  assert.equal(sessions[0]!.messageCount, 0, "messageCount reflects lastMessages, which is only populated by remember()");
});

test("SessionManager.evict removes a specific session by id and disposes its agent", async (t) => {
  const originalCreate = Agent.create;
  const closedAgentIds: string[] = [];
  Agent.create = (() =>
    Promise.resolve({
      ...makeFakeAgent("agent-evict-me"),
      close: () => {
        closedAgentIds.push("agent-evict-me");
      },
    })) as typeof Agent.create;
  t.after(() => {
    Agent.create = originalCreate;
  });

  const manager = new SessionManager(makeConfig(), silentLog);
  t.after(() => manager.shutdown());
  const model = { id: "composer-2.5" };

  await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "hi" }], metadata: { session_id: "to-evict" } });
  const [session] = manager.listSessions();
  assert.ok(session);

  const evicted = manager.evict(session.id);
  assert.equal(evicted, true);
  assert.deepEqual(closedAgentIds, ["agent-evict-me"]);
  assert.equal(manager.listSessions().length, 0);
});

test("SessionManager.evict returns false for an unknown id", () => {
  const manager = new SessionManager(makeConfig(), silentLog);
  assert.equal(manager.evict("does-not-exist"), false);
  manager.shutdown();
});

test("SessionManager.evictAll clears every cached session and reports how many were removed", async (t) => {
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

  await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "a" }], metadata: { session_id: "s1" } });
  await manager.resolve({ apiKey: "k", model, messages: [{ role: "user", content: "b" }], metadata: { session_id: "s2" } });

  const removed = manager.evictAll();
  assert.equal(removed, 2);
  assert.equal(manager.listSessions().length, 0);
});
