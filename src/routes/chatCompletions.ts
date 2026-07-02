import { Router, type Request, type Response } from "express";
import type { GatewayDeps } from "../gateway/orchestrator";
import { executeGatewayTurn, isHeldOpen, prepareGatewayTurn, rememberGatewayTurn } from "../gateway/orchestrator";
import { validateChatCompletionRequest } from "../validation";
import { HttpError, mapErrorToResponse } from "../errors";
import { SseWriter } from "../utils/sse";
import { newChatCompletionId } from "../utils/ids";
import {
  buildChatCompletionResponse,
  buildDeltaChunk,
  buildFinalChunk,
  buildRoleChunk,
  buildToolCallArgumentsChunk,
  buildToolCallStartChunk,
} from "../translate/responseTranslator";
import { stringifyContent } from "../translate/requestTranslator";
import type { RunOutcome } from "../cursor/runController";

export function createChatCompletionsRouter(deps: GatewayDeps): Router {
  const router = Router();

  router.post("/v1/chat/completions", (req, res, next) => {
    void handleChatCompletion(deps, req, res).catch(next);
  });

  return router;
}

async function handleChatCompletion(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
  const body = validateChatCompletionRequest(req.body);

  const prepared = await prepareGatewayTurn(deps, {
    apiKey: req.cursorApiKey,
    endpoint: "/v1/chat/completions",
    requestedModelId: body.model,
    rawMessages: body.messages,
    tools: body.tools,
    metadata: body.metadata,
    requestId: req.requestId,
  });

  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const promptEstimateText = body.messages.map((m) => stringifyContent(m.content)).join("\n");
  const includeUsage = body.stream_options?.include_usage === true;

  if (body.stream) {
    const id = newChatCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const sse = new SseWriter(res);
    sse.send(buildRoleChunk(id, created, prepared.resolvedModelId));

    let heldOpen = false;
    let toolCallIndex = 0;
    try {
      const outcome = await executeGatewayTurn(deps, prepared, {
        abortSignal: abortController.signal,
        streaming: true,
        sink: {
          onTextDelta: (delta) => {
            sse.send(buildDeltaChunk(id, created, prepared.resolvedModelId, { content: delta }));
          },
          onReasoningDelta: (delta) => {
            sse.send(buildDeltaChunk(id, created, prepared.resolvedModelId, { reasoning_content: delta }));
          },
          onToolCallStarted: (call) => {
            const index = toolCallIndex;
            toolCallIndex += 1;
            sse.send(buildToolCallStartChunk(id, created, prepared.resolvedModelId, call.id, call.name, index));
            sse.send(buildToolCallArgumentsChunk(id, created, prepared.resolvedModelId, call.argumentsJson, index));
          },
        },
      });

      heldOpen = isHeldOpen(prepared, outcome);

      if (!sse.isClosed) {
        sse.send(buildFinalChunk(id, created, prepared.resolvedModelId, outcome, includeUsage, promptEstimateText));
        sse.done();
      }

      if (outcome.finishReason !== "cancelled") {
        rememberGatewayTurn(deps, prepared, outcome);
      }
    } catch (err) {
      prepared.log.error({ err }, "streaming chat completion failed mid-run");
      if (!sse.isClosed) {
        const mapped = mapErrorToResponse(err);
        sse.send(mapped.body);
        sse.done();
      }
    } finally {
      // When the run is held open awaiting tool results, the held-run manager
      // owns the concurrency slot until the run completes - releasing here
      // would free it while the run is still alive.
      if (!heldOpen) prepared.releaseSemaphore();
    }
    return;
  }

  let outcome: RunOutcome;
  let heldOpen = false;
  try {
    outcome = await executeGatewayTurn(deps, prepared, { abortSignal: abortController.signal, sink: undefined, streaming: false });
    heldOpen = isHeldOpen(prepared, outcome);
  } catch (err) {
    prepared.releaseSemaphore();
    throw err;
  }
  if (!heldOpen) prepared.releaseSemaphore();

  const response = buildChatCompletionResponse({
    id: newChatCompletionId(),
    outcome,
    requestedModel: prepared.requestedModelId,
    promptTextForEstimate: promptEstimateText,
    includeReasoning: deps.config.includeThinking,
  });

  if (outcome.finishReason !== "cancelled") {
    rememberGatewayTurn(deps, prepared, outcome);
  }

  res.json(response);
}
