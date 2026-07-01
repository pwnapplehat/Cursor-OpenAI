import { Router } from "express";
import { HttpError } from "../errors";

/**
 * The Cursor Agent SDK has no embeddings API - it runs coding-agent
 * conversations, not raw vector inference. Rather than fabricate a fake
 * embedding vector (which would silently corrupt any downstream similarity
 * search), this endpoint returns a clear, correctly-shaped OpenAI error so
 * clients fail loudly and predictably instead of getting garbage vectors.
 */
export function createEmbeddingsRouter(): Router {
  const router = Router();

  router.post("/v1/embeddings", (_req, _res, next) => {
    next(
      HttpError.notImplemented(
        "This gateway is backed by the Cursor Agent SDK, which does not expose an embeddings API. " +
          "Point embedding calls at a real embeddings provider (OpenAI, Cohere, a local model, etc.) instead.",
      ),
    );
  });

  return router;
}
