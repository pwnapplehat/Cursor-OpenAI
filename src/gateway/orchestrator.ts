import type { SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { ModelCatalog } from "../cursor/modelCatalog";
import { SessionManager, type SessionHandle } from "../cursor/sessionManager";
import type { Semaphore } from "../utils/concurrency";
import { ToolCallCapture, buildBridgedCustomTools } from "../cursor/toolBridge";
import { HeldToolGate, type HeldToolResult } from "../cursor/heldToolGate";
import type { HeldRunManager, HeldRunSegment } from "../cursor/heldRunManager";
import { extractImages, extractSystemPrompt, prepareTurn } from "../translate/requestTranslator";
import { runTurn, type RunOutcome, type RunSink } from "../cursor/runController";
import { buildChatCompletionResponse } from "../translate/responseTranslator";
import type { ChatCompletionMessage, ChatCompletionRequestMetadata, ChatCompletionTool } from "../types/openai";
import { HttpError } from "../errors";
import type { ActivityEntry, ActivityLog } from "../observability/activityLog";

export interface GatewayDeps {
  config: AppConfig;
  log: Logger;
  modelCatalog: ModelCatalog;
  sessionManager: SessionManager;
  semaphore: Semaphore;
  activityLog: ActivityLog;
  heldRunManager: HeldRunManager;
}

/** How long to wait for concurrently-dispatched parallel tool calls to all park before answering the batch. Small; the SDK fires them within a few ms of each other. */
const PARALLEL_TOOL_SETTLE_MS = 150;

/** The trailing `tool` result messages of a continuation request, paired with the held run they belong to. */
interface HeldContinuation {
  agentId: string;
  results: HeldToolResult[];
}

export interface PreparedGatewayTurn {
  apiKey: string;
  requestId: string;
  endpoint: ActivityEntry["endpoint"];
  requestedModelId: string;
  resolvedModelId: string;
  messages: ChatCompletionMessage[];
  handle: SessionHandle;
  turnMessage: string | SDKUserMessage;
  customTools: Record<string, SDKCustomTool> | undefined;
  /** Set only in legacy `cancel` tool-bridge mode. */
  toolCapture: ToolCallCapture | undefined;
  /** Set only in `hold` tool-bridge mode (when tools are present and usable). */
  heldGate: HeldToolGate | undefined;
  releaseSemaphore: () => void;
  log: Logger;
  /**
   * Present when this request is a continuation of an already-held run (its
   * trailing messages are `tool` results matching a run the gateway is still
   * keeping alive). When set, {@link executeGatewayTurn} feeds these results
   * into that run instead of starting a new one - and `handle`/`turnMessage`
   * are unused.
   */
  continuation: HeldContinuation | undefined;
}

/**
 * Detects whether an incoming request is continuing a run the gateway is
 * holding open for tool results. Looks at the trailing `tool` messages and
 * checks whether their `tool_call_id`s belong to a held run. Returns the
 * matched run's agent id plus the results to inject, or undefined if this
 * isn't a continuation (normal request).
 */
function detectHeldContinuation(
  heldRunManager: HeldRunManager,
  messages: ChatCompletionMessage[],
  apiKey: string,
): HeldContinuation | undefined {
  const trailingToolResults: HeldToolResult[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role !== "tool") break;
    if (typeof msg.tool_call_id === "string" && msg.tool_call_id.length > 0) {
      const images = extractImages(msg.content);
      trailingToolResults.unshift({
        id: msg.tool_call_id,
        content: contentToString(msg.content),
        ...(images.length > 0 ? { images } : {}),
      });
    }
  }
  if (trailingToolResults.length === 0) return undefined;

  for (const result of trailingToolResults) {
    const agentId = heldRunManager.findAgentByToolCallId(result.id, apiKey);
    if (agentId) {
      // Only pass results whose ids belong to this same held run.
      const results = trailingToolResults.filter((r) => heldRunManager.findAgentByToolCallId(r.id, apiKey) === agentId);
      return { agentId, results };
    }
  }
  return undefined;
}

function contentToString(content: ChatCompletionMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Resolves everything a chat/completions request needs before actually
 * running a Cursor agent turn: model selection, system prompt extraction,
 * session/agent reuse, and (if applicable) the OpenAI tool-calling bridge.
 * Acquires a global concurrency slot that the caller MUST release (via the
 * returned `releaseSemaphore`) exactly once, in a `finally` block.
 */
export async function prepareGatewayTurn(
  deps: GatewayDeps,
  params: {
    apiKey: string;
    endpoint: ActivityEntry["endpoint"];
    requestedModelId: string;
    rawMessages: ChatCompletionMessage[];
    tools: ChatCompletionTool[] | undefined;
    metadata: ChatCompletionRequestMetadata | undefined;
    requestId: string;
  },
): Promise<PreparedGatewayTurn> {
  const { config, log: baseLog, modelCatalog, sessionManager, semaphore, heldRunManager } = deps;
  const { apiKey, endpoint, requestedModelId, rawMessages, tools, metadata, requestId } = params;
  const log = baseLog.child({ requestId });

  const { systemPrompt, rest } = extractSystemPrompt(rawMessages);
  if (rest.length === 0) {
    throw HttpError.badRequest('"messages" must include at least one non-system message', "messages");
  }

  const model = await modelCatalog.resolveModelSelection(apiKey, requestedModelId, config.defaultModel);

  // Continuation of a held run? Then there's no new agent turn to prepare -
  // we resume the run that's already open. The held run still owns its
  // session mutex from the original request, so we do NOT take a semaphore
  // slot here (that would double-count the same logical run against the
  // concurrency cap and could deadlock at MAX_CONCURRENT_RUNS=1).
  const continuation = detectHeldContinuation(heldRunManager, rest, apiKey);
  if (continuation) {
    return {
      apiKey,
      requestId,
      endpoint,
      requestedModelId,
      resolvedModelId: model.id,
      messages: rest,
      handle: undefined as unknown as SessionHandle,
      turnMessage: "",
      customTools: undefined,
      toolCapture: undefined,
      heldGate: undefined,
      releaseSemaphore: () => undefined,
      log,
      continuation,
    };
  }

  const rawReleaseSemaphore = await semaphore.acquire();
  // Idempotent wrapper: in hold mode the same slot's release is reachable
  // from both the held-run manager (when the run finally completes/tears
  // down) and the route's finally block; releasing a counting semaphore
  // twice would corrupt its available count. Guard so only the first call
  // counts.
  let semaphoreReleased = false;
  const releaseSemaphore = (): void => {
    if (semaphoreReleased) return;
    semaphoreReleased = true;
    rawReleaseSemaphore();
  };

  let handle: SessionHandle;
  try {
    handle = await sessionManager.resolve({ apiKey, model, messages: rest, metadata });
  } catch (err) {
    releaseSemaphore();
    throw err;
  }

  const turn = prepareTurn({ newMessages: handle.newMessages, isFirstTurn: handle.isFirstTurn, systemPrompt });
  const turnMessage: string | SDKUserMessage = turn.images && turn.images.length > 0 ? { text: turn.text, images: turn.images } : turn.text;

  let toolCapture: ToolCallCapture | undefined;
  let heldGate: HeldToolGate | undefined;
  let customTools: Record<string, SDKCustomTool> | undefined;
  const hasFunctionTools = (tools ?? []).some((tool) => tool.type === "function");
  if (hasFunctionTools) {
    if (config.toolBridgeEnabled && config.cursorRuntime === "local") {
      if (config.toolBridgeMode === "hold") {
        heldGate = new HeldToolGate();
        customTools = heldGate.buildCustomTools(tools);
      } else {
        toolCapture = new ToolCallCapture();
        customTools = buildBridgedCustomTools(tools, toolCapture);
      }
    } else {
      log.warn(
        { toolBridgeEnabled: config.toolBridgeEnabled, runtime: config.cursorRuntime },
        "client requested tools[] but the tool-calling bridge is disabled or unavailable on this runtime; tools will be ignored",
      );
    }
  }

  return {
    apiKey,
    requestId,
    endpoint,
    requestedModelId,
    resolvedModelId: model.id,
    messages: rest,
    handle,
    turnMessage,
    customTools,
    toolCapture,
    heldGate,
    releaseSemaphore,
    log,
    continuation: undefined,
  };
}

/** Converts a held-run segment into the same {@link RunOutcome} shape the rest of the pipeline (response translators, activity log) already consumes. */
function segmentToOutcome(segment: HeldRunSegment): RunOutcome {
  return {
    content: segment.content,
    reasoningContent: segment.reasoningContent,
    finishReason: segment.status === "tool_calls" ? "tool_calls" : segment.status === "cancelled" ? "cancelled" : "stop",
    // The response translator emits a single tool call today; hold mode may
    // surface several (parallel calls). We keep the first in the legacy
    // single-call slot and expose the full set via `toolCalls` for the
    // response builder to prefer.
    toolCall: segment.toolCalls[0],
    toolCalls: segment.toolCalls,
    usage: segment.usage,
    agentId: segment.agentId,
    runId: segment.runId,
    model: segment.model,
  };
}

/** Runs the actual Cursor agent turn and records the outcome (success or failure) to the activity log, regardless of caller. */
export async function executeGatewayTurn(
  deps: GatewayDeps,
  prepared: PreparedGatewayTurn,
  options: { sink: RunSink | undefined; abortSignal: AbortSignal | undefined; streaming: boolean },
): Promise<RunOutcome> {
  const { config, activityLog, heldRunManager } = deps;
  const startedAt = Date.now();

  const record = (outcome: RunOutcome | undefined, err: unknown): void => {
    activityLog.record({
      requestId: prepared.requestId,
      endpoint: prepared.endpoint,
      model: prepared.resolvedModelId,
      streaming: options.streaming,
      status: err
        ? "error"
        : outcome!.finishReason === "tool_calls"
          ? "tool_calls"
          : outcome!.finishReason === "cancelled"
            ? "cancelled"
            : "ok",
      durationMs: Date.now() - startedAt,
      usage: outcome?.usage,
      errorMessage: err ? (err instanceof Error ? err.message : String(err)) : undefined,
      cursorAgentId: outcome?.agentId,
    });
  };

  // --- Case 1: continuation of a run we're already holding open ---
  if (prepared.continuation) {
    try {
      const segment = await heldRunManager.provideResultsAndContinue(prepared.continuation.agentId, prepared.continuation.results, {
        sink: options.sink,
        abortSignal: options.abortSignal,
        log: prepared.log,
      });
      const outcome = segmentToOutcome(segment);
      record(outcome, undefined);
      return outcome;
    } catch (err) {
      heldRunManager.abandon(prepared.continuation.agentId, "continuation error");
      record(undefined, err);
      throw err;
    }
  }

  // --- Case 2: hold-mode tool bridge (keep one run alive across the loop) ---
  if (prepared.heldGate && prepared.customTools) {
    const rawRelease = await prepared.handle.mutex.acquire();
    // Idempotent: the held-run manager owns releasing this once it takes over,
    // but if start() throws before it does (e.g. agent.send() rejects), we
    // must release here too. Double-calling a Mutex release only re-resolves
    // an already-settled promise, so guarding on a flag keeps intent clear.
    let released = false;
    const releaseMutex = (): void => {
      if (released) return;
      released = true;
      rawRelease();
      // The held run owns the concurrency slot for its entire lifetime (across
      // every continuation request), so the semaphore is released together
      // with the mutex, exactly when the run reaches a terminal state.
      prepared.releaseSemaphore();
    };
    try {
      const segment = await heldRunManager.start({
        agent: prepared.handle.agent,
        apiKey: prepared.apiKey,
        message: prepared.turnMessage,
        model: { id: prepared.resolvedModelId },
        agentMode: config.cursorAgentMode,
        customTools: prepared.customTools,
        gate: prepared.heldGate,
        includeThinking: config.includeThinking,
        toolResultTimeoutMs: config.toolResultTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        batchSettleMs: PARALLEL_TOOL_SETTLE_MS,
        onRelease: releaseMutex,
        sink: options.sink,
        log: prepared.log,
        abortSignal: options.abortSignal,
      });
      const outcome = segmentToOutcome(segment);
      record(outcome, undefined);
      return outcome;
    } catch (err) {
      releaseMutex();
      record(undefined, err);
      throw err;
    }
  }

  // --- Case 3: legacy path (no tools, or cancel-mode tool bridge) ---
  try {
    const outcome = await prepared.handle.mutex.runExclusive(() =>
      runTurn({
        agent: prepared.handle.agent,
        message: prepared.turnMessage,
        model: { id: prepared.resolvedModelId },
        agentMode: config.cursorAgentMode,
        customTools: prepared.customTools,
        toolCapture: prepared.toolCapture,
        includeThinking: config.includeThinking,
        timeoutMs: config.requestTimeoutMs,
        sink: options.sink,
        log: prepared.log,
        abortSignal: options.abortSignal,
      }),
    );
    record(outcome, undefined);
    return outcome;
  } catch (err) {
    record(undefined, err);
    throw err;
  }
}

/** Whether this prepared turn represents a held run still waiting for tool results after the given outcome - i.e. the caller must NOT release the semaphore (the held run owns it) and should not call `rememberGatewayTurn`. */
export function isHeldOpen(prepared: PreparedGatewayTurn, outcome: RunOutcome): boolean {
  const usesHold = Boolean(prepared.continuation) || Boolean(prepared.heldGate);
  return usesHold && outcome.finishReason === "tool_calls";
}

/** Registers the auto-session cache entry with the full post-turn transcript, so the next request (which will include our reply) is recognized as a continuation. */
export function rememberGatewayTurn(deps: GatewayDeps, prepared: PreparedGatewayTurn, outcome: RunOutcome): void {
  // Continuation requests don't own a session handle (they resumed a held
  // run created by an earlier request) - there's nothing new to remember here.
  if (prepared.continuation || !prepared.handle) return;
  const response = buildChatCompletionResponse({
    id: "unused",
    outcome,
    requestedModel: prepared.requestedModelId,
    promptTextForEstimate: "",
    includeReasoning: false,
  });
  const assistantMessage = response.choices[0]!.message;
  deps.sessionManager.remember({
    apiKey: prepared.apiKey,
    model: { id: prepared.resolvedModelId },
    messages: [...prepared.messages, assistantMessage],
    handle: prepared.handle,
  });
}
