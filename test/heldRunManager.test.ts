import { test } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Run, SDKAgent, SDKCustomTool, SDKMessage } from "@cursor/sdk";
import { HeldRunManager, type StartHeldRunParams } from "../src/cursor/heldRunManager";
import { HeldToolGate } from "../src/cursor/heldToolGate";

const silentLog = pino({ level: "silent" });

/**
 * A fake Cursor Run whose stream is driven by invoking the registered custom
 * tools (parking them in the gate) and emitting assistant text, mirroring how
 * the real SDK behaves: execute() callbacks fire concurrently and stay pending
 * until resolved, and the stream ends after the model's final text.
 */
function makeFakeAgent(script: (tools: Record<string, SDKCustomTool>) => AsyncGenerator<SDKMessage, void>): {
  agent: SDKAgent;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const agent = {
    agentId: "agent-fake",
    model: { id: "composer-2.5" },
    async send(_message: unknown, options: { local?: { customTools?: Record<string, SDKCustomTool> } }): Promise<Run> {
      const tools = options.local?.customTools ?? {};
      const gen = script(tools);
      const run = {
        id: "run-fake",
        agentId: "agent-fake",
        model: { id: "composer-2.5" },
        status: "running" as const,
        usage: undefined,
        supports: () => true,
        unsupportedReason: () => undefined,
        stream: () => gen,
        conversation: async () => [],
        wait: async () => ({ id: "run-fake", status: "finished" as const, model: { id: "composer-2.5" } }),
        cancel: async () => {
          cancelled = true;
        },
        onDidChangeStatus: () => () => undefined,
      };
      return run as unknown as Run;
    },
    close: () => undefined,
    reload: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from(""),
    [Symbol.asyncDispose]: async () => undefined,
  } as unknown as SDKAgent;
  return { agent, cancelled: () => cancelled };
}

function assistantMessage(text: string): SDKMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } } as unknown as SDKMessage;
}

function startParams(
  agent: SDKAgent,
  gate: HeldToolGate,
  customTools: Record<string, SDKCustomTool>,
  onRelease: () => void,
  overrides: Partial<StartHeldRunParams> = {},
): StartHeldRunParams {
  return {
    agent,
    apiKey: "key-a",
    message: "go",
    model: { id: "composer-2.5" },
    agentMode: "agent",
    customTools,
    gate,
    includeThinking: true,
    toolResultTimeoutMs: 60_000,
    requestTimeoutMs: 60_000,
    batchSettleMs: 5,
    onRelease,
    sink: undefined,
    log: silentLog,
    abortSignal: undefined,
    ...overrides,
  };
}

const weatherToolDef = [{ type: "function" as const, function: { name: "get_weather", parameters: {} } }];

test("start() returns a tool_calls segment and holds the run; provideResultsAndContinue completes it as one run", async () => {
  const gate = new HeldToolGate();
  let releaseCount = 0;

  // Script: fire the weather tool once, then (after it resolves) emit final text.
  const { agent } = makeFakeAgent((tools) =>
    (async function* () {
      const result = await tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "call_1" });
      yield assistantMessage(`Done: ${JSON.stringify(result)}`);
    })(),
  );

  const manager = new HeldRunManager(silentLog);
  const customTools = gate.buildCustomTools(weatherToolDef)!;

  const first = await manager.start(startParams(agent, gate, customTools, () => { releaseCount += 1; }));

  assert.equal(first.status, "tool_calls");
  assert.equal(first.toolCalls.length, 1);
  assert.equal(first.toolCalls[0]!.id, "call_1");
  assert.equal(first.agentId, "agent-fake");
  assert.equal(releaseCount, 0, "run must stay held (mutex not released) while awaiting tool results");
  assert.equal(manager.findAgentByToolCallId("call_1", "key-a"), "agent-fake");

  const second = await manager.provideResultsAndContinue(
    "agent-fake",
    [{ id: "call_1", content: "18C sunny" }],
    { sink: undefined, abortSignal: undefined, log: silentLog },
  );

  assert.equal(second.status, "final");
  assert.match(second.content, /Done:/);
  assert.equal(releaseCount, 1, "resources released exactly once when the run finishes");
  assert.equal(manager.findAgentByToolCallId("call_1", "key-a"), undefined, "tool-call id index cleared after completion");
  assert.equal(manager.heldCount, 0);
});

test("findAgentByToolCallId refuses a different apiKey (passthrough-mode isolation)", async () => {
  const gate = new HeldToolGate();
  const { agent } = makeFakeAgent((tools) =>
    (async function* () {
      const result = await tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "call_1" });
      yield assistantMessage(String(result));
    })(),
  );
  const manager = new HeldRunManager(silentLog);
  const customTools = gate.buildCustomTools(weatherToolDef)!;

  const first = await manager.start(startParams(agent, gate, customTools, () => undefined));
  assert.equal(first.status, "tool_calls");

  assert.equal(manager.findAgentByToolCallId("call_1", "key-a"), "agent-fake", "owning key resolves the run");
  assert.equal(manager.findAgentByToolCallId("call_1", "key-b"), undefined, "a different key must not see the run");

  manager.abandon("agent-fake", "test cleanup");
});

test("a run with no tool calls completes in one start() and releases immediately", async () => {
  const gate = new HeldToolGate();
  let releaseCount = 0;
  const { agent } = makeFakeAgent(() =>
    (async function* () {
      yield assistantMessage("hello");
    })(),
  );
  const manager = new HeldRunManager(silentLog);

  const segment = await manager.start(startParams(agent, gate, {}, () => { releaseCount += 1; }));

  assert.equal(segment.status, "final");
  assert.equal(segment.content, "hello");
  assert.equal(releaseCount, 1);
  assert.equal(manager.heldCount, 0);
});

test("provideResultsAndContinue throws for an unknown agent id", async () => {
  const manager = new HeldRunManager(silentLog);
  await assert.rejects(
    () => manager.provideResultsAndContinue("nope", [{ id: "x", content: "y" }], { sink: undefined, abortSignal: undefined, log: silentLog }),
    /No held Cursor run is waiting/,
  );
});

test("tool-result timeout tears the held run down (cancels it, releases resources)", async () => {
  const gate = new HeldToolGate();
  let releaseCount = 0;
  const { agent, cancelled } = makeFakeAgent((tools) =>
    (async function* () {
      const result = await tools["get_weather"]!.execute({ city: "Paris" }, { toolCallId: "call_1" });
      yield assistantMessage(String(result));
    })(),
  );
  const manager = new HeldRunManager(silentLog);
  const customTools = gate.buildCustomTools(weatherToolDef)!;

  const first = await manager.start(
    startParams(agent, gate, customTools, () => { releaseCount += 1; }, { toolResultTimeoutMs: 50 }),
  );
  assert.equal(first.status, "tool_calls");

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cancelled(), true, "held run should be cancelled after the tool-result timeout");
  assert.equal(releaseCount, 1, "resources released on timeout teardown");
  assert.equal(manager.heldCount, 0);
});

test("segment timeout (hold mode's REQUEST_TIMEOUT_MS) cancels a run that never produces a tool call or answer", async () => {
  const gate = new HeldToolGate();
  let releaseCount = 0;
  // A wedged run: the stream never yields and never ends.
  const { agent, cancelled } = makeFakeAgent(() =>
    (async function* () {
      await new Promise(() => undefined); // hang forever
      yield assistantMessage("unreachable");
    })(),
  );
  const manager = new HeldRunManager(silentLog);

  await assert.rejects(
    () => manager.start(startParams(agent, gate, {}, () => { releaseCount += 1; }, { requestTimeoutMs: 50 })),
    /did not produce its next tool call or final answer within 50ms/,
  );
  assert.equal(cancelled(), true, "wedged run must be cancelled");
  assert.equal(releaseCount, 1, "resources released on segment-timeout teardown");
  assert.equal(manager.heldCount, 0);
});
