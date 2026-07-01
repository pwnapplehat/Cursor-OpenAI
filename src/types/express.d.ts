import type { Logger } from "../logger";

declare global {
  namespace Express {
    interface Request {
      /** Resolved per-request Cursor API key (server-mode config value, or the client's bearer token in passthrough mode). */
      cursorApiKey?: string;
      /** Unique id assigned to this request, echoed back as `X-Request-Id` and included in all log lines for it. */
      requestId: string;
      /** Request-scoped child logger, pre-bound with `requestId`. */
      log: Logger;
    }
  }
}

export {};
