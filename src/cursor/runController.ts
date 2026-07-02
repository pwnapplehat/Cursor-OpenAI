import type {
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKCustomTool,
  SDKMessage,
  SDKUserMessage,
  TextBlock,
  ToolUseBlock,
  TokenUsage,
} from "@cursor/sdk";
import type { Logger } from "../logger";
import { TextAccumulator } from "../utils/textAccumulator";
import type { PendingToolCall, ToolCallCapture } from "./toolBridge";
import { HttpError } from "../errors";
import type { CursorAgentModeOption } from "../config";

export type RunFinishReason = "stop" | "tool_calls" | "cancelled";

export interface RunOutcome {
  content: string;
  reasoningContent: string;
  finishReason: RunFinishReason;
  /** The first captured tool call, if any. Retained for the legacy single-call path; prefer {@link toolCalls} when present. */
  toolCall: PendingToolCall | undefined;
  /** All tool calls surfaced by this turn (hold mode can capture parallel calls). Absent/empty in the legacy cancel path beyond the first. */
  toolCalls?: PendingToolCall[];
  usage: TokenUsage | undefined;
  agentId: string;
  runId: string;
  model: ModelSelection | undefined;
}

export interface RunSink {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCallStarted?: (call: PendingToolCall) => void;
}

export interface RunTurnParams {
  agent: SDKAgent;
  message: string | SDKUserMessage;
  model: ModelSelection;
  agentMode: CursorAgentModeOption;
  customTools: Record<string, SDKCustomTool> | undefined;
  toolCapture: ToolCallCapture | undefined;
  includeThinking: boolean;
  timeoutMs: number;
  sink: RunSink | undefined;
  log: Logger;
  /** Aborted when the calling HTTP client disconnects mid-request, so we stop paying for a run nobody will read. */
  abortSignal: AbortSignal | undefined;
}

function isTextBlock(block: TextBlock | ToolUseBlock): block is TextBlock {
  return block.type === "text";
}

type StreamRace =
  | { kind: "message"; value: IteratorResult<SDKMessage, void> }
  | { kind: "tool"; call: PendingToolCall };

export async function runTurn(params: RunTurnParams): Promise<RunOutcome> {
  const { agent, message, model, agentMode, customTools, toolCapture, includeThinking, timeoutMs, sink, log, abortSignal } = params;

  const run: Run = await agent.send(message, {
    model,
    mode: agentMode,
    local: customTools ? { customTools } : undefined,
  });

  log.info({ runId: run.id, agentId: run.agentId }, "cursor run started");

  const textAcc = new TextAccumulator();
  const reasoningAcc = new TextAccumulator();
  let capturedToolCall: PendingToolCall | undefined;
  let timedOut = false;
  let aborted = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    run.cancel().catch((err: unknown) => log.debug({ err, runId: run.id }, "timeout cancel failed"));
  }, timeoutMs);

  const onAbort = (): void => {
    aborted = true;
    run.cancel().catch((err: unknown) => log.debug({ err, runId: run.id }, "client-abort cancel failed"));
  };
  abortSignal?.addEventListener("abort", onAbort);

  try {
    const iterator = run.stream();
    const toolWait = toolCapture?.wait();

    for (;;) {
      const nextResultPromise = iterator.next();
      const winner: StreamRace = toolWait
        ? await Promise.race<StreamRace>([
            nextResultPromise.then((value): StreamRace => ({ kind: "message", value })),
            toolWait.then((call): StreamRace => ({ kind: "tool", call })),
          ])
        : { kind: "message", value: await nextResultPromise };

      if (winner.kind === "tool") {
        capturedToolCall = winner.call;
        sink?.onToolCallStarted?.(winner.call);
        run.cancel().catch((err: unknown) => log.debug({ err, runId: run.id }, "post-tool-capture cancel failed"));
        break;
      }

      if (winner.value.done) break;
      consumeSdkMessage(winner.value.value, textAcc, reasoningAcc, sink, includeThinking, log);
    }
  } finally {
    clearTimeout(timeoutHandle);
    abortSignal?.removeEventListener("abort", onAbort);
  }

  let result: RunResult | undefined;
  try {
    result = await run.wait();
  } catch (err) {
    if (!capturedToolCall && !timedOut && !aborted) throw err;
    log.debug({ err, runId: run.id }, "run.wait() rejected after intentional cancellation");
  }

  if (aborted) {
    // The client already disconnected; nobody will read a thrown error here.
    // Return a best-effort outcome so callers can short-circuit cleanly.
    return {
      content: textAcc.current,
      reasoningContent: reasoningAcc.current,
      finishReason: "cancelled",
      toolCall: undefined,
      usage: result?.usage ?? run.usage,
      agentId: run.agentId,
      runId: run.id,
      model: result?.model ?? run.model,
    };
  }

  if (timedOut && !capturedToolCall) {
    throw HttpError.timeout(
      `Cursor agent run ${run.id} did not finish within ${timeoutMs}ms and was cancelled. ` +
        "Increase REQUEST_TIMEOUT_MS if this task is expected to take longer.",
    );
  }

  if (!capturedToolCall && result?.status === "error") {
    throw HttpError.internal(
      `Cursor agent run ${run.id} (agent ${run.agentId}) finished with status "error". ` +
        "Inspect this run in the Cursor dashboard or via Agent.getRun() for details.",
    );
  }

  const finishReason: RunFinishReason = capturedToolCall ? "tool_calls" : result?.status === "cancelled" ? "cancelled" : "stop";

  return {
    content: textAcc.current,
    reasoningContent: reasoningAcc.current,
    finishReason,
    toolCall: capturedToolCall,
    usage: result?.usage ?? run.usage,
    agentId: run.agentId,
    runId: run.id,
    model: result?.model ?? run.model,
  };
}

export function consumeSdkMessage(
  message: SDKMessage,
  textAcc: TextAccumulator,
  reasoningAcc: TextAccumulator,
  sink: RunSink | undefined,
  includeThinking: boolean,
  log: Logger,
): void {
  switch (message.type) {
    case "assistant": {
      const text = message.message.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("");
      const delta = textAcc.update(text);
      if (delta) sink?.onTextDelta?.(delta);
      break;
    }
    case "thinking": {
      if (!includeThinking) break;
      const delta = reasoningAcc.update(message.text);
      if (delta) sink?.onReasoningDelta?.(delta);
      break;
    }
    case "tool_call":
    case "system":
    case "user":
    case "status":
    case "request":
    case "task":
    case "usage":
      log.trace({ type: message.type }, "cursor sdk event");
      break;
    default:
      log.trace({ message }, "unhandled cursor sdk event type");
  }
}
