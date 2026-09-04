import { Router, type Request, type Response } from "express";
import type { GatewayDeps } from "../gateway/orchestrator";
import { executeGatewayTurn, isHeldOpen, prepareGatewayTurn, rememberGatewayTurn } from "../gateway/orchestrator";
import { validateResponsesRequest } from "../validation";
import { HttpError, mapErrorToResponse } from "../errors";
import { SseWriter } from "../utils/sse";
import { newFunctionCallItemId, newMessageId, newResponseId } from "../utils/ids";
import {
  assistantMessageFromOutcome,
  buildResponsesObject,
  responsesInputToMessages,
  responsesToolsToChatTools,
  stringifyResponsesInput,
} from "../translate/responsesTranslator";
import { stringifyContent } from "../translate/requestTranslator";
import type { ChatCompletionRequestMetadata, ResponsesFunctionCallItem, ResponsesObject } from "../types/openai";
import type { RunOutcome } from "../cursor/runController";

export function createResponsesRouter(deps: GatewayDeps): Router {
  const router = Router();

  router.post("/v1/responses", (req, res, next) => {
    void handleResponses(deps, req, res).catch(next);
  });

  router.get("/v1/responses/:id", (req, res, next) => {
    try {
      const apiKey = req.cursorApiKey;
      if (!apiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
      const stored = deps.responseStore.get(req.params.id ?? "", apiKey);
      if (!stored) throw HttpError.notFound(`Response "${req.params.id}" was not found (expired, never stored, or unknown id).`);
      res.json(stored.response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function handleResponses(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  const apiKey = req.cursorApiKey;
  if (!apiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
  const body = validateResponsesRequest(req.body);

  let priorMessages = undefined as ReturnType<typeof responsesInputToMessages> | undefined;
  let sessionId: string | undefined;
  if (body.previous_response_id) {
    const previous = deps.responseStore.get(body.previous_response_id, apiKey);
    if (!previous) {
      throw HttpError.badRequest(
        `previous_response_id "${body.previous_response_id}" was not found. It may have expired (SESSION_TTL_MS) or this gateway was restarted.`,
        "previous_response_id",
      );
    }
    priorMessages = previous.messages;
    sessionId = previous.sessionId;
  }

  const rawMessages = responsesInputToMessages({
    input: body.input,
    instructions: body.instructions,
    priorMessages,
  });

  const responseId = newResponseId();
  const metadataSession = explicitMetadataSessionId(body.metadata);
  const chainSessionId = sessionId ?? metadataSession ?? responseId;
  const metadata: ChatCompletionRequestMetadata = {
    ...(body.metadata ?? {}),
    session_id: chainSessionId,
  };

  const prepared = await prepareGatewayTurn(deps, {
    apiKey,
    endpoint: "/v1/responses",
    requestedModelId: body.model,
    rawMessages,
    tools: responsesToolsToChatTools(body.tools),
    metadata,
    requestId: req.requestId,
  });

  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const promptEstimateText = [body.instructions ?? "", stringifyResponsesInput(body.input), ...rawMessages.map((m) => stringifyContent(m.content))].join(
    "\n",
  );
  const createdAt = Math.floor(Date.now() / 1000);

  const persist = (outcome: RunOutcome, object: ResponsesObject): void => {
    if (body.store === false) return;
    const assistant = assistantMessageFromOutcome(outcome);
    deps.responseStore.put({
      id: responseId,
      apiKey,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      sessionId: chainSessionId,
      messages: [...prepared.messages, assistant],
      response: object,
    });
  };

  if (body.stream) {
    const sse = new SseWriter(res);
    let seq = 0;
    const nextSeq = (): number => {
      const n = seq;
      seq += 1;
      return n;
    };

    const stub = (status: "in_progress" | "completed" | "cancelled" | "failed", output: ResponsesObject["output"] = []): ResponsesObject => ({
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model: body.model,
      output,
      error: null,
      incomplete_details: null,
    });

    sse.sendEvent("response.created", { type: "response.created", sequence_number: nextSeq(), response: stub("in_progress") });
    sse.sendEvent("response.in_progress", { type: "response.in_progress", sequence_number: nextSeq(), response: stub("in_progress") });

    let messageItemId: string | undefined;
    let messageOutputIndex = 0;
    let nextOutputIndex = 0;
    let textOpen = false;
    const closeTextIfOpen = (finalText: string): void => {
      if (!textOpen || !messageItemId) return;
      sse.sendEvent("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: nextSeq(),
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        text: finalText,
      });
      sse.sendEvent("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: finalText },
      });
      sse.sendEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: messageOutputIndex,
        item: {
          type: "message",
          id: messageItemId,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: finalText }],
        },
      });
      textOpen = false;
    };

    let heldOpen = false;
    let streamedText = "";
    const streamedFunctionCalls: ResponsesFunctionCallItem[] = [];
    try {
      const outcome = await executeGatewayTurn(deps, prepared, {
        abortSignal: abortController.signal,
        streaming: true,
        sink: {
          onTextDelta: (delta) => {
            streamedText += delta;
            if (!textOpen) {
              messageItemId = newMessageId();
              messageOutputIndex = nextOutputIndex;
              nextOutputIndex += 1;
              sse.sendEvent("response.output_item.added", {
                type: "response.output_item.added",
                sequence_number: nextSeq(),
                output_index: messageOutputIndex,
                item: { type: "message", id: messageItemId, status: "in_progress", role: "assistant", content: [] },
              });
              sse.sendEvent("response.content_part.added", {
                type: "response.content_part.added",
                sequence_number: nextSeq(),
                item_id: messageItemId,
                output_index: messageOutputIndex,
                content_index: 0,
                part: { type: "output_text", text: "" },
              });
              textOpen = true;
            }
            sse.sendEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: nextSeq(),
              item_id: messageItemId,
              output_index: messageOutputIndex,
              content_index: 0,
              delta,
            });
          },
          onToolCallStarted: (call) => {
            closeTextIfOpen(streamedText);
            const itemId = newFunctionCallItemId();
            const outputIndex = nextOutputIndex;
            nextOutputIndex += 1;
            sse.sendEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: itemId,
                call_id: call.id,
                name: call.name,
                arguments: "",
                status: "in_progress",
              },
            });
            sse.sendEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              sequence_number: nextSeq(),
              item_id: itemId,
              output_index: outputIndex,
              delta: call.argumentsJson,
            });
            sse.sendEvent("response.function_call_arguments.done", {
              type: "response.function_call_arguments.done",
              sequence_number: nextSeq(),
              item_id: itemId,
              output_index: outputIndex,
              arguments: call.argumentsJson,
            });
            sse.sendEvent("response.output_item.done", {
              type: "response.output_item.done",
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: itemId,
                call_id: call.id,
                name: call.name,
                arguments: call.argumentsJson,
                status: "completed",
              },
            });
            streamedFunctionCalls.push({
              type: "function_call",
              id: itemId,
              call_id: call.id,
              name: call.name,
              arguments: call.argumentsJson,
              status: "completed",
            });
          },
        },
      });

      heldOpen = isHeldOpen(prepared, outcome);
      closeTextIfOpen(outcome.content);

      const object = buildResponsesObject({
        id: responseId,
        createdAt,
        requestedModel: body.model,
        outcome,
        promptTextForEstimate: promptEstimateText,
        reuse: {
          messageId: messageItemId,
          functionCallItems: streamedFunctionCalls,
        },
      });

      if (outcome.finishReason !== "cancelled") {
        rememberGatewayTurn(deps, prepared, outcome);
        persist(outcome, object);
      }

      if (!sse.isClosed) {
        sse.sendEvent("response.completed", { type: "response.completed", sequence_number: nextSeq(), response: object });
        sse.done();
      }
    } catch (err) {
      prepared.log.error({ err }, "streaming responses request failed mid-run");
      if (!sse.isClosed) {
        const mapped = mapErrorToResponse(err);
        sse.sendEvent("response.failed", {
          type: "response.failed",
          sequence_number: nextSeq(),
          response: {
            ...stub("failed"),
            error: { message: mapped.body.error.message, type: mapped.body.error.type },
          },
        });
        sse.send(mapped.body);
        sse.done();
      }
    } finally {
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

  const object = buildResponsesObject({
    id: responseId,
    createdAt,
    requestedModel: body.model,
    outcome,
    promptTextForEstimate: promptEstimateText,
  });

  if (outcome.finishReason !== "cancelled") {
    rememberGatewayTurn(deps, prepared, outcome);
    persist(outcome, object);
  }

  res.json(object);
}

function explicitMetadataSessionId(metadata: ChatCompletionRequestMetadata | undefined): string | undefined {
  if (!metadata) return undefined;
  if (typeof metadata.session_id === "string" && metadata.session_id.trim().length > 0) return metadata.session_id.trim();
  if (typeof metadata.sessionId === "string" && metadata.sessionId.trim().length > 0) return metadata.sessionId.trim();
  return undefined;
}
