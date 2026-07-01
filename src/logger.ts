import pino from "pino";
import type { AppConfig } from "./config";

export type Logger = pino.Logger;

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "*.authorization",
        "*.apiKey",
        "*.cursorApiKey",
        "*.CURSOR_API_KEY",
        "*.api_key",
      ],
      censor: "[redacted]",
    },
    transport: config.logPretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  });
}

/** Masks a secret for safe logging: keeps a short prefix, hides the rest. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return "(none)";
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 6)}...${secret.slice(-2)} (${secret.length} chars)`;
}
