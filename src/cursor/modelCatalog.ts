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
      const contextLength = resolveContextLength(model);
      const base = { object: "model" as const, created, owned_by: "cursor" };
      if (!seen.has(model.id)) {
        seen.add(model.id);
        data.push({ id: model.id, ...base, ...(contextLength !== undefined ? { context_length: contextLength } : {}) });
      }
      for (const alias of model.aliases ?? []) {
        if (!seen.has(alias)) {
          seen.add(alias);
          data.push({ id: alias, ...base, ...(contextLength !== undefined ? { context_length: contextLength } : {}) });
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

/** Parses Cursor's context parameter values ("300k", "1m", "128000") into a token count. */
function parseContextValue(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(raw.trim());
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  const suffix = (match[2] ?? "").toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
}

/**
 * Derives the effective context window (tokens) for a catalog model.
 *
 * Cursor exposes context as a model *parameter* (id `"context"`, values like
 * `"300k"` / `"1m"`) with per-variant assignments. Requests through this
 * gateway send only a model id - no params - so Cursor serves the variant
 * marked `isDefault`; that variant's context value is the number that's
 * actually true for gateway traffic. Falls back to the largest declared
 * context value when no default variant pins one, and to `undefined` (field
 * omitted) for models with no context parameter at all - honest omission
 * beats a made-up number.
 */
function resolveContextLength(model: SDKModel): number | undefined {
  const contextParam = (model.parameters ?? []).find((p) => p.id === "context");
  if (!contextParam) return undefined;

  // `params` is required per the SDK type, but this data crosses a network
  // boundary - a malformed variant must degrade to the fallback below, not
  // take the whole /v1/models response down with a TypeError.
  const defaultVariant = (model.variants ?? []).find((v) => v.isDefault);
  const defaultContext = (defaultVariant?.params ?? []).find((p) => p.id === "context")?.value;
  if (defaultContext !== undefined) {
    const parsed = parseContextValue(defaultContext);
    if (parsed !== undefined) return parsed;
  }

  let max: number | undefined;
  for (const value of contextParam.values) {
    const parsed = parseContextValue(value.value);
    if (parsed !== undefined && (max === undefined || parsed > max)) max = parsed;
  }
  return max;
}
