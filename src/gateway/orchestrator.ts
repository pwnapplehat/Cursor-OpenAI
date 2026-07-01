import type { SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { ModelCatalog } from "../cursor/modelCatalog";
import { SessionManager, type SessionHandle } from "../cursor/sessionManager";
import type { Semaphore } from "../utils/concurrency";
import { ToolCallCapture, buildBridgedCustomTools } from "../cursor/toolBridge";
import { extractSystemPrompt, prepareTurn } from "../translate/requestTranslator";
import { runTurn, type RunOutcome, type RunSink } from "../cursor/runController";
import { buildChatCompletionResponse } from "../translate/responseTranslator";
import type { ChatCompletionMessage, ChatCompletionRequestMetadata, ChatCompletionTool } from "../types/openai";
import { HttpError } from "../errors";

export interface GatewayDeps {
  config: AppConfig;
  log: Logger;
  modelCatalog: ModelCatalog;
  sessionManager: SessionManager;
  semaphore: Semaphore;
}

export interface PreparedGatewayTurn {
  apiKey: string;
  requestedModelId: string;
  resolvedModelId: string;
  messages: ChatCompletionMessage[];
  handle: SessionHandle;
  turnMessage: string | SDKUserMessage;
  customTools: Record<string, SDKCustomTool> | undefined;
  toolCapture: ToolCallCapture | undefined;
  releaseSemaphore: () => void;
  log: Logger;
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
    requestedModelId: string;
    rawMessages: ChatCompletionMessage[];
    tools: ChatCompletionTool[] | undefined;
    metadata: ChatCompletionRequestMetadata | undefined;
    requestId: string;
  },
): Promise<PreparedGatewayTurn> {
  const { config, log: baseLog, modelCatalog, sessionManager, semaphore } = deps;
  const { apiKey, requestedModelId, rawMessages, tools, metadata, requestId } = params;
  const log = baseLog.child({ requestId });

  const { systemPrompt, rest } = extractSystemPrompt(rawMessages);
  if (rest.length === 0) {
    throw HttpError.badRequest('"messages" must include at least one non-system message', "messages");
  }

  const model = await modelCatalog.resolveModelSelection(apiKey, requestedModelId, config.defaultModel);

  const releaseSemaphore = await semaphore.acquire();
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
  let customTools: Record<string, SDKCustomTool> | undefined;
  const hasFunctionTools = (tools ?? []).some((tool) => tool.type === "function");
  if (hasFunctionTools) {
    if (config.toolBridgeEnabled && config.cursorRuntime === "local") {
      toolCapture = new ToolCallCapture();
      customTools = buildBridgedCustomTools(tools, toolCapture);
    } else {
      log.warn(
        { toolBridgeEnabled: config.toolBridgeEnabled, runtime: config.cursorRuntime },
        "client requested tools[] but the tool-calling bridge is disabled or unavailable on this runtime; tools will be ignored",
      );
    }
  }

  return {
    apiKey,
    requestedModelId,
    resolvedModelId: model.id,
    messages: rest,
    handle,
    turnMessage,
    customTools,
    toolCapture,
    releaseSemaphore,
    log,
  };
}

export async function executeGatewayTurn(
  deps: GatewayDeps,
  prepared: PreparedGatewayTurn,
  options: { sink: RunSink | undefined; abortSignal: AbortSignal | undefined },
): Promise<RunOutcome> {
  const { config } = deps;
  return prepared.handle.mutex.runExclusive(() =>
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
}

/** Registers the auto-session cache entry with the full post-turn transcript, so the next request (which will include our reply) is recognized as a continuation. */
export function rememberGatewayTurn(deps: GatewayDeps, prepared: PreparedGatewayTurn, outcome: RunOutcome): void {
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
