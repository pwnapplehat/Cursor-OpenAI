import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBridgedCustomTools, ToolCallCapture } from "../src/cursor/toolBridge";
import type { ChatCompletionTool } from "../src/types/openai";

const weatherTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

test("buildBridgedCustomTools returns undefined when there are no function tools", () => {
  const capture = new ToolCallCapture();
  assert.equal(buildBridgedCustomTools(undefined, capture), undefined);
  assert.equal(buildBridgedCustomTools([], capture), undefined);
});

test("buildBridgedCustomTools registers one SDKCustomTool per declared function, preserving its schema", () => {
  const capture = new ToolCallCapture();
  const tools = buildBridgedCustomTools([weatherTool], capture);
  assert.ok(tools);
  assert.ok(tools["get_weather"]);
  assert.equal(tools["get_weather"]!.description, "Get the weather for a city");
  assert.deepEqual(tools["get_weather"]!.inputSchema, weatherTool.function.parameters);
});

test("ToolCallCapture resolves its wait() promise exactly once with the first captured call", async () => {
  const capture = new ToolCallCapture();
  const tools = buildBridgedCustomTools([weatherTool], capture)!;

  const waitPromise = capture.wait();
  const executeResult = await tools["get_weather"]!.execute({ city: "NYC" }, { toolCallId: "call_1" });

  assert.ok(capture.hasCaptured);
  const call = await waitPromise;
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "get_weather");
  assert.equal(call.argumentsJson, '{"city":"NYC"}');
  assert.ok(typeof executeResult === "object");
});

test("ToolCallCapture ignores a second capture after the first has resolved", async () => {
  const capture = new ToolCallCapture();
  capture.capture({ id: "1", name: "a", argumentsJson: "{}" });
  capture.capture({ id: "2", name: "b", argumentsJson: "{}" });
  const call = await capture.wait();
  assert.equal(call.id, "1");
});

test("buildBridgedCustomTools generates a call id when the SDK does not provide one", async () => {
  const capture = new ToolCallCapture();
  const tools = buildBridgedCustomTools([weatherTool], capture)!;
  await tools["get_weather"]!.execute({ city: "NYC" }, {});
  const call = await capture.wait();
  assert.match(call.id, /^call_/);
});
