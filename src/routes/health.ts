import { Router } from "express";
import type { SessionManager } from "../cursor/sessionManager";
import type { HeldRunManager } from "../cursor/heldRunManager";
import type { Semaphore } from "../utils/concurrency";
import type { AppConfig } from "../config";

const startedAt = Date.now();

export function createHealthRouter(
  config: AppConfig,
  sessionManager: SessionManager,
  semaphore: Semaphore,
  heldRunManager: HeldRunManager,
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      runtime: config.cursorRuntime,
      keyMode: config.cursorKeyMode,
      sessions: sessionManager.stats(),
      concurrency: { inUse: semaphore.inUse, queued: semaphore.queued },
      // Runs kept alive awaiting client tool results (hold-mode tool bridge).
      heldRuns: heldRunManager.heldCount,
    });
  });

  return router;
}
