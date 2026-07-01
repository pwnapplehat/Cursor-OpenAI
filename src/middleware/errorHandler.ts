import type { NextFunction, Request, Response } from "express";
import { mapErrorToResponse } from "../errors";

export function errorHandlerMiddleware() {
  // Express identifies error-handling middleware by arity (4 params) - do not remove unused `next`.
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const mapped = mapErrorToResponse(err);
    const log = req.log ?? console;
    const logPayload = { err, status: mapped.status, retryable: mapped.isRetryable };
    if (mapped.logLevel === "error") {
      log.error(logPayload, "request failed");
    } else {
      log.warn(logPayload, "request rejected");
    }

    if (res.headersSent) {
      // We were mid-stream (SSE). Best effort: terminate the connection.
      res.end();
      return;
    }

    res.status(mapped.status).json(mapped.body);
  };
}

export function notFoundHandler() {
  return (req: Request, res: Response): void => {
    res.status(404).json({
      error: {
        message: `Unknown endpoint: ${req.method} ${req.path}`,
        type: "invalid_request_error",
        code: "not_found",
        param: null,
      },
    });
  };
}
