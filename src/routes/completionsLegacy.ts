import { Router, type Request, type Response } from "express";
import type { GatewayDeps } from "../gateway/orchestrator";
import { executeGatewayTurn, prepareGatewayTurn, rememberGatewayTurn } from "../gateway/orchestrator";
import { validateCompletionRequest } from "../validation";
import { HttpError, mapErrorToResponse } from "../errors";
import { SseWriter } from "../utils/sse";
import { newCompletionId } from "../utils/ids";
import { toOpenAIUsage } from "../translate/usage";
import type { ChatCompletionMessage, CompletionChoice, CompletionResponse } from "../types/openai";
import type { RunOutcome } from "../cursor/runController";

/**
 * Legacy `/v1/completions` endpoint (text-in, text-out). Implemented as a
 * thin adapter over the chat pipeline: the prompt becomes a single user
 * message and the resulting assistant text becomes `choices[0].text`. Kept
 * for older clients/libraries that never migrated to chat completions.
 */
export function createLegacyCompletionsRouter(deps: GatewayDeps): Router {
  const router = Router();

  router.post("/v1/completions", (req, res, next) => {
    void handleCompletion(deps, req, res).catch(next);
  });

  return router;
}

async function handleCompletion(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
  const body = validateCompletionRequest(req.body);
  const promptText = Array.isArray(body.prompt) ? body.prompt.join("\n") : body.prompt;

  const messages: ChatCompletionMessage[] = [{ role: "user", content: promptText }];

  const prepared = await prepareGatewayTurn(deps, {
    apiKey: req.cursorApiKey,
    endpoint: "/v1/completions",
    requestedModelId: body.model,
    rawMessages: messages,
    tools: undefined,
    metadata: body.metadata,
    requestId: req.requestId,
  });

  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  if (body.stream) {
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const sse = new SseWriter(res);

    try {
      const outcome = await executeGatewayTurn(deps, prepared, {
        abortSignal: abortController.signal,
        streaming: true,
        sink: {
          onTextDelta: (delta) => {
            sse.send(buildLegacyChunk(id, created, prepared.resolvedModelId, delta, null));
          },
        },
      });

      if (!sse.isClosed) {
        sse.send(buildLegacyChunk(id, created, prepared.resolvedModelId, "", "stop"));
        sse.done();
      }
      if (outcome.finishReason !== "cancelled") rememberGatewayTurn(deps, prepared, outcome);
    } catch (err) {
      prepared.log.error({ err }, "streaming legacy completion failed mid-run");
      if (!sse.isClosed) {
        const mapped = mapErrorToResponse(err);
        sse.send(mapped.body);
        sse.done();
      }
    } finally {
      prepared.releaseSemaphore();
    }
    return;
  }

  let outcome: RunOutcome;
  try {
    outcome = await executeGatewayTurn(deps, prepared, { abortSignal: abortController.signal, sink: undefined, streaming: false });
  } finally {
    prepared.releaseSemaphore();
  }

  if (outcome.finishReason !== "cancelled") rememberGatewayTurn(deps, prepared, outcome);

  const response: CompletionResponse = {
    id: newCompletionId(),
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: outcome.model?.id ?? prepared.requestedModelId,
    choices: [{ index: 0, text: outcome.content, finish_reason: "stop", logprobs: null }],
    usage: toOpenAIUsage(outcome.usage, promptText, outcome.content),
  };
  res.json(response);
}

function buildLegacyChunk(id: string, created: number, model: string, text: string, finishReason: CompletionChoice["finish_reason"]) {
  return {
    id,
    object: "text_completion" as const,
    created,
    model,
    choices: [{ index: 0, text, finish_reason: finishReason, logprobs: null }],
  };
}
