import type { Response } from "express";

/**
 * Thin wrapper around an Express response for writing an OpenAI-style
 * Server-Sent Events stream (`text/event-stream`, one `data: <json>` line per
 * chunk, terminated by a literal `data: [DONE]`).
 */
export class SseWriter {
  private readonly res: Response;
  private closed = false;

  constructor(res: Response) {
    this.res = res;
    this.res.status(200);
    this.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.res.setHeader("Cache-Control", "no-cache, no-transform");
    this.res.setHeader("Connection", "keep-alive");
    this.res.setHeader("X-Accel-Buffering", "no");
    this.res.flushHeaders?.();
  }

  send(payload: unknown): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /**
   * Named SSE event used by the OpenAI Responses API (`event: <type>` plus a
   * `data:` JSON line whose `type` field matches). Chat Completions keep
   * using {@link send}, which is data-only.
   */
  sendEvent(event: string, payload: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  sendComment(comment: string): void {
    if (this.closed) return;
    this.res.write(`: ${comment}\n\n`);
  }

  done(): void {
    if (this.closed) return;
    this.res.write("data: [DONE]\n\n");
    this.end();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
