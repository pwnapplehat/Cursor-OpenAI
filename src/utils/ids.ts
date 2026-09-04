import { randomUUID } from "node:crypto";

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

export function newChatCompletionId(): string {
  return `chatcmpl-${shortId()}`;
}

export function newCompletionId(): string {
  return `cmpl-${shortId()}`;
}

export function newToolCallId(): string {
  return `call_${shortId()}`;
}

export function newRequestId(): string {
  return `req_${shortId()}`;
}

export function newResponseId(): string {
  return `resp_${shortId()}`;
}

export function newMessageId(): string {
  return `msg_${shortId()}`;
}

export function newFunctionCallItemId(): string {
  return `fc_${shortId()}`;
}
