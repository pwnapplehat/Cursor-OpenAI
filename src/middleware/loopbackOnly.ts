import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config";
import { HttpError } from "../errors";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Headers a reverse proxy / tunnel adds when it forwards a request on behalf
 * of a remote client. Their mere presence means the request did NOT originate
 * on this machine, even if the socket peer looks like loopback.
 */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
];

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK_ADDRESSES.has(ip);
}

/**
 * Whether the request arrived through a proxy/tunnel (cloudflared, ngrok,
 * nginx, ...). Such tools run on this machine and connect to the gateway over
 * loopback, so `socket.remoteAddress` becomes `127.0.0.1` - which would
 * otherwise let a public tunnel expose the admin API despite the loopback
 * guard. `trust proxy` is intentionally left OFF (so `req.ip` stays the real,
 * unspoofable socket peer); we inspect the forwarding headers directly rather
 * than trusting them for the client IP.
 */
function arrivedViaProxy(req: Request): boolean {
  const headers = req.headers ?? {};
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * Restricts the admin API/UI to genuinely local requests by default,
 * independent of `AUTH_KEY`. This exists so that binding `HOST=0.0.0.0` to
 * make the OpenAI endpoints reachable on a LAN doesn't also expose
 * configuration (credentials, model routing, concurrency limits) to anyone on
 * that network unless they deliberately opt in with `ADMIN_ALLOW_REMOTE=true`.
 *
 * "Genuinely local" means both: the socket peer is loopback AND the request
 * did not arrive via a proxy/tunnel. Without the second condition, running a
 * tunnel (cloudflared/ngrok) that terminates locally would make every public
 * request look like `127.0.0.1` and silently defeat this guard - the exact
 * footgun someone exposing the gateway to the internet would hit.
 */
export function loopbackOnlyMiddleware(config: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (config.adminAllowRemote) {
      next();
      return;
    }
    const socketIsLoopback = isLoopback(req.ip) || isLoopback(req.socket.remoteAddress);
    if (socketIsLoopback && !arrivedViaProxy(req)) {
      next();
      return;
    }
    next(
      HttpError.unauthorized(
        "The admin dashboard is only reachable directly from this machine by default. Requests forwarded " +
          "through a tunnel or reverse proxy are refused even if they arrive over loopback. Set " +
          "ADMIN_ALLOW_REMOTE=true if you understand the risk and need remote admin access.",
      ),
    );
  };
}
