import {
  AgentBusyError,
  AgentNotFoundError,
  AuthenticationError,
  ConfigurationError,
  CursorAgentError,
  CursorSdkError,
  NetworkError,
  RateLimitError,
  UnknownAgentError,
} from "@cursor/sdk";
import type { OpenAIErrorBody } from "./types/openai";

/** Gateway-level HTTP error (request validation, auth, routing) with an OpenAI-shaped body. */
export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;

  constructor(status: number, message: string, options?: { type?: string; code?: string | null; param?: string | null }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = options?.type ?? "invalid_request_error";
    this.code = options?.code ?? null;
    this.param = options?.param ?? null;
  }

  static badRequest(message: string, param?: string): HttpError {
    return new HttpError(400, message, { type: "invalid_request_error", param: param ?? null });
  }

  static unauthorized(message: string): HttpError {
    return new HttpError(401, message, { type: "invalid_request_error", code: "invalid_api_key" });
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, message, { type: "invalid_request_error", code: "not_found" });
  }

  static notImplemented(message: string): HttpError {
    return new HttpError(501, message, { type: "invalid_request_error", code: "not_implemented" });
  }

  static tooManyRequests(message: string): HttpError {
    return new HttpError(429, message, { type: "rate_limit_error", code: "rate_limit_exceeded" });
  }

  static internal(message: string): HttpError {
    return new HttpError(500, message, { type: "server_error" });
  }

  static timeout(message: string): HttpError {
    return new HttpError(504, message, { type: "server_error", code: "timeout" });
  }
}

interface MappedError {
  status: number;
  body: OpenAIErrorBody;
  isRetryable?: boolean;
  logLevel: "warn" | "error";
}

function defaultStatusForCursorError(err: CursorSdkError): number {
  if (typeof err.status === "number") return err.status;
  if (err instanceof AuthenticationError) return 401;
  if (err instanceof RateLimitError) return 429;
  if (err instanceof AgentBusyError) return 409;
  if (err instanceof AgentNotFoundError) return 404;
  if (err instanceof ConfigurationError) return 400;
  if (err instanceof NetworkError) return 503;
  if (err instanceof UnknownAgentError) return 500;
  if (err instanceof CursorAgentError) return 500;
  return 500;
}

function typeForCursorError(err: CursorSdkError): string {
  if (err instanceof AuthenticationError) return "invalid_request_error";
  if (err instanceof RateLimitError) return "rate_limit_error";
  if (err instanceof ConfigurationError) return "invalid_request_error";
  if (err instanceof AgentNotFoundError) return "invalid_request_error";
  return "server_error";
}

/**
 * Detects Express body-parser / `http-errors`-style client errors (a 4xx
 * `status` plus `expose: true`, the http-errors convention for "this message
 * is safe to send to the client"). The critical case is the JSON body limit:
 * `express.json({ limit })` rejects an oversized request with a 413
 * PayloadTooLargeError ("request entity too large"). Without this branch it
 * fell through to the generic 500 - and clients with dedicated 413 recovery
 * (Hermes compresses its history and downgrades old screenshots to text,
 * then retries) never triggered it, so long vision-heavy sessions died on a
 * blind 500-retry loop instead of self-healing.
 */
function asExposedClientError(err: unknown): { status: number; message: string; code: string | null } | undefined {
  if (!(err instanceof Error)) return undefined;
  const candidate = err as Error & { status?: unknown; statusCode?: unknown; expose?: unknown; type?: unknown };
  const status = typeof candidate.status === "number" ? candidate.status : typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
  if (status === undefined || status < 400 || status >= 500 || candidate.expose !== true) return undefined;
  // body-parser sets `type` to a dotted identifier (e.g. "entity.too.large").
  const code = typeof candidate.type === "string" && candidate.type.length > 0 ? candidate.type.replace(/\./g, "_") : null;
  return { status, message: err.message, code };
}

/** Maps any thrown error (gateway or Cursor SDK) into an HTTP status + OpenAI-shaped error body. */
export function mapErrorToResponse(err: unknown): MappedError {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { message: err.message, type: err.type, param: err.param, code: err.code } },
      logLevel: err.status >= 500 ? "error" : "warn",
    };
  }

  if (err instanceof CursorSdkError) {
    const status = defaultStatusForCursorError(err);
    return {
      status,
      body: {
        error: {
          message: err.message,
          type: typeForCursorError(err),
          code: err.code ?? err.constructor.name,
          param: null,
        },
      },
      isRetryable: err.isRetryable,
      logLevel: status >= 500 ? "error" : "warn",
    };
  }

  const clientError = asExposedClientError(err);
  if (clientError) {
    return {
      status: clientError.status,
      body: { error: { message: clientError.message, type: "invalid_request_error", code: clientError.code, param: null } },
      logLevel: "warn",
    };
  }

  if (err instanceof Error) {
    return {
      status: 500,
      body: { error: { message: err.message, type: "server_error", code: null, param: null } },
      logLevel: "error",
    };
  }

  return {
    status: 500,
    body: { error: { message: "An unknown error occurred.", type: "server_error", code: null, param: null } },
    logLevel: "error",
  };
}
