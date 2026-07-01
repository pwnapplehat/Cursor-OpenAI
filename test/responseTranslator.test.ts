import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatCompletionResponse, buildFinalChunk, buildToolCalls, toOpenAIFinishReason } from "../src/translate/responseTranslator";
import type { RunOutcome } from "../src/cursor/runController";

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

test("toOpenAIFinishReason maps tool_calls through and everything else to stop", () => {
  assert.equal(toOpenAIFinishReason("tool_calls"), "tool_calls");
  assert.equal(toOpenAIFinishReason("stop"), "stop");
  assert.equal(toOpenAIFinishReason("cancelled"), "stop");
});

test("buildToolCalls returns undefined when there is no captured tool call", () => {
  assert.equal(buildToolCalls(makeOutcome()), undefined);
});

test("buildToolCalls converts a captured tool call into OpenAI's tool_calls shape", () => {
  const outcome = makeOutcome({
    toolCall: { id: "call_abc", name: "get_weather", argumentsJson: '{"city":"NYC"}' },
    finishReason: "tool_calls",
  });
  const calls = buildToolCalls(outcome);
  assert.deepEqual(calls, [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }]);
});

test("buildChatCompletionResponse produces a well-formed non-streaming response", () => {
  const response = buildChatCompletionResponse({
    id: "chatcmpl-test",
    outcome: makeOutcome(),
    requestedModel: "gpt-4o",
    promptTextForEstimate: "hi",
    includeReasoning: true,
  });
  assert.equal(response.object, "chat.completion");
  assert.equal(response.model, "composer-2.5");
  assert.equal(response.choices.length, 1);
  assert.equal(response.choices[0]!.message.content, "Hello!");
  assert.equal(response.choices[0]!.finish_reason, "stop");
  assert.equal(response.cursor_agent_id, "agent-123");
  assert.ok(response.usage);
});

test("buildChatCompletionResponse sets content to null when a tool call is present and there is no text", () => {
  const outcome = makeOutcome({
    content: "",
    toolCall: { id: "call_1", name: "foo", argumentsJson: "{}" },
    finishReason: "tool_calls",
  });
  const response = buildChatCompletionResponse({
    id: "chatcmpl-test",
    outcome,
    requestedModel: "gpt-4o",
    promptTextForEstimate: "hi",
    includeReasoning: false,
  });
  assert.equal(response.choices[0]!.message.content, null);
  assert.ok(response.choices[0]!.message.tool_calls);
  assert.equal(response.choices[0]!.finish_reason, "tool_calls");
});

test("buildChatCompletionResponse omits reasoning_content when includeReasoning is false", () => {
  const outcome = makeOutcome({ reasoningContent: "I am thinking..." });
  const response = buildChatCompletionResponse({
    id: "chatcmpl-test",
    outcome,
    requestedModel: "gpt-4o",
    promptTextForEstimate: "hi",
    includeReasoning: false,
  });
  assert.equal(response.choices[0]!.message.reasoning_content, undefined);
});

test("buildFinalChunk only includes usage when requested", () => {
  const outcome = makeOutcome();
  const withUsage = buildFinalChunk("id", 1, "composer-2.5", outcome, true, "hi");
  const withoutUsage = buildFinalChunk("id", 1, "composer-2.5", outcome, false, "hi");
  assert.ok(withUsage.usage);
  assert.equal(withoutUsage.usage, undefined);
  assert.equal(withUsage.choices[0]!.finish_reason, "stop");
});
