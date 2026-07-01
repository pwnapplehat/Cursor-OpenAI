import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config";
import { HttpError } from "../errors";

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * Resolves which Cursor API key to use for this request and, in "server"
 * mode, gates gateway access behind the optional `AUTH_KEY`.
 *
 * - `passthrough` mode: the client's bearer token *is* the Cursor API key.
 *   There is nothing left to gate with `AUTH_KEY` in this mode, since the
 *   bearer slot is already spent on the Cursor credential.
 * - `server` mode: the Cursor API key always comes from the gateway's own
 *   config. If `AUTH_KEY` is set, the client's bearer token must match it.
 */
export function authMiddleware(config: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const bearer = extractBearerToken(req);

    if (config.cursorKeyMode === "passthrough") {
      if (!bearer) {
        next(
          HttpError.unauthorized(
            "This gateway is running in CURSOR_KEY_MODE=passthrough: send your Cursor API key as " +
              '"Authorization: Bearer <CURSOR_API_KEY>".',
          ),
        );
        return;
      }
      req.cursorApiKey = bearer;
      next();
      return;
    }

    if (config.authKey) {
      if (!bearer || bearer !== config.authKey) {
        next(HttpError.unauthorized("Invalid or missing gateway API key."));
        return;
      }
    }

    req.cursorApiKey = config.cursorApiKey;
    next();
  };
}
