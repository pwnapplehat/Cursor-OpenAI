import { Cursor } from "@cursor/sdk";
import type { SDKModel, ModelSelection, ModelParameterValue, ModelVariant } from "@cursor/sdk";
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
 * strings against it - by exact id, by alias, by variant-suffixed id
 * (`gpt-5.4-mini-xhigh` -> `gpt-5.4-mini` + `reasoning=xhigh`), or
 * case-insensitively - before falling back to the configured default model.
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

    // Variant-suffixed id (the naming convention Cursor's own model slugs
    // use): "<base-id-or-alias>-<value-or-flag>[-...]", e.g. gpt-5.4-mini-xhigh
    // or claude-sonnet-5-thinking-1m. Resolves to a real ModelSelection with
    // params so the SDK serves that exact variant.
    const variantSelection = parseVariantSelection(models, requestedId);
    if (variantSelection) {
      this.log.info({ requestedId, resolved: variantSelection }, "resolved variant-suffixed model id to a parameterized selection");
      return variantSelection;
    }

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
      // Variant-suffixed ids (Cursor's own slug convention, e.g.
      // gpt-5.4-mini-xhigh, claude-sonnet-5-thinking). Listed for variants
      // that differ from the default in exactly ONE parameter - the useful,
      // human-recognizable set - while the resolver additionally accepts
      // arbitrary multi-parameter combos typed by hand.
      for (const variant of model.variants ?? []) {
        const suffix = singleDeltaVariantSuffix(model, variant);
        if (!suffix) continue;
        const variantId = `${model.id}-${suffix}`;
        if (seen.has(variantId)) continue;
        seen.add(variantId);
        const variantContext = resolveVariantContextLength(variant) ?? contextLength;
        data.push({ id: variantId, ...base, ...(variantContext !== undefined ? { context_length: variantContext } : {}) });
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

/**
 * Parses a variant-suffixed model id into a parameterized {@link ModelSelection}.
 *
 * Cursor's own slug convention for variants: `<base>-<token>[-<token>...]`,
 * where a token is either a parameter *value* (`xhigh` -> `reasoning=xhigh`,
 * `1m` -> `context=1m`) or, for boolean parameters, the parameter *id*
 * (`thinking` -> `thinking=true`). Matching is case-insensitive and prefers
 * the longest base id/alias so `gpt-5.4-mini-xhigh` binds to `gpt-5.4-mini`,
 * not to a shorter accidental prefix.
 *
 * When the parsed tokens correspond to a declared catalog variant (all parsed
 * params match, all other params at their default-variant values), that
 * variant's full param set is returned, so the SDK serves exactly the variant
 * Cursor itself would. Unknown tokens make the whole parse fail - callers
 * fall through to their default/passthrough behavior rather than guessing.
 */
function parseVariantSelection(models: SDKModel[], requestedId: string): ModelSelection | undefined {
  const normalized = requestedId.trim().toLowerCase();

  let best: { model: SDKModel; baseLength: number; params: ModelParameterValue[] } | undefined;
  for (const model of models) {
    const bases = [model.id, ...(model.aliases ?? [])];
    for (const base of bases) {
      const baseLower = base.toLowerCase();
      if (!normalized.startsWith(`${baseLower}-`)) continue;
      if (best && baseLower.length <= best.baseLength) continue;
      const tokens = normalized.slice(baseLower.length + 1).split("-");
      const params = parseVariantTokens(model, tokens);
      if (params) best = { model, baseLength: baseLower.length, params };
    }
  }
  if (!best) return undefined;

  const declared = findDeclaredVariant(best.model, best.params);
  return { id: best.model.id, params: declared ? [...declared.params] : best.params };
}

/** Maps suffix tokens to parameter assignments; undefined when any token doesn't decode. */
function parseVariantTokens(model: SDKModel, tokens: string[]): ModelParameterValue[] | undefined {
  const parameters = model.parameters ?? [];
  if (parameters.length === 0 || tokens.length === 0) return undefined;

  const params: ModelParameterValue[] = [];
  const assigned = new Set<string>();
  for (const token of tokens) {
    if (!token) return undefined;
    // Boolean-style parameter referenced by id: "...-thinking" -> thinking=true.
    const byId = parameters.find(
      (p) => p.id.toLowerCase() === token && p.values.some((v) => v.value === "true"),
    );
    const byValue = byId ? undefined : parameters.find((p) => p.values.some((v) => v.value.toLowerCase() === token));
    const parameter = byId ?? byValue;
    if (!parameter || assigned.has(parameter.id)) return undefined;
    assigned.add(parameter.id);
    params.push({ id: parameter.id, value: byId ? "true" : token });
  }
  return params;
}

/**
 * Finds the declared variant the parsed params denote: every parsed param
 * matches exactly, and every *other* param sits at its default-variant value.
 */
function findDeclaredVariant(model: SDKModel, parsed: ModelParameterValue[]): ModelVariant | undefined {
  const variants = model.variants ?? [];
  if (variants.length === 0) return undefined;
  const defaults = new Map((variants.find((v) => v.isDefault)?.params ?? []).map((p) => [p.id, p.value]));
  const wanted = new Map(parsed.map((p) => [p.id, p.value.toLowerCase()]));

  return variants.find((variant) =>
    variant.params.every((param) => {
      const explicit = wanted.get(param.id);
      if (explicit !== undefined) return param.value.toLowerCase() === explicit;
      const defaultValue = defaults.get(param.id);
      return defaultValue === undefined || param.value === defaultValue;
    }) && [...wanted.keys()].every((id) => variant.params.some((p) => p.id === id)),
  );
}

/**
 * Suffix for listing a variant in /v1/models - only variants that differ from
 * the default in exactly one parameter get a listed slug (`-xhigh`,
 * `-thinking`, `-1m`); the resolver still accepts hand-typed multi-parameter
 * combos. Returns undefined for the default variant, multi-parameter deltas,
 * and boolean-off deltas (no natural slug token).
 */
function singleDeltaVariantSuffix(model: SDKModel, variant: ModelVariant): string | undefined {
  const variants = model.variants ?? [];
  const defaultVariant = variants.find((v) => v.isDefault);
  if (!defaultVariant || variant === defaultVariant) return undefined;

  const defaults = new Map(defaultVariant.params.map((p) => [p.id, p.value]));
  const deltas = variant.params.filter((p) => defaults.get(p.id) !== p.value);
  if (deltas.length !== 1) return undefined;

  const delta = deltas[0]!;
  if (delta.value === "true") return delta.id;
  if (delta.value === "false") return undefined;
  return delta.value;
}

/** Context length for a specific variant, when that variant pins a context param. */
function resolveVariantContextLength(variant: ModelVariant): number | undefined {
  const contextValue = variant.params.find((p) => p.id === "context")?.value;
  return contextValue !== undefined ? parseContextValue(contextValue) : undefined;
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
