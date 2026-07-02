import type { RunOutcome } from "../cursor/runController";
import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionMessage,
  ChatCompletionResponse,
  ChatCompletionToolCall,
  FinishReason,
} from "../types/openai";
import { newToolCallId } from "../utils/ids";
import { toOpenAIUsage } from "./usage";

export function toOpenAIFinishReason(finishReason: RunOutcome["finishReason"]): FinishReason {
  if (finishReason === "tool_calls") return "tool_calls";
  return "stop";
}

export function buildToolCalls(outcome: RunOutcome): ChatCompletionToolCall[] | undefined {
  // Prefer the full set (hold mode can surface parallel calls); fall back to
  // the single legacy slot for the cancel-mode path.
  const calls = outcome.toolCalls && outcome.toolCalls.length > 0 ? outcome.toolCalls : outcome.toolCall ? [outcome.toolCall] : [];
  if (calls.length === 0) return undefined;
  return calls.map((call) => ({
    id: call.id || newToolCallId(),
    type: "function" as const,
    function: { name: call.name, arguments: call.argumentsJson },
  }));
}

export function buildChatCompletionResponse(params: {
  id: string;
  outcome: RunOutcome;
  requestedModel: string;
  promptTextForEstimate: string;
  includeReasoning: boolean;
}): ChatCompletionResponse {
  const { id, outcome, requestedModel, promptTextForEstimate, includeReasoning } = params;
  const toolCalls = buildToolCalls(outcome);

  const message: ChatCompletionMessage = {
    role: "assistant",
    content: outcome.content.length > 0 || !toolCalls ? outcome.content : null,
  };
  if (toolCalls) message.tool_calls = toolCalls;
  if (includeReasoning && outcome.reasoningContent) {
    message.reasoning_content = outcome.reasoningContent;
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: outcome.model?.id ?? requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toOpenAIFinishReason(outcome.finishReason),
        logprobs: null,
      },
    ],
    usage: toOpenAIUsage(outcome.usage, promptTextForEstimate, outcome.content),
    cursor_agent_id: outcome.agentId,
  };
}

export function buildRoleChunk(id: string, created: number, model: string): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
  };
}

export function buildDeltaChunk(id: string, created: number, model: string, delta: ChatCompletionChunkDelta): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
  };
}

export function buildToolCallStartChunk(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  name: string,
  index = 0,
): ChatCompletionChunk {
  return buildDeltaChunk(id, created, model, {
    tool_calls: [{ index, id: toolCallId, type: "function", function: { name, arguments: "" } }],
  });
}

export function buildToolCallArgumentsChunk(id: string, created: number, model: string, argumentsJson: string, index = 0): ChatCompletionChunk {
  return buildDeltaChunk(id, created, model, {
    tool_calls: [{ index, function: { arguments: argumentsJson } }],
  });
}

export function buildFinalChunk(
  id: string,
  created: number,
  model: string,
  outcome: RunOutcome,
  includeUsage: boolean,
  promptTextForEstimate: string,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: outcome.model?.id ?? model,
    choices: [{ index: 0, delta: {}, finish_reason: toOpenAIFinishReason(outcome.finishReason), logprobs: null }],
    usage: includeUsage ? toOpenAIUsage(outcome.usage, promptTextForEstimate, outcome.content) : undefined,
    cursor_agent_id: outcome.agentId,
  };
}
