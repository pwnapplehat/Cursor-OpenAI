import { Cursor } from "@cursor/sdk";
import type { SDKModel, ModelSelection, ModelParameterValue, ModelVariant } from "@cursor/sdk";
import type { ModelListMode } from "../config";
import type { OpenAIModel, OpenAIModelList } from "../types/openai";
import type { Logger } from "../logger";

interface CacheEntry {
  models: SDKModel[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ModelListOptions {
  /** `all` includes aliases; `canonical` lists one id per SDK model plus useful variants (including `-fast`). */
  mode?: ModelListMode;
  /** When non-empty, only these listed ids (case-insensitive exact match) appear in GET /v1/models. Resolution of chat/responses requests is not filtered. */
  allowedModels?: string[];
}

/**
 * Caches `Cursor.models.list()` per API key (each key may see a different
 * catalog depending on plan/team) and resolves OpenAI-style requested model
 * strings against it - by exact id, by variant-suffixed id
 * (`gpt-5.4-mini-xhigh` -> `gpt-5.4-mini` + `reasoning=xhigh`,
 * `composer-2.5-fast` -> `composer-2.5` + `fast=true`), by alias, or
 * case-insensitively - before falling back to the configured default model.
 *
 * Product contract for the `fast` parameter (when the catalog declares one):
 * the bare model id is **non-Fast** (`fast=false`); the `-fast` suffix is
 * Fast (`fast=true`). Cursor's own default variant for several models
 * (notably Composer) is Fast, so sending only `{ id }` would bill as
 * `composer-2.5-fast`. This resolver always passes an explicit `fast` param
 * when the catalog exposes one.
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
    const requested = requestedId.trim();

    // 1. Exact canonical id (NOT aliases). Apply explicit non-Fast when a
    // `fast` param exists so Cursor cannot silently serve its Fast default.
    const exact = findModelById(models, requested);
    if (exact) return selectionForModel(exact, { fast: false });

    if (requested.toLowerCase() === "auto") return { id: "auto" };

    // 2. Variant-suffixed id, matched against id AND alias bases *before*
    // alias collapse. `composer-2.5-fast` must become `fast=true` rather than
    // resolving as an alias of `composer-2.5` with no params (which would
    // then inherit Cursor's Fast default).
    const variantSelection = parseVariantSelection(models, requested);
    if (variantSelection) {
      this.log.info({ requestedId: requested, resolved: variantSelection }, "resolved variant-suffixed model id to a parameterized selection");
      return variantSelection;
    }

    // 3. Remaining alias match. An alias literally named `<id>-fast` still
    // forces Fast when the catalog has that parameter; every other alias
    // is the non-Fast selection of its canonical model.
    const aliasMatch = findModelByAlias(models, requested);
    if (aliasMatch) {
      const matchedAlias = (aliasMatch.aliases ?? []).find((alias) => alias.toLowerCase() === requested.toLowerCase());
      const wantFast = Boolean(matchedAlias && aliasImpliesFast(matchedAlias, aliasMatch.id) && hasFastParam(aliasMatch));
      return selectionForModel(aliasMatch, { fast: wantFast });
    }

    if (defaultModelId !== requested) {
      const defaultMatch = findModelById(models, defaultModelId) ?? findModelByAlias(models, defaultModelId);
      if (defaultMatch) {
        this.log.info(
          { requestedId: requested, resolvedTo: defaultMatch.id },
          "requested model not found in Cursor catalog, falling back to configured default",
        );
        return selectionForModel(defaultMatch, { fast: false });
      }
    }

    // Let the SDK itself reject unknown ids with an authoritative error rather
    // than us silently guessing - this keeps failures honest and debuggable.
    this.log.warn({ requestedId: requested }, "requested model not found in Cursor catalog; passing through as-is");
    return { id: requested };
  }

  async toOpenAIModelList(apiKey: string, options: ModelListOptions = {}): Promise<OpenAIModelList> {
    const models = await this.safeList(apiKey);
    const created = Math.floor(Date.now() / 1000);
    const mode: ModelListMode = options.mode ?? "canonical";
    const seen = new Set<string>();
    const data: OpenAIModel[] = [];

    const push = (id: string, contextLength: number | undefined): void => {
      if (seen.has(id)) return;
      seen.add(id);
      data.push({
        id,
        object: "model",
        created,
        owned_by: "cursor",
        ...(contextLength !== undefined ? { context_length: contextLength } : {}),
      });
    };

    for (const model of models) {
      const contextLength = resolveContextLength(model);
      push(model.id, contextLength);

      if (mode === "all") {
        for (const alias of model.aliases ?? []) {
          push(alias, contextLength);
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
        const variantContext = resolveVariantContextLength(variant) ?? contextLength;
        push(`${model.id}-${suffix}`, variantContext);
      }

      // Always list `<id>-fast` when the catalog has a `fast` parameter, even
      // when Fast is Cursor's default variant (singleDeltaVariantSuffix would
      // skip it as "the default", and skip non-Fast because `false` has no
      // slug). The bare id is the non-Fast selection; this entry is Fast.
      if (hasFastParam(model)) {
        push(`${model.id}-fast`, contextLength);
      }
    }

    const allowed = normalizeAllowed(options.allowedModels);
    const filtered = allowed ? data.filter((entry) => allowed.has(entry.id.toLowerCase())) : data;
    return { object: "list", data: filtered };
  }

  /**
   * GET /v1/models/:id lookup. Prefers the filtered list; when no allowlist
   * is set, also resolves aliases and hand-typed variant slugs that canonical
   * listing omits, so a client that already knows `claude-sonnet` still gets
   * a 200 rather than a 404.
   */
  async lookupOpenAIModel(apiKey: string, id: string, options: ModelListOptions = {}): Promise<OpenAIModel | undefined> {
    const list = await this.toOpenAIModelList(apiKey, options);
    const listed = list.data.find((model) => model.id === id);
    if (listed) return listed;

    const allowed = normalizeAllowed(options.allowedModels);
    if (allowed) return undefined;

    const models = await this.safeList(apiKey);
    const created = Math.floor(Date.now() / 1000);
    const found = findModel(models, id);
    if (found) {
      const contextLength = resolveContextLength(found);
      return {
        id,
        object: "model",
        created,
        owned_by: "cursor",
        ...(contextLength !== undefined ? { context_length: contextLength } : {}),
      };
    }
    const variant = parseVariantSelection(models, id);
    if (!variant) return undefined;
    const variantModel = findModelById(models, variant.id);
    const contextLength = variantModel ? resolveContextLength(variantModel) : undefined;
    return {
      id,
      object: "model",
      created,
      owned_by: "cursor",
      ...(contextLength !== undefined ? { context_length: contextLength } : {}),
    };
  }

  private async safeList(apiKey: string): Promise<SDKModel[]> {
    try {
      return await this.list(apiKey);
    } catch {
      return [];
    }
  }
}

/** Human-readable `id (param=value, ...)` for logs - never a substitute for passing the real ModelSelection through to the SDK. */
export function formatModelSelection(selection: ModelSelection): string {
  if (!selection.params?.length) return selection.id;
  return `${selection.id} (${selection.params.map((p) => `${p.id}=${p.value}`).join(", ")})`;
}

function normalizeAllowed(allowed: string[] | undefined): Set<string> | undefined {
  if (!allowed || allowed.length === 0) return undefined;
  const set = new Set(allowed.map((id) => id.trim().toLowerCase()).filter(Boolean));
  return set.size > 0 ? set : undefined;
}

function findModelById(models: SDKModel[], requestedId: string): SDKModel | undefined {
  const normalized = requestedId.trim().toLowerCase();
  return models.find((model) => model.id.toLowerCase() === normalized);
}

function findModelByAlias(models: SDKModel[], requestedId: string): SDKModel | undefined {
  const normalized = requestedId.trim().toLowerCase();
  return models.find((model) => (model.aliases ?? []).some((alias) => alias.toLowerCase() === normalized));
}

function findModel(models: SDKModel[], requestedId: string): SDKModel | undefined {
  return findModelById(models, requestedId) ?? findModelByAlias(models, requestedId);
}

function hasFastParam(model: SDKModel): boolean {
  return (model.parameters ?? []).some((p) => p.id === "fast");
}

function aliasImpliesFast(alias: string, modelId: string): boolean {
  return alias.trim().toLowerCase() === `${modelId.trim().toLowerCase()}-fast`;
}

/**
 * Builds the ModelSelection the SDK must receive. When the catalog declares a
 * `fast` parameter, `fast` is always set explicitly - omitting it lets Cursor
 * apply its own default, which for Composer is Fast.
 */
function selectionForModel(model: SDKModel, opts: { fast: boolean }): ModelSelection {
  if (!hasFastParam(model)) return { id: model.id };
  return { id: model.id, params: [{ id: "fast", value: opts.fast ? "true" : "false" }] };
}

/**
 * Parses a variant-suffixed model id into a parameterized {@link ModelSelection}.
 *
 * Cursor's own slug convention for variants: `<base>-<token>[-<token>...]`,
 * where a token is either a parameter *value* (`xhigh` -> `reasoning=xhigh`,
 * `1m` -> `context=1m`) or, for boolean parameters, the parameter *id*
 * (`thinking` -> `thinking=true`, `fast` -> `fast=true`). Matching is
 * case-insensitive and prefers the longest base id/alias so `gpt-5.4-mini-xhigh`
 * binds to `gpt-5.4-mini`, not to a shorter accidental prefix.
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
    // Boolean-style parameter referenced by id: "...-thinking" -> thinking=true, "...-fast" -> fast=true.
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
 * and boolean-off deltas (no natural slug token). Fast is listed separately
 * so it appears even when it *is* the catalog default.
 */
function singleDeltaVariantSuffix(model: SDKModel, variant: ModelVariant): string | undefined {
  const variants = model.variants ?? [];
  const defaultVariant = variants.find((v) => v.isDefault);
  if (!defaultVariant || variant === defaultVariant) return undefined;

  const defaults = new Map(defaultVariant.params.map((p) => [p.id, p.value]));
  const deltas = variant.params.filter((p) => defaults.get(p.id) !== p.value);
  if (deltas.length !== 1) return undefined;

  const delta = deltas[0]!;
  if (delta.id === "fast") return undefined;
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
 * `"300k"` / `"1m"`) with per-variant assignments. The gateway's bare model
 * id is the non-Fast selection when a `fast` param exists; other parameters
 * (including context) stay at the catalog default variant unless the client
 * requested a variant slug. That variant's context value is the number that's
 * actually true for gateway traffic on the bare id. Falls back to the largest
 * declared context value when no default variant pins one, and to `undefined`
 * (field omitted) for models with no context parameter at all - honest
 * omission beats a made-up number.
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
