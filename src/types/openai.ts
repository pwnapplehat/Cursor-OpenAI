/**
 * Minimal, dependency-free TypeScript types for the subset of the OpenAI API
 * this gateway implements. Deliberately hand-rolled (not imported from the
 * `openai` package) so the gateway has zero runtime dependency on OpenAI's
 * client library while staying wire-compatible with it.
 */

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool" | "function";

export interface ChatCompletionContentPartText {
  type: "text";
  text: string;
}

export interface ChatCompletionContentPartImage {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage;

export interface ChatCompletionToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: ChatCompletionToolCallFunction;
}

export interface ChatCompletionMessage {
  role: ChatRole;
  content: string | ChatCompletionContentPart[] | null;
  name?: string;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
  /** Non-standard extension (matches the convention used by DeepSeek/o1-style OpenAI-compatible clients) carrying Cursor's chain-of-thought text. Ignored by strict OpenAI clients. */
  reasoning_content?: string;
}

export interface ChatCompletionToolFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatCompletionTool {
  type: "function";
  function: ChatCompletionToolFunctionDef;
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionRequestMetadata {
  session_id?: string;
  sessionId?: string;
  cursor_agent_id?: string;
  cursorAgentId?: string;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: ChatCompletionTool[];
  tool_choice?: ToolChoice;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown };
  seed?: number;
  metadata?: ChatCompletionRequestMetadata;
  reasoning_effort?: string;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

export interface ChatCompletionResponseChoice {
  index: number;
  message: ChatCompletionMessage & { refusal?: null };
  finish_reason: FinishReason;
  logprobs: null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionResponseChoice[];
  usage?: ChatCompletionUsage;
  system_fingerprint?: string;
  cursor_agent_id?: string;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: FinishReason;
  logprobs: null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage | null;
  cursor_agent_id?: string;
}

export interface CompletionRequest {
  model: string;
  prompt: string | string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  user?: string;
  metadata?: ChatCompletionRequestMetadata;
}

export interface CompletionChoice {
  index: number;
  text: string;
  finish_reason: FinishReason;
  logprobs: null;
}

export interface CompletionResponse {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /**
   * Non-standard extension: the context window (in tokens) of the variant
   * Cursor serves by default for this model, derived from the Cursor
   * catalog's `context` parameter. Widely-adopted convention (vLLM, Ollama,
   * OpenRouter, LM Studio all expose it under this or a sibling name), and
   * OpenAI-compatible clients that don't know it simply ignore it. Agent
   * frameworks like Hermes probe /v1/models for exactly this field to size
   * their context-compression thresholds correctly. Omitted when Cursor
   * doesn't declare a context parameter for the model.
   */
  context_length?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}
