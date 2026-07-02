import { spawn } from "node:child_process";
import { Cursor } from "@cursor/sdk";
import { loadConfig, ConfigError } from "./config";
import { ConfigStore } from "./configStore";
import { createLogger, maskSecret } from "./logger";
import { buildApp } from "./server";
import { openBrowser } from "./utils/openBrowser";
import { listenOnce, listenWithPortFallback } from "./utils/findAvailablePort";
import { formatAddressForUrl, getLanAddresses, isAllInterfacesHost } from "./utils/networkAddresses";

function dashboardUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${displayHost}:${port}`;
}

/**
 * When bound to all interfaces, tells the user the exact URLs other devices
 * on their network can point an OpenAI client at, and warns loudly if the
 * gateway is reachable off-machine with no `AUTH_KEY` gating it (server mode
 * only - in passthrough mode each client supplies its own Cursor key, so
 * there is no owner-plan-burning exposure to warn about).
 */
function reportNetworkReachability(config: ReturnType<typeof loadConfig>, port: number, log: ReturnType<typeof createLogger>): void {
  if (!isAllInterfacesHost(config.host)) return;

  const addresses = getLanAddresses();
  if (addresses.length > 0) {
    log.info(
      {
        urls: addresses.map((addr) => ({
          iface: addr.iface,
          baseUrl: `http://${formatAddressForUrl(addr)}:${port}/v1`,
        })),
      },
      "reachable from other devices on your network - point an OpenAI client's base_url at one of these",
    );
  }

  if (config.cursorKeyMode === "server" && !config.authKey) {
    log.warn(
      { host: config.host, port },
      "SECURITY: bound to all network interfaces with no AUTH_KEY set. Any device that can reach this port " +
        "can use your Cursor plan with no authentication. Set AUTH_KEY (env, or the dashboard's Security tab) " +
        "to require a bearer token, or bind HOST=127.0.0.1 to keep it local-only.",
    );
  }
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

  const { app, sessionManager, heldRunManager } = buildApp(configStore, log);

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

  reportNetworkReachability(config, actualPort, log);

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

  // Only for interactive starts (start.bat/start.sh/npm start in a real
  // terminal). When stdout isn't a TTY the process was launched by
  // something unattended - the autostart toolkit's hidden logon launcher,
  // systemd, launchd, cron, Docker, CI - and popping a browser tab at
  // every boot/crash-restart would be wrong there. The TTY check has to
  // live here (not just in launcher env vars) because settings.json
  // persists autoOpenBrowser back over the environment once the dashboard
  // has been used, so an env-only override can't cover that case.
  if (config.autoOpenBrowser && process.stdout.isTTY) {
    openBrowser(dashboardUrl(config.host, actualPort), log);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    heldRunManager.shutdown();
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

  configStore.onRestartRequested(() => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("restart requested via admin dashboard/CLI - respawning the process");
    // A short delay so the HTTP response for the request that triggered
    // this (POST /api/admin/restart) has actually flushed to the client
    // before we start tearing anything down - otherwise that caller would
    // see a connection reset instead of the "restarting" confirmation.
    setTimeout(() => {
      // `process.argv.slice(1)` reproduces exactly however this process was
      // originally launched (`node dist/index.js`, `tsx watch src/index.ts`,
      // etc.) - whatever it is, respawning it is correct, since it's just
      // "run this same command again". `detached: true` + `unref()` lets the
      // child outlive this process once it exits below, and `stdio:
      // "inherit"` keeps its logs going to the same console/log file this
      // process was using.
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();
      heldRunManager.shutdown();
      // Deliberately not awaiting server.close()'s drain callback (same
      // reasoning as the port/host rebind above): the process is about to
      // exit outright, which releases the listening socket immediately at
      // the OS level - no need to wait for in-flight keep-alive connections
      // to idle out first.
      server.close();
      sessionManager.shutdown();
      process.exit(0);
    }, 300);
  });

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
