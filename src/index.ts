import { Cursor } from "@cursor/sdk";
import { loadConfig, ConfigError } from "./config";
import { createLogger, maskSecret } from "./logger";
import { buildApp } from "./server";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config);
  log.info(
    {
      runtime: config.cursorRuntime,
      keyMode: config.cursorKeyMode,
      defaultModel: config.defaultModel,
      cursorApiKey: config.cursorApiKey ? maskSecret(config.cursorApiKey) : "(passthrough mode)",
      sessionsEnabled: config.sessionsEnabled,
      autoSessionEnabled: config.autoSessionEnabled,
      toolBridgeEnabled: config.toolBridgeEnabled,
      maxConcurrentRuns: config.maxConcurrentRuns,
      maxCachedAgents: config.maxCachedAgents,
    },
    "starting cursor-openai-gateway",
  );

  if (config.cursorKeyMode === "server" && config.cursorApiKey) {
    try {
      const me = await Cursor.me({ apiKey: config.cursorApiKey });
      log.info({ apiKeyName: me.apiKeyName, userEmail: me.userEmail }, "verified Cursor API key on startup");
    } catch (err) {
      log.error(
        { err },
        "failed to verify CURSOR_API_KEY against the Cursor API on startup - check the key and your network " +
          "connection. Continuing to start anyway; requests will fail until this is fixed.",
      );
    }
  }

  const { app, sessionManager } = buildApp(config, log);

  const server = app.listen(config.port, config.host, () => {
    log.info({ host: config.host, port: config.port }, "cursor-openai-gateway listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    server.close(() => {
      sessionManager.shutdown();
      log.info("shutdown complete");
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs (e.g. a stuck local agent process).
    setTimeout(() => {
      log.warn("graceful shutdown timed out, forcing exit");
      sessionManager.shutdown();
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    log.error({ err }, "uncaught exception");
  });
}

main().catch((err: unknown) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
