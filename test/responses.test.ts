import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import pino from "pino";
import {
  assistantMessageFromOutcome,
  buildResponsesObject,
  outcomeToOutputItems,
  responsesInputToMessages,
  responsesToolsToChatTools,
} from "../src/translate/responsesTranslator";
import { ResponseStore, type StoredResponse } from "../src/cursor/responseStore";
import { ConfigStore } from "../src/configStore";
import { buildApp } from "../src/server";
import { makeTestConfig } from "./helpers/testConfig";
import type { RunOutcome } from "../src/cursor/runController";
import type { ResponsesFunctionCallItem } from "../src/types/openai";

function makeStored(overrides: Partial<StoredResponse> & Pick<StoredResponse, "id">): StoredResponse {
  const now = Date.now();
  return {
    apiKey: "key-a",
    createdAt: now,
    lastUsedAt: now,
    sessionId: overrides.id,
    messages: [{ role: "user", content: "hi" }],
    response: {
      id: overrides.id,
      object: "response",
      created_at: 1,
      status: "completed",
      model: "composer-2.5",
      output: [],
    },
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    content: "Hello!",
    reasoningContent: "",
    finishReason: "stop",
    toolCall: undefined,
    usage: undefined,
    agentId: "agent-123",
    runId: "run-456",
    model: { id: "composer-2.5" },
    ...overrides,
  };
}

test("responsesInputToMessages converts a string input into a user message", () => {
  const messages = responsesInputToMessages({ input: "Hello" });
  assert.deepEqual(messages, [{ role: "user", content: "Hello" }]);
});

test("responsesInputToMessages prepends instructions as a system message", () => {
  const messages = responsesInputToMessages({ input: "Hi", instructions: "Be brief." });
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "Be brief.");
  assert.equal(messages[1]?.role, "user");
});

test("responsesInputToMessages maps function_call_output onto a tool message", () => {
  const messages = responsesInputToMessages({
    input: [{ type: "function_call_output", call_id: "call_1", output: "18C" }],
  });
  assert.deepEqual(messages, [{ role: "tool", tool_call_id: "call_1", content: "18C" }]);
});

test("responsesInputToMessages appends new input onto previous_response_id history and replaces instructions", () => {
  const messages = responsesInputToMessages({
    input: "follow up",
    instructions: "new instructions",
    priorMessages: [
      { role: "system", content: "old instructions" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ack" },
    ],
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(messages[0]?.content, "new instructions");
  assert.equal(messages[3]?.content, "follow up");
});

test("responsesToolsToChatTools accepts both Responses and Chat Completions function shapes", () => {
  const tools = responsesToolsToChatTools([
    { type: "function", name: "get_weather", description: "weather", parameters: { type: "object" } },
    { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
  ]);
  assert.equal(tools?.length, 2);
  assert.equal(tools?.[0]?.function.name, "get_weather");
  assert.equal(tools?.[1]?.function.name, "lookup");
});

test("buildResponsesObject produces a well-formed non-streaming Responses payload", () => {
  const response = buildResponsesObject({
    id: "resp_abc",
    createdAt: 1_700_000_000,
    requestedModel: "composer-2.5",
    outcome: makeOutcome(),
    promptTextForEstimate: "Hello",
  });
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.model, "composer-2.5");
  assert.equal(response.output[0]?.type, "message");
  if (response.output[0]?.type === "message") {
    assert.equal(response.output[0].content[0]?.text, "Hello!");
  }
  assert.equal(response.cursor_agent_id, "agent-123");
  assert.ok(response.usage);
});

test("outcomeToOutputItems emits function_call items for tool_calls turns", () => {
  const items = outcomeToOutputItems(
    makeOutcome({
      content: "",
      finishReason: "tool_calls",
      toolCall: { id: "call_abc", name: "get_weather", argumentsJson: '{"city":"NYC"}' },
    }),
  );
  const fn = items.find((i) => i.type === "function_call");
  assert.ok(fn);
  if (fn?.type === "function_call") {
    assert.equal(fn.call_id, "call_abc");
    assert.equal(fn.name, "get_weather");
    assert.equal(fn.arguments, '{"city":"NYC"}');
  }
});

test("outcomeToOutputItems reuses streamed item ids in the completed payload", () => {
  const streamedFc: ResponsesFunctionCallItem = {
    type: "function_call",
    id: "fc_streamed",
    call_id: "call_abc",
    name: "get_weather",
    arguments: '{"city":"NYC"}',
    status: "completed",
  };
  const response = buildResponsesObject({
    id: "resp_abc",
    createdAt: 1,
    requestedModel: "composer-2.5",
    outcome: makeOutcome({
      content: "calling",
      finishReason: "tool_calls",
      toolCall: { id: "call_abc", name: "get_weather", argumentsJson: '{"city":"NYC"}' },
    }),
    promptTextForEstimate: "Hello",
    reuse: { messageId: "msg_streamed", functionCallItems: [streamedFc] },
  });
  const message = response.output.find((item) => item.type === "message");
  const fn = response.output.find((item) => item.type === "function_call");
  assert.equal(message && message.type === "message" ? message.id : undefined, "msg_streamed");
  assert.equal(fn && fn.type === "function_call" ? fn.id : undefined, "fc_streamed");
});

test("assistantMessageFromOutcome preserves tool_calls for session/response storage", () => {
  const message = assistantMessageFromOutcome(
    makeOutcome({
      content: "",
      finishReason: "tool_calls",
      toolCall: { id: "call_abc", name: "get_weather", argumentsJson: "{}" },
    }),
  );
  assert.equal(message.role, "assistant");
  assert.equal(message.tool_calls?.[0]?.id, "call_abc");
});

test("ResponseStore get/put round-trips and expires after sessionTtlMs", () => {
  const config = makeTestConfig({ sessionTtlMs: 50, maxCachedAgents: 2 });
  const store = new ResponseStore(config);
  store.put(makeStored({ id: "resp_1" }));
  assert.equal(store.get("resp_1", "key-a")?.id, "resp_1");
  store.put(
    makeStored({
      id: "resp_old",
      createdAt: Date.now() - 1_000,
      lastUsedAt: Date.now() - 1_000,
      messages: [],
    }),
  );
  assert.equal(store.get("resp_old", "key-a"), undefined, "TTL-expired entries must disappear");
});

test("ResponseStore hides entries from a different API key", () => {
  const store = new ResponseStore(makeTestConfig());
  store.put(makeStored({ id: "resp_secret", apiKey: "owner-key" }));
  assert.equal(store.get("resp_secret", "owner-key")?.id, "resp_secret");
  assert.equal(store.get("resp_secret", "other-key"), undefined, "wrong key must look like a missing id");
});

test("GET /v1/responses/:id is isolated per Cursor API key in passthrough mode", async (t) => {
  const config = makeTestConfig({ cursorKeyMode: "passthrough" });
  const log = pino({ level: "silent" });
  const configStore = new ConfigStore(config, log);
  const { app, sessionManager, heldRunManager, responseStore } = buildApp(configStore, log);
  t.after(() => {
    heldRunManager.shutdown();
    responseStore.shutdown();
    sessionManager.shutdown();
  });

  const server: Server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1");
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", reject);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a TCP address");

  responseStore.put(makeStored({ id: "resp_owned", apiKey: "key-owner" }));

  const owner = await fetch(`http://127.0.0.1:${addr.port}/v1/responses/resp_owned`, {
    headers: { Authorization: "Bearer key-owner" },
  });
  assert.equal(owner.status, 200);
  const ownerBody = (await owner.json()) as { id: string };
  assert.equal(ownerBody.id, "resp_owned");

  const other = await fetch(`http://127.0.0.1:${addr.port}/v1/responses/resp_owned`, {
    headers: { Authorization: "Bearer key-other" },
  });
  assert.equal(other.status, 404);
});
