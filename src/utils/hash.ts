import { createHash } from "node:crypto";
import type { ChatCompletionMessage } from "../types/openai";

export function normalizeContent(content: ChatCompletionMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[image:${part.image_url.url.slice(0, 64)}]`))
    .join("\u0003");
}

/**
 * Stable content hash of a message array, used to auto-detect when a new
 * request's `messages[]` is a continuation of a previously seen conversation
 * (same prefix) so we can reuse that conversation's live Cursor agent instead
 * of replaying the whole history again.
 */
export function hashMessages(model: string, messages: ChatCompletionMessage[]): string {
  const hash = createHash("sha256");
  hash.update(model);
  hash.update("\u0000");
  for (const message of messages) {
    hash.update(message.role);
    hash.update("\u0001");
    hash.update(normalizeContent(message.content));
    hash.update("\u0001");
    if (message.tool_call_id) hash.update(message.tool_call_id);
    hash.update("\u0001");
    if (message.tool_calls) hash.update(JSON.stringify(message.tool_calls));
    hash.update("\u0002");
  }
  return hash.digest("hex");
}

function messageEqual(a: ChatCompletionMessage, b: ChatCompletionMessage): boolean {
  return (
    a.role === b.role &&
    normalizeContent(a.content) === normalizeContent(b.content) &&
    (a.tool_call_id ?? "") === (b.tool_call_id ?? "") &&
    JSON.stringify(a.tool_calls ?? null) === JSON.stringify(b.tool_calls ?? null)
  );
}

/** Structural equality of two message arrays, ignoring fields that don't affect what was actually said (e.g. `reasoning_content`, `name`). */
export function messagesEqual(a: ChatCompletionMessage[], b: ChatCompletionMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!messageEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/**
 * Computes the "new" tail of `current` relative to `remembered` (the full
 * message array a session was last known to be in sync with).
 *
 * Robust to both client behaviors this gateway needs to support:
 * - OpenAI-standard clients that resend the *entire* running history every
 *   request (the common case): `current` extends `remembered` exactly, so
 *   the new tail is `current.slice(remembered.length)`.
 * - Clients using an explicit `session_id`/`cursor_agent_id` that send only
 *   the turn's new message(s) each time: `current` won't match as an
 *   extension of `remembered` at all, so the whole of `current` is treated
 *   as new (which is exactly right in that case).
 */
export function computeNewSuffix(remembered: ChatCompletionMessage[], current: ChatCompletionMessage[]): ChatCompletionMessage[] {
  if (remembered.length === 0) return current;
  if (current.length >= remembered.length && messagesEqual(current.slice(0, remembered.length), remembered)) {
    return current.slice(remembered.length);
  }
  return current;
}
