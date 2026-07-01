import rateLimit from "express-rate-limit";
import type { AppConfig } from "../config";

export function buildRateLimiter(config: AppConfig) {
  return rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
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
