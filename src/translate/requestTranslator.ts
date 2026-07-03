import type { SDKImage } from "@cursor/sdk";
import type { ChatCompletionMessage } from "../types/openai";

export function stringifyContent(content: ChatCompletionMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "[image attached]")).join("\n");
}

export function extractImages(content: ChatCompletionMessage["content"]): SDKImage[] {
  if (!Array.isArray(content)) return [];
  const images: SDKImage[] = [];
  for (const part of content) {
    if (part.type !== "image_url") continue;
    const url = part.image_url.url;
    const dataUrlMatch = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (dataUrlMatch) {
      images.push({ data: dataUrlMatch[2]!, mimeType: dataUrlMatch[1]! });
    } else {
      images.push({ url });
    }
  }
  return images;
}

/**
 * Splits `system` role messages out (concatenated into one prompt block) from
 * the rest of the conversation. `developer` is OpenAI's system-role successor
 * for reasoning models (the two are aliases on their API) and is folded into
 * the same block.
 */
export function extractSystemPrompt(messages: ChatCompletionMessage[]): {
  systemPrompt: string | undefined;
  rest: ChatCompletionMessage[];
} {
  const systemParts: string[] = [];
  const rest: ChatCompletionMessage[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = stringifyContent(message.content);
      if (text) systemParts.push(text);
    } else {
      rest.push(message);
    }
  }
  return { systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, rest };
}

function formatHistoryMessage(message: ChatCompletionMessage): string {
  const content = stringifyContent(message.content);
  switch (message.role) {
    case "user":
      return `User: ${content}`;
    case "assistant": {
      if (message.tool_calls && message.tool_calls.length > 0) {
        const calls = message.tool_calls.map((call) => `  - ${call.function.name}(${call.function.arguments})`).join("\n");
        return `Assistant: ${content || "(requested tool calls, no text)"}\n${calls}`;
      }
      return `Assistant: ${content}`;
    }
    case "tool":
      return `Tool result (for call ${message.tool_call_id ?? "unknown"}): ${content}`;
    case "function":
      return `Function "${message.name ?? "unknown"}" result: ${content}`;
    case "system":
    case "developer":
      return `System: ${content}`;
  }
}

function formatSystemBlock(systemPrompt: string): string {
  return `[System instructions]\n${systemPrompt}`;
}

export interface PreparedTurn {
  text: string;
  images: SDKImage[] | undefined;
}

/**
 * Builds the single text turn to actually send via `agent.send()` from
 * `newMessages` - the subset of the request's messages
 * {@link SessionManager.resolve} determined is actually new to this agent
 * (already stripped of `system` messages - see {@link extractSystemPrompt}).
 *
 * - Exactly one new user message and no assistant messages mixed in (the
 *   common case, whether that's a client's single follow-up under an
 *   explicit session, or the single new trailing message an auto-detected
 *   warm agent hasn't seen yet): send it close to verbatim, with any images
 *   attached natively.
 * - Several new messages with no assistant turns among them (e.g. a tool
 *   result immediately followed by a new user message): fold them into one
 *   turn, no framing needed since none of it is "already-answered" history.
 * - `newMessages` contains at least one assistant turn (this only happens
 *   when a brand-new Cursor agent is being hydrated with conversation
 *   history it never itself generated): fold everything with explicit
 *   framing telling the model this is context, not something to re-answer.
 */
export function prepareTurn(params: { newMessages: ChatCompletionMessage[]; isFirstTurn: boolean; systemPrompt: string | undefined }): PreparedTurn {
  const { newMessages, isFirstTurn, systemPrompt } = params;
  if (newMessages.length === 0) {
    return { text: systemPrompt && isFirstTurn ? formatSystemBlock(systemPrompt) : "", images: undefined };
  }

  const lastMessage = newMessages[newMessages.length - 1]!;
  const images = extractImages(lastMessage.content);
  const containsAssistantTurn = newMessages.some((message) => message.role === "assistant");

  if (!containsAssistantTurn && newMessages.length === 1 && newMessages[0]!.role === "user") {
    const text = stringifyContent(newMessages[0]!.content);
    const withSystem = systemPrompt && isFirstTurn ? `${formatSystemBlock(systemPrompt)}\n\n${text}` : text;
    return { text: withSystem, images: images.length > 0 ? images : undefined };
  }

  const parts: string[] = [];
  if (systemPrompt && isFirstTurn) parts.push(formatSystemBlock(systemPrompt));

  if (containsAssistantTurn) {
    parts.push(
      "The following is prior conversation history, provided for context only. Continue naturally " +
        "from the final message below; do not re-answer earlier turns.",
      "--- Conversation history ---",
    );
  }
  for (const message of newMessages) {
    parts.push(formatHistoryMessage(message));
  }
  if (containsAssistantTurn) parts.push("--- End of history ---");

  return { text: parts.join("\n\n"), images: images.length > 0 ? images : undefined };
}
