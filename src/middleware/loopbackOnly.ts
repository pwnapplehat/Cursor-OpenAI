import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config";
import { HttpError } from "../errors";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK_ADDRESSES.has(ip);
}

/**
 * Restricts the admin API/UI to loopback requests by default, independent of
 * `AUTH_KEY`. This exists so that binding `HOST=0.0.0.0` to make the OpenAI
 * endpoints reachable on a LAN doesn't also expose configuration
 * (credentials, model routing, concurrency limits) to anyone on that network
 * unless they deliberately opt in with `ADMIN_ALLOW_REMOTE=true`.
 */
export function loopbackOnlyMiddleware(config: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (config.adminAllowRemote) {
      next();
      return;
    }
    if (isLoopback(req.ip) || isLoopback(req.socket.remoteAddress)) {
      next();
      return;
    }
    next(
      HttpError.unauthorized(
        "The admin dashboard is only reachable from this machine by default. Set ADMIN_ALLOW_REMOTE=true if you " +
          "understand the risk and need remote access.",
      ),
    );
  };
}
