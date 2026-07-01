import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAIUsage } from "../src/translate/usage";

test("toOpenAIUsage maps real Cursor TokenUsage onto OpenAI's shape", () => {
  const usage = toOpenAIUsage(
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 15, reasoningTokens: 3 },
    "prompt",
    "completion",
  );
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 15);
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 2 });
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 3 });
});

test("toOpenAIUsage omits detail fields that are zero/undefined", () => {
  const usage = toOpenAIUsage(
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
    "prompt",
    "completion",
  );
  assert.equal(usage.prompt_tokens_details, undefined);
  assert.equal(usage.completion_tokens_details, undefined);
});

test("toOpenAIUsage falls back to a character-based estimate when Cursor reports no usage", () => {
  const usage = toOpenAIUsage(undefined, "a".repeat(40), "b".repeat(20));
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 15);
});
