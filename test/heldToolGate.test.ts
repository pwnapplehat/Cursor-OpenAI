import { test } from "node:test";
import assert from "node:assert/strict";
import { HeldToolGate } from "../src/cursor/heldToolGate";
import type { ChatCompletionTool } from "../src/types/openai";

const weatherTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

test("buildCustomTools returns undefined when there are no function tools", () => {
  const gate = new HeldToolGate();
  assert.equal(gate.buildCustomTools(undefined), undefined);
  assert.equal(gate.buildCustomTools([]), undefined);
});

test("a parked execute() surfaces via waitForBatch and resolves when its result is provided", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;

  // Fire the tool callback as the SDK would; it should stay pending until we answer.
  const executePromise = tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "call_1" });

  const batch = await gate.waitForBatch(5);
  assert.equal(batch.length, 1);
  assert.equal(batch[0]!.id, "call_1");
  assert.equal(batch[0]!.name, "get_weather");
  assert.deepEqual(JSON.parse(batch[0]!.argumentsJson), { city: "Paris" });

  assert.deepEqual(gate.pendingIds, ["call_1"]);

  const matched = gate.provideResults([{ id: "call_1", content: "18C, sunny" }]);
  assert.equal(matched, 1);

  const result = await executePromise;
  assert.deepEqual(result, { content: [{ type: "text", text: "18C, sunny" }] });
  assert.equal(gate.hasPending(), false);
});

test("waitForBatch collects concurrently-dispatched parallel calls into one batch", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;

  // Three parallel calls, dispatched back-to-back like the SDK does.
  void tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "c1" });
  void tools["get_weather"]!.execute({ city: "London" }, { toolCallId: "c2" });
  void tools["get_weather"]!.execute({ city: "Tokyo" }, { toolCallId: "c3" });

  const batch = await gate.waitForBatch(20);
  assert.deepEqual(
    batch.map((c) => c.id).sort(),
    ["c1", "c2", "c3"],
  );
});

test("provideResults forwards base64 images as SDK image blocks alongside the text", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;
  const executePromise = tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "call_img" });
  await gate.waitForBatch(5);

  gate.provideResults([
    {
      id: "call_img",
      content: "screenshot captured",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    },
  ]);

  const result = await executePromise;
  assert.deepEqual(result, {
    content: [
      { type: "text", text: "screenshot captured" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  });
});

test("provideResults with an image-only result emits just the image block (no empty text)", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;
  const executePromise = tools["get_weather"]!.execute({}, { toolCallId: "call_img2" });
  await gate.waitForBatch(5);

  gate.provideResults([
    { id: "call_img2", content: "", images: [{ data: "QUJD", mimeType: "image/jpeg" }] },
  ]);

  const result = await executePromise;
  assert.deepEqual(result, {
    content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }],
  });
});

test("provideResults references URL images in a text block instead of dropping them", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;
  const executePromise = tools["get_weather"]!.execute({}, { toolCallId: "call_url" });
  await gate.waitForBatch(5);

  gate.provideResults([
    { id: "call_url", content: "see image", images: [{ url: "https://example.com/shot.png" }] },
  ]);

  const result = await executePromise;
  assert.deepEqual(result, {
    content: [
      { type: "text", text: "see image" },
      { type: "text", text: "[image: https://example.com/shot.png]" },
    ],
  });
});

test("provideResults only resolves matching ids and reports the matched count", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;
  const p1 = tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "c1" });
  await gate.waitForBatch(5);

  const matched = gate.provideResults([
    { id: "c1", content: "ok" },
    { id: "does-not-exist", content: "ignored" },
  ]);
  assert.equal(matched, 1);
  await p1; // resolves
});

test("close() frees still-parked callbacks with the abandoned marker and makes future parks resolve immediately", async () => {
  const gate = new HeldToolGate();
  const tools = gate.buildCustomTools([weatherTool])!;
  const parked = tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "c1" });
  await gate.waitForBatch(5);

  gate.close();
  const result = await parked;
  assert.deepEqual(result, { content: [{ type: "text", text: HeldToolGate.ABANDONED_RESULT }] });

  // After close, a late execute() (e.g. a straggling parallel call) must not hang.
  const late = await tools["get_weather"]!.execute({ city: "London" }, { toolCallId: "c2" });
  assert.deepEqual(late, { content: [{ type: "text", text: HeldToolGate.ABANDONED_RESULT }] });
});

test("waitForBatch resolves with an empty batch if the gate closes before any call parks", async () => {
  const gate = new HeldToolGate();
  const batchPromise = gate.waitForBatch(5);
  gate.close();
  assert.deepEqual(await batchPromise, []);
});
