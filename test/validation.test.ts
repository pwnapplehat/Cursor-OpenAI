import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChatCompletionRequest, validateCompletionRequest } from "../src/validation";
import { HttpError } from "../src/errors";

test("validateChatCompletionRequest accepts a minimal valid request", () => {
  const req = validateChatCompletionRequest({ model: "composer-2.5", messages: [{ role: "user", content: "hi" }] });
  assert.equal(req.model, "composer-2.5");
  assert.equal(req.messages.length, 1);
});

test("validateChatCompletionRequest rejects a missing model", () => {
  assert.throws(() => validateChatCompletionRequest({ messages: [{ role: "user", content: "hi" }] }), HttpError);
});

test("validateChatCompletionRequest rejects an empty messages array", () => {
  assert.throws(() => validateChatCompletionRequest({ model: "auto", messages: [] }), HttpError);
});

test("validateChatCompletionRequest rejects a message with an invalid role", () => {
  assert.throws(
    () => validateChatCompletionRequest({ model: "auto", messages: [{ role: "narrator", content: "hi" }] }),
    HttpError,
  );
});

test("validateChatCompletionRequest accepts the developer role (OpenAI system-role successor sent for GPT-5-family models)", () => {
  const req = validateChatCompletionRequest({
    model: "gpt-5.4-mini",
    messages: [
      { role: "developer", content: "You are a helpful agent." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(req.messages[0]!.role, "developer");
});

test("validateChatCompletionRequest allows null content on assistant/tool messages", () => {
  const req = validateChatCompletionRequest({
    model: "auto",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ],
  });
  assert.equal(req.messages[1]!.content, null);
});

test("validateChatCompletionRequest passes through optional fields when present", () => {
  const req = validateChatCompletionRequest({
    model: "auto",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    temperature: 0.5,
    metadata: { session_id: "abc" },
    tools: [{ type: "function", function: { name: "f" } }],
  });
  assert.equal(req.stream, true);
  assert.equal(req.temperature, 0.5);
  assert.equal(req.metadata?.["session_id"], "abc");
  assert.equal(req.tools?.length, 1);
});

test("validateCompletionRequest accepts a string prompt", () => {
  const req = validateCompletionRequest({ model: "auto", prompt: "once upon a time" });
  assert.equal(req.prompt, "once upon a time");
});

test("validateCompletionRequest rejects a missing prompt", () => {
  assert.throws(() => validateCompletionRequest({ model: "auto" }), HttpError);
});
