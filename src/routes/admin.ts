import { Router, type NextFunction, type Request, type Response } from "express";
import { Cursor } from "@cursor/sdk";
import { HttpError, mapErrorToResponse } from "../errors";
import { safeCompare } from "../utils/safeCompare";
import type { GatewayDeps } from "../gateway/orchestrator";
import { executeGatewayTurn, prepareGatewayTurn, rememberGatewayTurn } from "../gateway/orchestrator";
import { ConfigStore } from "../configStore";
import type { ChatCompletionMessage } from "../types/openai";
import type { RunOutcome } from "../cursor/runController";
import { getGatewayVersion } from "../utils/version";
import { formatAddressForUrl, getLanAddresses, isAllInterfacesHost } from "../utils/networkAddresses";
import { SseWriter } from "../utils/sse";

function extractBearer(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
}

/**
 * Throws if the request isn't authorized as admin. Shared by the
 * `requireAdminAuth` middleware and the `/setup` handler (which only needs
 * auth conditionally - once setup is already complete).
 */
function assertAdminAuthorized(configStore: ConfigStore, req: Request): void {
  const authKey = configStore.config.authKey;
  if (!authKey) {
    // The operator explicitly chose "no admin password" during setup; the
    // loopback-only restriction mounted ahead of this router is the
    // remaining safety net in that case.
    return;
  }
  const token = extractBearer(req);
  if (!token || !safeCompare(token, authKey)) {
    throw HttpError.unauthorized("Invalid or missing admin key.");
  }
}

function requireAdminAuth(configStore: ConfigStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      assertAdminAuthorized(configStore, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function createAdminRouter(deps: GatewayDeps, configStore: ConfigStore): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({
      setupComplete: configStore.setupComplete,
      authRequired: Boolean(configStore.config.authKey),
      keyMode: configStore.config.cursorKeyMode,
    });
  });

  router.post("/setup", (req, res, next) => {
    void (async () => {
      try {
        if (configStore.setupComplete) {
          // Re-running setup on an already-configured gateway is treated as
          // a normal config update and requires admin auth like any other
          // change, so a random visitor can't silently take over an
          // existing deployment just by hitting this endpoint.
          assertAdminAuthorized(configStore, req);
        }

        const body = req.body as { cursorApiKey?: unknown; defaultModel?: unknown; generateAuthKey?: unknown };
        if (typeof body.cursorApiKey !== "string" || body.cursorApiKey.trim().length === 0) {
          throw HttpError.badRequest('"cursorApiKey" is required', "cursorApiKey");
        }
        const cursorApiKey = body.cursorApiKey.trim();

        let userEmail: string | undefined;
        let apiKeyName: string | undefined;
        try {
          const me = await Cursor.me({ apiKey: cursorApiKey });
          userEmail = me.userEmail;
          apiKeyName = me.apiKeyName;
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown error";
          throw HttpError.badRequest(`That Cursor API key could not be verified: ${message}`, "cursorApiKey");
        }

        const patch: Record<string, unknown> = { cursorApiKey, cursorKeyMode: "server" };
        if (typeof body.defaultModel === "string" && body.defaultModel.trim().length > 0) {
          patch["defaultModel"] = body.defaultModel.trim();
        }
        await configStore.update(patch);

        let issuedAuthKey: string | null = null;
        if (body.generateAuthKey !== false && !configStore.config.authKey) {
          issuedAuthKey = configStore.generateAuthKey();
        }

        res.json({
          success: true,
          user: { userEmail, apiKeyName },
          authKey: issuedAuthKey,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post("/setup/preview-models", (req, res, next) => {
    void (async () => {
      try {
        if (configStore.setupComplete) {
          assertAdminAuthorized(configStore, req);
        }
        const body = req.body as { cursorApiKey?: unknown };
        if (typeof body.cursorApiKey !== "string" || body.cursorApiKey.trim().length === 0) {
          throw HttpError.badRequest('"cursorApiKey" is required', "cursorApiKey");
        }
        const cursorApiKey = body.cursorApiKey.trim();

        let me;
        try {
          me = await Cursor.me({ apiKey: cursorApiKey });
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown error";
          throw HttpError.badRequest(`That Cursor API key could not be verified: ${message}`, "cursorApiKey");
        }

        const models = await Cursor.models.list({ apiKey: cursorApiKey });
        res.json({ user: { userEmail: me.userEmail, apiKeyName: me.apiKeyName }, models });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post("/login", (req, res, next) => {
    const authKey = configStore.config.authKey;
    if (!authKey) {
      res.json({ ok: true, authRequired: false });
      return;
    }
    const body = req.body as { authKey?: unknown };
    if (typeof body.authKey !== "string" || !safeCompare(body.authKey, authKey)) {
      next(HttpError.unauthorized("Incorrect admin key."));
      return;
    }
    res.json({ ok: true, authRequired: true });
  });

  const admin = Router();
  admin.use(requireAdminAuth(configStore));

  admin.get("/config", (_req, res) => {
    res.json(configStore.redactedSnapshot());
  });

  admin.get("/system", (_req, res) => {
    const { config } = deps;
    const boundToAllInterfaces = isAllInterfacesHost(config.host);
    res.json({
      gatewayVersion: getGatewayVersion(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      processUptimeSeconds: Math.floor(process.uptime()),
      // Off-machine base URLs to share when bound to all interfaces (empty
      // otherwise, since a single/loopback bind isn't reachable elsewhere).
      networkBaseUrls: boundToAllInterfaces
        ? getLanAddresses().map((addr) => `http://${formatAddressForUrl(addr)}:${config.port}/v1`)
        : [],
      // True when reachable off-machine with no AUTH_KEY gating it (server
      // mode) - the dashboard surfaces this as a warning.
      openToNetworkWithoutAuth: boundToAllInterfaces && config.cursorKeyMode === "server" && !config.authKey,
    });
  });

  admin.get("/account", (_req, res, next) => {
    void (async () => {
      try {
        const { config } = deps;
        if (!config.cursorApiKey) {
          res.json({ account: null, note: "No server-side Cursor API key is configured (passthrough mode)." });
          return;
        }
        const me = await Cursor.me({ apiKey: config.cursorApiKey });
        res.json({
          account: {
            apiKeyName: me.apiKeyName,
            userEmail: me.userEmail,
            userFirstName: me.userFirstName,
            userLastName: me.userLastName,
            createdAt: me.createdAt,
          },
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  admin.patch("/config", (req, res, next) => {
    void (async () => {
      try {
        const result = await configStore.update((req.body ?? {}) as Record<string, unknown>);
        res.json({ ...configStore.redactedSnapshot(), restartRequired: result.restart !== "none" });
      } catch (err) {
        next(err);
      }
    })();
  });

  /**
   * Restores settings from a previously exported/downloaded config file (or
   * any partial JSON object of the same shape). Never rejects the whole
   * import over unrecognized/non-editable keys (`cursorWorkdirRoot`,
   * `nodeEnv`, computed fields like `hasCursorApiKey`, etc.) - those are just
   * silently reported back as "ignored" so a full round-trip export -> import
   * always works. A `cursorApiKey` that still looks like a masked value
   * (`"***...1234"`, e.g. from re-importing a *redacted* `/config` response
   * instead of a real `/config/export`) is deliberately skipped too, so it
   * can never clobber the real key with garbage.
   */
  admin.post("/config/import", (req, res, next) => {
    void (async () => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw HttpError.badRequest("Import body must be a JSON object.");
        }

        const patch: Record<string, unknown> = {};
        const applied: string[] = [];
        const ignored: string[] = [];

        for (const [key, value] of Object.entries(body)) {
          if (!ConfigStore.isEditableField(key)) {
            ignored.push(key);
            continue;
          }
          if ((key === "cursorApiKey" || key === "authKey") && typeof value === "string" && /^\*{4,}/.test(value)) {
            ignored.push(`${key} (looks like a masked placeholder, not a real value - skipped so it can't overwrite the real one)`);
            continue;
          }
          patch[key] = value;
          applied.push(key);
        }

        if (Object.keys(patch).length === 0) {
          res.json({ applied, ignored, restartRequired: false, config: configStore.redactedSnapshot() });
          return;
        }

        const result = await configStore.update(patch);
        res.json({ applied, ignored, restartRequired: result.restart !== "none", config: configStore.redactedSnapshot() });
      } catch (err) {
        next(err);
      }
    })();
  });

  /**
   * Fully applies any pending "restart required" changes (e.g. a changed
   * `RATE_LIMIT_WINDOW_MS`) by respawning the process, so nothing on this
   * gateway ever requires a human with shell/console access to actually
   * finish taking effect. Responds before the respawn happens (see
   * `ConfigStore.requestRestart` / `index.ts`) so the caller reliably gets a
   * clean response instead of a connection reset.
   */
  admin.post("/restart", (_req, res) => {
    res.json({ ok: true, message: "Restarting - the gateway will be back within a few seconds." });
    configStore.requestRestart();
  });

  admin.post("/regenerate-auth-key", (_req, res) => {
    const authKey = configStore.generateAuthKey();
    res.json({ authKey });
  });

  admin.post("/clear-auth-key", (_req, res) => {
    configStore.clearAuthKey();
    res.json({ ok: true });
  });

  admin.get("/activity", (_req, res) => {
    const { activityLog } = deps;
    res.json({ entries: activityLog.recent(), stats: activityLog.stats() });
  });

  admin.delete("/activity", (_req, res) => {
    deps.activityLog.clear();
    res.json({ ok: true });
  });

  admin.get("/sessions", (_req, res) => {
    res.json({ sessions: deps.sessionManager.listSessions() });
  });

  admin.delete("/sessions/:id", (req, res, next) => {
    try {
      const id = decodeURIComponent(req.params["id"] ?? "");
      const evicted = deps.sessionManager.evict(id);
      if (!evicted) throw HttpError.notFound(`No cached session with id "${id}"`);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  admin.delete("/sessions", (_req, res) => {
    const count = deps.sessionManager.evictAll();
    res.json({ ok: true, evicted: count });
  });

  admin.get("/config/export", (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="cursor-openai-gateway-settings.json"');
    res.json(configStore.config);
  });

  admin.get("/models", (_req, res, next) => {
    void (async () => {
      try {
        const { config, modelCatalog } = deps;
        if (!config.cursorApiKey) {
          res.json({ models: [], note: "No server-side Cursor API key is configured (passthrough mode) - models depend on each client's own key." });
          return;
        }
        const models = await modelCatalog.list(config.cursorApiKey, true);
        res.json({ models });
      } catch (err) {
        next(err);
      }
    })();
  });

  /**
   * Shared body parsing for both test-chat endpoints below. `sessionId` is
   * caller-supplied (the dashboard generates one per open chat, unique per
   * browser tab; the CLI can pass `--session <id>` for multi-turn, or omit it
   * for a one-off stateless message) - deliberately NOT a hardcoded shared
   * id, which used to mean every dashboard user/tab silently shared the same
   * underlying Cursor conversation.
   */
  function extractChatBody(req: Request, defaultModel: string): { message: string; model: string; sessionId: string | undefined } {
    const body = req.body as { message?: unknown; model?: unknown; sessionId?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      throw HttpError.badRequest('"message" is required', "message");
    }
    const model = typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : defaultModel;
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim().length > 0 ? body.sessionId.trim() : undefined;
    return { message: body.message, model, sessionId };
  }

  admin.post("/test-chat", (req, res, next) => {
    void (async () => {
      try {
        const { config } = deps;
        if (!config.cursorApiKey) {
          throw HttpError.badRequest(
            "Test chat needs a server-side Cursor API key. This gateway is in passthrough mode, so there is no key to test with here.",
          );
        }
        const { message, model, sessionId } = extractChatBody(req, config.defaultModel);
        const rawMessages: ChatCompletionMessage[] = [{ role: "user", content: message }];

        const prepared = await prepareGatewayTurn(deps, {
          apiKey: config.cursorApiKey,
          endpoint: "/api/admin/test-chat",
          requestedModelId: model,
          rawMessages,
          tools: undefined,
          metadata: sessionId ? { session_id: sessionId } : undefined,
          requestId: req.requestId,
        });

        let outcome: RunOutcome;
        try {
          outcome = await executeGatewayTurn(deps, prepared, { sink: undefined, abortSignal: undefined, streaming: false });
        } finally {
          prepared.releaseSemaphore();
        }

        if (outcome.finishReason !== "cancelled") {
          rememberGatewayTurn(deps, prepared, outcome);
        }

        res.json({
          content: outcome.content,
          reasoningContent: outcome.reasoningContent,
          model: outcome.model?.id ?? model,
          usage: outcome.usage,
          agentId: outcome.agentId,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  /** Streaming (SSE) sibling of `/test-chat`, powering the dashboard's live-typing chat UI. Frame shapes: `{type:"text"|"reasoning", delta}`, `{type:"done", model, usage, agentId, finishReason}`, `{type:"error", message}`. */
  admin.post("/test-chat/stream", (req, res, next) => {
    void (async () => {
      try {
        const { config } = deps;
        if (!config.cursorApiKey) {
          throw HttpError.badRequest(
            "Test chat needs a server-side Cursor API key. This gateway is in passthrough mode, so there is no key to test with here.",
          );
        }
        const { message, model, sessionId } = extractChatBody(req, config.defaultModel);
        const rawMessages: ChatCompletionMessage[] = [{ role: "user", content: message }];

        const prepared = await prepareGatewayTurn(deps, {
          apiKey: config.cursorApiKey,
          endpoint: "/api/admin/test-chat",
          requestedModelId: model,
          rawMessages,
          tools: undefined,
          metadata: sessionId ? { session_id: sessionId } : undefined,
          requestId: req.requestId,
        });

        const abortController = new AbortController();
        req.on("close", () => {
          if (!res.writableEnded) abortController.abort();
        });

        const sse = new SseWriter(res);
        try {
          const outcome = await executeGatewayTurn(deps, prepared, {
            abortSignal: abortController.signal,
            streaming: true,
            sink: {
              onTextDelta: (delta) => sse.send({ type: "text", delta }),
              onReasoningDelta: (delta) => sse.send({ type: "reasoning", delta }),
            },
          });

          if (outcome.finishReason !== "cancelled") {
            rememberGatewayTurn(deps, prepared, outcome);
          }

          if (!sse.isClosed) {
            sse.send({ type: "done", model: outcome.model?.id ?? model, usage: outcome.usage, agentId: outcome.agentId, finishReason: outcome.finishReason });
            sse.done();
          }
        } catch (err) {
          prepared.log.error({ err }, "streaming admin test-chat failed mid-run");
          if (!sse.isClosed) {
            const mapped = mapErrorToResponse(err);
            sse.send({ type: "error", message: mapped.body.error.message });
            sse.done();
          }
        } finally {
          prepared.releaseSemaphore();
        }
      } catch (err) {
        next(err);
      }
    })();
  });

  router.use(admin);

  return router;
}
