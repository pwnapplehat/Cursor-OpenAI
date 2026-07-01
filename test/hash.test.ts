import { test } from "node:test";
import assert from "node:assert/strict";
import { hashMessages } from "../src/utils/hash";
import type { ChatCompletionMessage } from "../src/types/openai";

const base: ChatCompletionMessage[] = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi there!" },
];

test("hashMessages is stable for identical input", () => {
  const a = hashMessages("composer-2.5", base);
  const b = hashMessages("composer-2.5", [...base]);
  assert.equal(a, b);
});

test("hashMessages changes when the model changes", () => {
  const a = hashMessages("composer-2.5", base);
  const b = hashMessages("auto", base);
  assert.notEqual(a, b);
});

test("hashMessages changes when message content changes", () => {
  const a = hashMessages("composer-2.5", base);
  const changed: ChatCompletionMessage[] = [{ role: "user", content: "Hello!" }, base[1]!];
  const b = hashMessages("composer-2.5", changed);
  assert.notEqual(a, b);
});

test("hashMessages changes when a message is appended", () => {
  const a = hashMessages("composer-2.5", base);
  const extended = [...base, { role: "user", content: "Follow up" } as ChatCompletionMessage];
  const b = hashMessages("composer-2.5", extended);
  assert.notEqual(a, b);
});

test("hashMessages is order-sensitive", () => {
  const reversed = [...base].reverse();
  const a = hashMessages("composer-2.5", base);
  const b = hashMessages("composer-2.5", reversed);
  assert.notEqual(a, b);
});
