import rateLimit from "express-rate-limit";
import type { AppConfig } from "../config";

export function buildRateLimiter(config: AppConfig) {
  return rateLimit({
    // windowMs is fixed for the lifetime of this middleware instance (an
    // express-rate-limit constraint - only `limit` supports a per-request
    // function). Changing RATE_LIMIT_WINDOW_MS from the admin dashboard is
    // persisted immediately but needs a restart to take effect; the request
    // ceiling itself (`limit`) is read live on every request.
    windowMs: config.rateLimitWindowMs,
    limit: () => config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.cursorApiKey ?? req.ip ?? "anonymous",
    message: {
      error: {
        message: "Rate limit exceeded. Slow down and try again shortly.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        param: null,
      },
    },
  });
}
