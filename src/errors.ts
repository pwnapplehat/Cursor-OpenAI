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
