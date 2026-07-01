import { Cursor } from "@cursor/sdk";
import { loadConfig, ConfigError } from "./config";
import { ConfigStore } from "./configStore";
import { createLogger, maskSecret } from "./logger";
import { buildApp } from "./server";
import { openBrowser } from "./utils/openBrowser";
import { listenOnce, listenWithPortFallback } from "./utils/findAvailablePort";

function dashboardUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${displayHost}:${port}`;
}

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
  const configStore = new ConfigStore(config, log);

  log.info(
    {
      runtime: config.cursorRuntime,
      keyMode: config.cursorKeyMode,
      defaultModel: config.defaultModel,
      cursorApiKey: config.cursorApiKey ? maskSecret(config.cursorApiKey) : "(not configured yet)",
      sessionsEnabled: config.sessionsEnabled,
      autoSessionEnabled: config.autoSessionEnabled,
      toolBridgeEnabled: config.toolBridgeEnabled,
      maxConcurrentRuns: config.maxConcurrentRuns,
      maxCachedAgents: config.maxCachedAgents,
    },
    "starting cursor-openai-gateway",
  );

  if (configStore.setupComplete && config.cursorKeyMode === "server" && config.cursorApiKey) {
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

  const { app, sessionManager } = buildApp(configStore, log);

  // Only the initial boot silently tries nearby ports if the configured one
  // is busy - an explicit port change from the admin dashboard (below) is a
  // deliberate user choice and should fail clearly instead, not surprise
  // them with a different port than the one they asked for.
  const { server: initialServer, port: actualPort } = await listenWithPortFallback(app, config.port, config.host, log);
  let server = initialServer;
  if (actualPort !== config.port) {
    // Reflects reality for the dashboard/logs/openBrowser. Deliberately not
    // persisted to settings.json - the next boot tries the originally
    // configured port again first, so this doesn't "stick" once whatever
    // was squatting on it is gone.
    configStore.config.port = actualPort;
  }
  log.info({ host: config.host, port: actualPort, dashboard: dashboardUrl(config.host, actualPort) }, "cursor-openai-gateway listening");

  if (!configStore.setupComplete) {
    log.warn(
      { dashboard: dashboardUrl(config.host, actualPort) },
      "no Cursor API key configured yet - open the dashboard above to finish setup (or set CURSOR_API_KEY in .env for a headless deployment)",
    );
  }

  configStore.onServerRebindNeeded(async (newPort, newHost) => {
    log.info({ newPort, newHost }, "rebinding HTTP server after a port/host change from the admin dashboard");
    const newServer = await listenOnce(app, newPort, newHost);
    const oldServer = server;
    server = newServer;
    // Deliberately not awaited: the request that triggered this rebind (the
    // PATCH /api/admin/config call itself) is still being served by
    // `oldServer` and hasn't sent its response yet - `close()`'s callback
    // only fires once every open connection ends, so awaiting it here would
    // deadlock waiting for a response that can only be sent once this
    // handler (and the update() call it's inside) returns. Let it drain in
    // the background instead.
    oldServer.close((err) => {
      if (err) log.warn({ err }, "error while closing the previous HTTP server after a rebind");
      else log.debug("previous HTTP server closed after rebind");
    });
    log.info({ newPort, newHost }, "HTTP server rebind complete (new listener is up; old one is draining in the background)");
  });

  if (config.autoOpenBrowser) {
    openBrowser(dashboardUrl(config.host, actualPort), log);
  }

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
