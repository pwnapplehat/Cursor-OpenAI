import { Cursor } from "@cursor/sdk";
import type { SDKModel, ModelSelection } from "@cursor/sdk";
import type { OpenAIModelList } from "../types/openai";
import type { Logger } from "../logger";

interface CacheEntry {
  models: SDKModel[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Caches `Cursor.models.list()` per API key (each key may see a different
 * catalog depending on plan/team) and resolves OpenAI-style requested model
 * strings against it - by exact id, by alias, or case-insensitively - before
 * falling back to the configured default model.
 */
export class ModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<SDKModel[]>>();

  constructor(private readonly log: Logger) {}

  async list(apiKey: string, forceRefresh = false): Promise<SDKModel[]> {
    const cached = this.cache.get(apiKey);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }

    const existingInflight = this.inflight.get(apiKey);
    if (existingInflight) return existingInflight;

    const fetchPromise = Cursor.models
      .list({ apiKey })
      .then((models) => {
        this.cache.set(apiKey, { models, fetchedAt: Date.now() });
        this.inflight.delete(apiKey);
        return models;
      })
      .catch((err: unknown) => {
        this.inflight.delete(apiKey);
        this.log.warn({ err }, "failed to fetch Cursor model catalog");
        if (cached) return cached.models;
        throw err;
      });

    this.inflight.set(apiKey, fetchPromise);
    return fetchPromise;
  }

  async resolveModelSelection(apiKey: string, requestedId: string, defaultModelId: string): Promise<ModelSelection> {
    const models = await this.safeList(apiKey);
    const match = findModel(models, requestedId) ?? (requestedId === "auto" ? { id: "auto" } : undefined);
    if (match) return { id: match.id };

    if (defaultModelId !== requestedId) {
      const defaultMatch = findModel(models, defaultModelId);
      if (defaultMatch) {
        this.log.info(
          { requestedId, resolvedTo: defaultMatch.id },
          "requested model not found in Cursor catalog, falling back to configured default",
        );
        return { id: defaultMatch.id };
      }
    }

    // Let the SDK itself reject unknown ids with an authoritative error rather
    // than us silently guessing - this keeps failures honest and debuggable.
    this.log.warn({ requestedId }, "requested model not found in Cursor catalog; passing through as-is");
    return { id: requestedId };
  }

  async toOpenAIModelList(apiKey: string): Promise<OpenAIModelList> {
    const models = await this.safeList(apiKey);
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const data = [];
    for (const model of models) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        data.push({ id: model.id, object: "model" as const, created, owned_by: "cursor" });
      }
      for (const alias of model.aliases ?? []) {
        if (!seen.has(alias)) {
          seen.add(alias);
          data.push({ id: alias, object: "model" as const, created, owned_by: "cursor" });
        }
      }
    }
    return { object: "list", data };
  }

  private async safeList(apiKey: string): Promise<SDKModel[]> {
    try {
      return await this.list(apiKey);
    } catch {
      return [];
    }
  }
}

function findModel(models: SDKModel[], requestedId: string): SDKModel | undefined {
  const normalized = requestedId.trim().toLowerCase();
  return models.find(
    (model) =>
      model.id.toLowerCase() === normalized ||
      (model.aliases ?? []).some((alias) => alias.toLowerCase() === normalized),
  );
}
