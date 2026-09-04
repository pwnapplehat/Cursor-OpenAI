import type { RunOutcome } from "../cursor/runController";
import { HttpError } from "../errors";
import { newFunctionCallItemId, newMessageId } from "../utils/ids";
import { toOpenAIUsage } from "./usage";
import { buildToolCalls } from "./responseTranslator";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessage,
  ChatCompletionTool,
  ChatCompletionToolCall,
  ResponsesFunctionCallItem,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesStatus,
  ResponsesTool,
  ResponsesUsage,
} from "../types/openai";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps Responses `tools[]` onto the Chat Completions tool shape the existing
 * Cursor tool-bridge already understands. Accepts both the Responses function
 * shape (`{ type, name, parameters }`) and the nested Chat Completions shape
 * (`{ type, function: { name, parameters } }`). Non-function tools are
 * skipped - this gateway has no Cursor equivalent for web_search etc.
 */
export function responsesToolsToChatTools(tools: ResponsesTool[] | undefined): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    if (!isPlainObject(tool) || tool["type"] !== "function") continue;
    const nested = tool["function"];
    if (isPlainObject(nested) && typeof nested["name"] === "string" && nested["name"].trim().length > 0) {
      out.push({
        type: "function",
        function: {
          name: nested["name"].trim(),
          ...(typeof nested["description"] === "string" ? { description: nested["description"] } : {}),
          ...(isPlainObject(nested["parameters"]) ? { parameters: nested["parameters"] as Record<string, unknown> } : {}),
        },
      });
      continue;
    }
    const name = tool["name"];
    if (typeof name === "string" && name.trim().length > 0) {
      out.push({
        type: "function",
        function: {
          name: name.trim(),
          ...(typeof tool["description"] === "string" ? { description: tool["description"] } : {}),
          ...(isPlainObject(tool["parameters"]) ? { parameters: tool["parameters"] as Record<string, unknown> } : {}),
        },
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Converts a Responses `input` (string or item array) plus optional
 * `instructions` into Chat Completions `messages[]` the existing pipeline
 * already runs. `priorMessages` is the stored transcript from
 * `previous_response_id` with previous system/developer messages stripped
 * (instructions replace each request, matching OpenAI).
 */
export function responsesInputToMessages(params: {
  input: string | ResponsesInputItem[];
  instructions?: string;
  priorMessages?: ChatCompletionMessage[];
}): ChatCompletionMessage[] {
  const prior = (params.priorMessages ?? []).filter((m) => m.role !== "system" && m.role !== "developer");
  const converted = convertInput(params.input);
  const messages: ChatCompletionMessage[] = [];
  if (params.instructions && params.instructions.trim().length > 0) {
    messages.push({ role: "system", content: params.instructions });
  }
  messages.push(...prior, ...converted);
  return messages;
}

function convertInput(input: string | ResponsesInputItem[]): ChatCompletionMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  const messages: ChatCompletionMessage[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i]!;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!isPlainObject(item)) {
      throw HttpError.badRequest(`input[${i}] must be a string or an object`, "input");
    }
    const type = item["type"];
    if (type === "function_call_output") {
      const callId = item["call_id"];
      const output = item["output"];
      if (typeof callId !== "string" || callId.length === 0) {
        throw HttpError.badRequest(`input[${i}].call_id is required`, "input");
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
      continue;
    }
    if (type === "function_call") {
      const callId = item["call_id"];
      const name = item["name"];
      const args = item["arguments"];
      if (typeof callId !== "string" || callId.length === 0) {
        throw HttpError.badRequest(`input[${i}].call_id is required`, "input");
      }
      if (typeof name !== "string" || name.length === 0) {
        throw HttpError.badRequest(`input[${i}].name is required`, "input");
      }
      const toolCall: ChatCompletionToolCall = {
        id: callId,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
      };
      messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      continue;
    }
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = item["text"];
      if (typeof text !== "string") {
        throw HttpError.badRequest(`input[${i}].text must be a string`, "input");
      }
      messages.push({ role: "user", content: text });
      continue;
    }
    const role = item["role"];
    if (role === "user" || role === "assistant" || role === "system" || role === "developer") {
      messages.push({
        role,
        content: normalizeMessageContent(item["content"], i),
      });
      continue;
    }
    throw HttpError.badRequest(
      `input[${i}] is not a supported Responses input item (message, function_call, function_call_output, or input_text)`,
      "input",
    );
  }
  return messages;
}

function normalizeMessageContent(content: unknown, index: number): ChatCompletionMessage["content"] {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw HttpError.badRequest(`input[${index}].content must be a string or an array of content parts`, "input");
  }
  const parts: ChatCompletionContentPart[] = [];
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (part["type"] === "input_text" || part["type"] === "output_text" || part["type"] === "text") {
      if (typeof part["text"] === "string") parts.push({ type: "text", text: part["text"] });
      continue;
    }
    if (part["type"] === "input_image") {
      const imageUrl = part["image_url"];
      const url = typeof imageUrl === "string" ? imageUrl : isPlainObject(imageUrl) && typeof imageUrl["url"] === "string" ? imageUrl["url"] : undefined;
      if (url) parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (part["type"] === "image_url" && isPlainObject(part["image_url"]) && typeof part["image_url"]["url"] === "string") {
      parts.push({ type: "image_url", image_url: { url: part["image_url"]["url"] as string } });
    }
  }
  return parts;
}

export function assistantMessageFromOutcome(outcome: RunOutcome): ChatCompletionMessage {
  const toolCalls = buildToolCalls(outcome);
  const message: ChatCompletionMessage = {
    role: "assistant",
    content: outcome.content.length > 0 || !toolCalls ? outcome.content : null,
  };
  if (toolCalls) message.tool_calls = toolCalls;
  if (outcome.reasoningContent) message.reasoning_content = outcome.reasoningContent;
  return message;
}

export interface OutputItemReuse {
  /** Streamed `msg_…` id so `response.completed.output[].id` matches SSE `item_id`. */
  messageId?: string;
  /** Streamed `fc_…` items, in output order. When non-empty, replaces newly minted function_call ids. */
  functionCallItems?: ResponsesFunctionCallItem[];
}

export function outcomeToOutputItems(outcome: RunOutcome, reuse?: OutputItemReuse): ResponsesOutputItem[] {
  const items: ResponsesOutputItem[] = [];
  const toolCalls = buildToolCalls(outcome);
  const reusedFc = reuse?.functionCallItems && reuse.functionCallItems.length > 0 ? reuse.functionCallItems : undefined;
  const hasTools = Boolean(reusedFc) || Boolean(toolCalls);
  if (outcome.content.length > 0 || !hasTools) {
    const message: ResponsesMessageItem = {
      type: "message",
      id: reuse?.messageId ?? newMessageId(),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: outcome.content }],
    };
    items.push(message);
  }
  if (reusedFc) {
    items.push(...reusedFc);
  } else if (toolCalls) {
    for (const call of toolCalls) {
      const item: ResponsesFunctionCallItem = {
        type: "function_call",
        id: newFunctionCallItemId(),
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: "completed",
      };
      items.push(item);
    }
  }
  return items;
}

export function toResponsesUsage(usage: RunOutcome["usage"], promptText: string, completionText: string): ResponsesUsage {
  const chat = toOpenAIUsage(usage, promptText, completionText);
  const result: ResponsesUsage = {
    input_tokens: chat.prompt_tokens,
    output_tokens: chat.completion_tokens,
    total_tokens: chat.total_tokens,
  };
  if (chat.prompt_tokens_details) result.input_tokens_details = chat.prompt_tokens_details;
  if (chat.completion_tokens_details) result.output_tokens_details = chat.completion_tokens_details;
  return result;
}

export function responsesStatusForOutcome(outcome: RunOutcome): ResponsesStatus {
  if (outcome.finishReason === "cancelled") return "cancelled";
  if (outcome.finishReason === "tool_calls") return "completed";
  return "completed";
}

export function buildResponsesObject(params: {
  id: string;
  createdAt: number;
  requestedModel: string;
  outcome: RunOutcome;
  promptTextForEstimate: string;
  reuse?: OutputItemReuse;
}): ResponsesObject {
  const { id, createdAt, requestedModel, outcome, promptTextForEstimate, reuse } = params;
  const output = outcomeToOutputItems(outcome, reuse);
  const status = responsesStatusForOutcome(outcome);
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    model: requestedModel,
    output,
    usage: toResponsesUsage(outcome.usage, promptTextForEstimate, outcome.content),
    error: null,
    incomplete_details: outcome.finishReason === "tool_calls" ? { reason: "tool_calls" } : null,
    cursor_agent_id: outcome.agentId,
  };
}

export function stringifyResponsesInput(input: string | ResponsesInputItem[]): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}
