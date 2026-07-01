import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../logger";
import { newRequestId } from "../utils/ids";

export function requestIdMiddleware(rootLogger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header("x-request-id");
    const id = incoming && incoming.trim().length > 0 ? incoming.trim() : newRequestId();
    req.requestId = id;
    req.log = rootLogger.child({ requestId: id });
    res.setHeader("X-Request-Id", id);
    next();
  };
}
