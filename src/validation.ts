import { HttpError } from "./errors";
import type { ChatCompletionMessage, ChatCompletionRequest, ChatRole, CompletionRequest } from "./types/openai";

// "developer" is OpenAI's successor to "system" for reasoning-model requests
// (their API treats the two as aliases); clients like Hermes send it for
// GPT-5-family models, so an OpenAI-compatible surface must accept it.
const VALID_ROLES: ChatRole[] = ["system", "developer", "user", "assistant", "tool", "function"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMessage(raw: unknown, index: number): ChatCompletionMessage {
  if (!isPlainObject(raw)) {
    throw HttpError.badRequest(`messages[${index}] must be an object`, "messages");
  }
  const role = raw["role"];
  if (typeof role !== "string" || !VALID_ROLES.includes(role as ChatRole)) {
    throw HttpError.badRequest(`messages[${index}].role must be one of ${VALID_ROLES.join(", ")}`, "messages");
  }
  const content = raw["content"];
  if (content !== null && content !== undefined && typeof content !== "string" && !Array.isArray(content)) {
    throw HttpError.badRequest(`messages[${index}].content must be a string, an array of content parts, or null`, "messages");
  }
  if (role !== "assistant" && role !== "tool" && (content === null || content === undefined)) {
    throw HttpError.badRequest(`messages[${index}].content is required for role "${role}"`, "messages");
  }

  const message: ChatCompletionMessage = {
    role: role as ChatRole,
    content: (content as ChatCompletionMessage["content"]) ?? null,
  };
  if (typeof raw["name"] === "string") message.name = raw["name"];
  if (typeof raw["tool_call_id"] === "string") message.tool_call_id = raw["tool_call_id"];
  if (Array.isArray(raw["tool_calls"])) {
    message.tool_calls = raw["tool_calls"] as ChatCompletionMessage["tool_calls"];
  }
  return message;
}

export function validateChatCompletionRequest(body: unknown): ChatCompletionRequest {
  if (!isPlainObject(body)) {
    throw HttpError.badRequest("Request body must be a JSON object");
  }
  const model = body["model"];
  if (typeof model !== "string" || model.trim().length === 0) {
    throw HttpError.badRequest('"model" is required and must be a non-empty string', "model");
  }
  const rawMessages = body["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw HttpError.badRequest('"messages" is required and must be a non-empty array', "messages");
  }

  const messages = rawMessages.map((message, index) => validateMessage(message, index));

  const request: ChatCompletionRequest = { model, messages };
  if (typeof body["stream"] === "boolean") request.stream = body["stream"];
  if (isPlainObject(body["stream_options"])) {
    request.stream_options = { include_usage: body["stream_options"]["include_usage"] === true };
  }
  if (typeof body["temperature"] === "number") request.temperature = body["temperature"];
  if (typeof body["top_p"] === "number") request.top_p = body["top_p"];
  if (typeof body["max_tokens"] === "number") request.max_tokens = body["max_tokens"];
  if (typeof body["max_completion_tokens"] === "number") request.max_completion_tokens = body["max_completion_tokens"];
  if (typeof body["user"] === "string") request.user = body["user"];
  if (typeof body["seed"] === "number") request.seed = body["seed"];
  if (Array.isArray(body["tools"])) request.tools = body["tools"] as ChatCompletionRequest["tools"];
  if (body["tool_choice"] !== undefined) request.tool_choice = body["tool_choice"] as ChatCompletionRequest["tool_choice"];
  if (isPlainObject(body["metadata"])) request.metadata = body["metadata"] as ChatCompletionRequest["metadata"];
  if (typeof body["reasoning_effort"] === "string") request.reasoning_effort = body["reasoning_effort"];

  return request;
}

export function validateCompletionRequest(body: unknown): CompletionRequest {
  if (!isPlainObject(body)) {
    throw HttpError.badRequest("Request body must be a JSON object");
  }
  const model = body["model"];
  if (typeof model !== "string" || model.trim().length === 0) {
    throw HttpError.badRequest('"model" is required and must be a non-empty string', "model");
  }
  const prompt = body["prompt"];
  if (typeof prompt !== "string" && !(Array.isArray(prompt) && prompt.every((p) => typeof p === "string"))) {
    throw HttpError.badRequest('"prompt" is required and must be a string or array of strings', "prompt");
  }

  const request: CompletionRequest = { model, prompt };
  if (typeof body["stream"] === "boolean") request.stream = body["stream"];
  if (typeof body["temperature"] === "number") request.temperature = body["temperature"];
  if (typeof body["top_p"] === "number") request.top_p = body["top_p"];
  if (typeof body["max_tokens"] === "number") request.max_tokens = body["max_tokens"];
  if (typeof body["user"] === "string") request.user = body["user"];
  if (isPlainObject(body["metadata"])) request.metadata = body["metadata"] as CompletionRequest["metadata"];
  return request;
}
