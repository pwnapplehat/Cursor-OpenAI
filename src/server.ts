import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import type { AppConfig } from "./config";
import type { Logger } from "./logger";
import { ModelCatalog } from "./cursor/modelCatalog";
import { SessionManager } from "./cursor/sessionManager";
import { Semaphore } from "./utils/concurrency";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";
import { buildRateLimiter } from "./middleware/rateLimiter";
import { errorHandlerMiddleware, notFoundHandler } from "./middleware/errorHandler";
import { createChatCompletionsRouter } from "./routes/chatCompletions";
import { createLegacyCompletionsRouter } from "./routes/completionsLegacy";
import { createModelsRouter } from "./routes/models";
import { createEmbeddingsRouter } from "./routes/embeddings";
import { createHealthRouter } from "./routes/health";
import type { GatewayDeps } from "./gateway/orchestrator";

export interface AppInstance {
  app: Express;
  sessionManager: SessionManager;
}

export function buildApp(config: AppConfig, log: Logger): AppInstance {
  const app = express();
  app.disable("x-powered-by");

  const modelCatalog = new ModelCatalog(log);
  const sessionManager = new SessionManager(config, log);
  const semaphore = new Semaphore(config.maxConcurrentRuns);
  const deps: GatewayDeps = { config, log, modelCatalog, sessionManager, semaphore };

  app.use(
    helmet({
      // This is an API server with no browser-rendered HTML, so a strict CSP
      // would only add noise; disable it rather than ship a meaningless one.
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((origin) => origin.trim()),
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

  app.get("/", (_req, res) => {
    res.json({
      name: "cursor-openai-gateway",
      description: "OpenAI-compatible API gateway backed by the Cursor Agent SDK.",
      endpoints: ["/health", "/v1/chat/completions", "/v1/completions", "/v1/models", "/v1/models/:id", "/v1/embeddings"],
    });
  });
  app.use(createHealthRouter(config, sessionManager, semaphore));

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
