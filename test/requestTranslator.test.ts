import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSystemPrompt, prepareTurn, stringifyContent, extractImages } from "../src/translate/requestTranslator";
import type { ChatCompletionMessage } from "../src/types/openai";

test("extractSystemPrompt pulls out and concatenates system messages", () => {
  const { systemPrompt, rest } = extractSystemPrompt([
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hi" },
    { role: "system", content: "Never use emoji." },
  ]);
  assert.equal(systemPrompt, "Be concise.\n\nNever use emoji.");
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.role, "user");
});

test("extractSystemPrompt returns undefined system prompt when there are no system messages", () => {
  const { systemPrompt, rest } = extractSystemPrompt([{ role: "user", content: "Hi" }]);
  assert.equal(systemPrompt, undefined);
  assert.equal(rest.length, 1);
});

test("extractSystemPrompt folds developer messages into the system block (OpenAI reasoning-model alias)", () => {
  const { systemPrompt, rest } = extractSystemPrompt([
    { role: "developer", content: "You are a helpful agent." },
    { role: "user", content: "Hi" },
    { role: "system", content: "Never use emoji." },
  ]);
  assert.equal(systemPrompt, "You are a helpful agent.\n\nNever use emoji.");
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.role, "user");
});

test("stringifyContent handles string, array-of-parts, and null content", () => {
  assert.equal(stringifyContent("hello"), "hello");
  assert.equal(stringifyContent(null), "");
  assert.equal(
    stringifyContent([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "https://example.com/x.png" } },
      { type: "text", text: "b" },
    ]),
    "a\n[image attached]\nb",
  );
});

test("extractImages pulls image_url parts, decoding base64 data URLs", () => {
  const images = extractImages([
    { type: "text", text: "look at this" },
    { type: "image_url", image_url: { url: "https://example.com/x.png" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
  assert.equal(images.length, 2);
  assert.deepEqual(images[0], { url: "https://example.com/x.png" });
  assert.deepEqual(images[1], { data: "QUJD", mimeType: "image/png" });
});

test("prepareTurn sends a single new user message close to verbatim on a warm agent", () => {
  const newMessages: ChatCompletionMessage[] = [{ role: "user", content: "second" }];
  const result = prepareTurn({ newMessages, isFirstTurn: false, systemPrompt: undefined });
  assert.equal(result.text, "second");
});

test("prepareTurn prepends the system prompt only for a brand-new agent", () => {
  const newMessages: ChatCompletionMessage[] = [{ role: "user", content: "hi" }];
  const result = prepareTurn({ newMessages, isFirstTurn: true, systemPrompt: "Be terse." });
  assert.equal(result.text, "[System instructions]\nBe terse.\n\nhi");
});

test("prepareTurn folds full history into one turn with framing when it contains an assistant turn (cold agent hydration)", () => {
  const newMessages: ChatCompletionMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ];
  const result = prepareTurn({ newMessages, isFirstTurn: true, systemPrompt: undefined });
  assert.match(result.text, /--- Conversation history ---/);
  assert.match(result.text, /User: first/);
  assert.match(result.text, /Assistant: reply/);
  assert.match(result.text, /User: second/);
  assert.match(result.text, /--- End of history ---/);
});

test("prepareTurn folds multiple new trailing messages (e.g. a tool result then a new user turn) without history framing, since none of it is already-answered", () => {
  const newMessages: ChatCompletionMessage[] = [
    { role: "tool", content: "42", tool_call_id: "call_1" },
    { role: "user", content: "thanks, now what" },
  ];
  const result = prepareTurn({ newMessages, isFirstTurn: false, systemPrompt: undefined });
  assert.doesNotMatch(result.text, /--- Conversation history ---/);
  assert.match(result.text, /Tool result \(for call call_1\): 42/);
  assert.match(result.text, /User: thanks, now what/);
});
