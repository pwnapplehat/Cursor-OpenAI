import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import type { Logger } from "./logger";
import type { ConfigStore } from "./configStore";
import { ModelCatalog } from "./cursor/modelCatalog";
import { SessionManager } from "./cursor/sessionManager";
import { Semaphore } from "./utils/concurrency";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";
import { buildRateLimiter } from "./middleware/rateLimiter";
import { loopbackOnlyMiddleware } from "./middleware/loopbackOnly";
import { errorHandlerMiddleware, notFoundHandler } from "./middleware/errorHandler";
import { createChatCompletionsRouter } from "./routes/chatCompletions";
import { createLegacyCompletionsRouter } from "./routes/completionsLegacy";
import { createModelsRouter } from "./routes/models";
import { createEmbeddingsRouter } from "./routes/embeddings";
import { createHealthRouter } from "./routes/health";
import { createAdminRouter } from "./routes/admin";
import type { GatewayDeps } from "./gateway/orchestrator";
import { ActivityLog } from "./observability/activityLog";

export interface AppInstance {
  app: Express;
  sessionManager: SessionManager;
}

const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function buildApp(configStore: ConfigStore, log: Logger): AppInstance {
  const config = configStore.config;
  const app = express();
  app.disable("x-powered-by");

  const modelCatalog = new ModelCatalog(log);
  const sessionManager = new SessionManager(config, log);
  const semaphore = new Semaphore(config.maxConcurrentRuns);
  const activityLog = new ActivityLog();
  const deps: GatewayDeps = { config, log, modelCatalog, sessionManager, semaphore, activityLog };

  app.use(
    helmet({
      // This process also serves the small admin dashboard (Tailwind via
      // CDN, a handful of inline SVGs) alongside the JSON API. A strict CSP
      // would need `unsafe-inline`/a CDN allowlist anyway to support that,
      // which makes a "strict" policy mostly theatrical here - disabled
      // rather than shipping a CSP that looks safer than it is.
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      // Reads `corsOrigin` fresh on every request (not just once at startup)
      // so changing it from the admin dashboard takes effect immediately.
      origin: (requestOrigin, callback) => {
        const allowed = config.corsOrigin;
        if (allowed === "*" || !requestOrigin) {
          callback(null, true);
          return;
        }
        const allowedList = allowed.split(",").map((origin) => origin.trim());
        callback(null, allowedList.includes(requestOrigin));
      },
    }),
  );
  app.use(express.json({ limit: "25mb" }));
  app.use(requestIdMiddleware(log));
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  // The admin dashboard's static assets (index.html, app.js, styles.css).
  // express.static serves `public/index.html` for `GET /` automatically.
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

  app.get("/api/info", (_req, res) => {
    res.json({
      name: "cursor-openai-gateway",
      description: "OpenAI-compatible API gateway backed by the Cursor Agent SDK.",
      dashboard: "/",
      endpoints: ["/health", "/v1/chat/completions", "/v1/completions", "/v1/models", "/v1/models/:id", "/v1/embeddings"],
    });
  });

  app.use(createHealthRouter(config, sessionManager, semaphore));
  app.use("/api/admin", loopbackOnlyMiddleware(config), createAdminRouter(deps, configStore));

  const v1Router = express.Router();
  v1Router.use(buildRateLimiter(config));
  v1Router.use(authMiddleware(config));
  v1Router.use(createChatCompletionsRouter(deps));
  v1Router.use(createLegacyCompletionsRouter(deps));
  v1Router.use(createModelsRouter(modelCatalog));
  v1Router.use(createEmbeddingsRouter());
  app.use(v1Router);

  app.use(notFoundHandler());
  app.use(errorHandlerMiddleware());

  return { app, sessionManager };
}
