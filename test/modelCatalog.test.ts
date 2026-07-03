import { test } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { Cursor } from "@cursor/sdk";
import type { SDKModel } from "@cursor/sdk";
import { ModelCatalog } from "../src/cursor/modelCatalog";

const silentLog = pino({ level: "silent" });

const sampleModels: SDKModel[] = [
  { id: "composer-2.5", displayName: "Composer 2.5", aliases: ["composer-2.5-fast"] },
  { id: "claude-4.5-sonnet-thinking", displayName: "Claude 4.5 Sonnet Thinking", aliases: ["claude-sonnet"] },
];

/** Mirrors the real Cursor catalog shape: context exposed as a parameter with per-variant values. */
const modelsWithContext: SDKModel[] = [
  {
    id: "claude-sonnet-5",
    displayName: "Sonnet 5",
    aliases: ["sonnet-latest"],
    parameters: [
      {
        id: "context",
        displayName: "Context",
        values: [
          { value: "300k", displayName: "300K" },
          { value: "1m", displayName: "1M" },
        ],
      },
    ],
    variants: [
      { params: [{ id: "context", value: "300k" }], displayName: "Sonnet 5" },
      { params: [{ id: "context", value: "1m" }], displayName: "Sonnet 5", isDefault: true },
    ],
  },
  {
    // Declares context values but no default variant pins one -> largest wins.
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    parameters: [
      {
        id: "context",
        displayName: "Context",
        values: [{ value: "272k" }, { value: "1m" }],
      },
    ],
  },
  {
    // No context parameter at all -> field must be omitted, not invented.
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
    ],
  },
];

function withMockedModelsList(fn: (calls: { count: number }) => Promise<SDKModel[]>, test_: (t: import("node:test").TestContext) => Promise<void>) {
  return async (t: import("node:test").TestContext) => {
    const originalList = Cursor.models.list;
    const calls = { count: 0 };
    (Cursor.models as { list: typeof Cursor.models.list }).list = (async () => {
      calls.count += 1;
      return fn(calls);
    }) as typeof Cursor.models.list;
    t.after(() => {
      (Cursor.models as { list: typeof Cursor.models.list }).list = originalList;
    });
    await test_(t);
  };
}

test(
  "resolveModelSelection matches an exact model id",
  withMockedModelsList(
    () => Promise.resolve(sampleModels),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "composer-2.5", "composer-2.5");
      assert.deepEqual(result, { id: "composer-2.5" });
    },
  ),
);

test(
  "resolveModelSelection matches an alias case-insensitively",
  withMockedModelsList(
    () => Promise.resolve(sampleModels),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "CLAUDE-SONNET", "composer-2.5");
      assert.deepEqual(result, { id: "claude-4.5-sonnet-thinking" });
    },
  ),
);

test(
  "resolveModelSelection always accepts \"auto\" even when absent from the catalog",
  withMockedModelsList(
    () => Promise.resolve(sampleModels),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "auto", "composer-2.5");
      assert.deepEqual(result, { id: "auto" });
    },
  ),
);

test(
  "resolveModelSelection falls back to the configured default when the requested id isn't in the catalog but the default is",
  withMockedModelsList(
    () => Promise.resolve(sampleModels),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "gpt-4o", "composer-2.5");
      assert.deepEqual(result, { id: "composer-2.5" });
    },
  ),
);

test(
  "resolveModelSelection passes the requested id through unchanged when neither it nor the default match",
  withMockedModelsList(
    () => Promise.resolve(sampleModels),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "totally-unknown-model", "also-unknown");
      assert.deepEqual(result, { id: "totally-unknown-model" });
    },
  ),
);

/** Mirrors the real gpt-5.4-mini catalog entry: one "reasoning" parameter, five variants, medium default. */
const modelsWithVariants: SDKModel[] = [
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    aliases: ["gpt-mini"],
    parameters: [
      {
        id: "reasoning",
        displayName: "Reasoning",
        values: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
      },
    ],
    variants: [
      { params: [{ id: "reasoning", value: "none" }], displayName: "GPT-5.4 Mini" },
      { params: [{ id: "reasoning", value: "low" }], displayName: "GPT-5.4 Mini" },
      { params: [{ id: "reasoning", value: "medium" }], displayName: "GPT-5.4 Mini", isDefault: true },
      { params: [{ id: "reasoning", value: "high" }], displayName: "GPT-5.4 Mini" },
      { params: [{ id: "reasoning", value: "xhigh" }], displayName: "GPT-5.4 Mini" },
    ],
  },
  {
    id: "claude-sonnet-5",
    displayName: "Sonnet 5",
    parameters: [
      { id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
      { id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
    ],
    variants: [
      {
        params: [{ id: "thinking", value: "false" }, { id: "context", value: "300k" }],
        displayName: "Sonnet 5",
        isDefault: true,
      },
      { params: [{ id: "thinking", value: "true" }, { id: "context", value: "300k" }], displayName: "Sonnet 5 Thinking" },
      { params: [{ id: "thinking", value: "false" }, { id: "context", value: "1m" }], displayName: "Sonnet 5 1M" },
      { params: [{ id: "thinking", value: "true" }, { id: "context", value: "1m" }], displayName: "Sonnet 5 Thinking 1M" },
    ],
  },
];

test(
  "resolveModelSelection decodes a value-suffixed variant id (gpt-5.4-mini-xhigh) into a parameterized selection",
  withMockedModelsList(
    () => Promise.resolve(modelsWithVariants),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "gpt-5.4-mini-xhigh", "composer-2.5");
      assert.deepEqual(result, { id: "gpt-5.4-mini", params: [{ id: "reasoning", value: "xhigh" }] });
    },
  ),
);

test(
  "resolveModelSelection decodes a boolean-suffixed variant id (claude-sonnet-5-thinking) via the parameter id",
  withMockedModelsList(
    () => Promise.resolve(modelsWithVariants),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "claude-sonnet-5-thinking", "composer-2.5");
      assert.deepEqual(result, {
        id: "claude-sonnet-5",
        params: [{ id: "thinking", value: "true" }, { id: "context", value: "300k" }],
      });
    },
  ),
);

test(
  "resolveModelSelection decodes a multi-token variant id (claude-sonnet-5-thinking-1m)",
  withMockedModelsList(
    () => Promise.resolve(modelsWithVariants),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "claude-sonnet-5-thinking-1m", "composer-2.5");
      assert.deepEqual(result, {
        id: "claude-sonnet-5",
        params: [{ id: "thinking", value: "true" }, { id: "context", value: "1m" }],
      });
    },
  ),
);

test(
  "resolveModelSelection decodes a variant suffix attached to an alias (gpt-mini-xhigh)",
  withMockedModelsList(
    () => Promise.resolve(modelsWithVariants),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "gpt-mini-xhigh", "composer-2.5");
      assert.deepEqual(result, { id: "gpt-5.4-mini", params: [{ id: "reasoning", value: "xhigh" }] });
    },
  ),
);

test(
  "resolveModelSelection does NOT treat an unknown suffix as a variant (falls back to default)",
  withMockedModelsList(
    () => Promise.resolve(modelsWithVariants),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "gpt-5.4-mini-turbo", "claude-sonnet-5");
      assert.deepEqual(result, { id: "claude-sonnet-5" });
    },
  ),
);

test(
  "toOpenAIModelList lists single-delta variant slugs with per-variant context_length",
  withMockedModelsList(
    () => Promise.resolve(modelsWithVariants),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const list = await catalog.toOpenAIModelList("key");
      const ids = list.data.map((m) => m.id);
      for (const expected of ["gpt-5.4-mini-none", "gpt-5.4-mini-low", "gpt-5.4-mini-high", "gpt-5.4-mini-xhigh", "claude-sonnet-5-thinking", "claude-sonnet-5-1m"]) {
        assert.ok(ids.includes(expected), `missing ${expected}`);
      }
      assert.ok(!ids.includes("gpt-5.4-mini-medium"), "default variant gets no extra slug");
      const oneM = list.data.find((m) => m.id === "claude-sonnet-5-1m");
      assert.equal(oneM?.context_length, 1_000_000, "variant slug carries its own context");
    },
  ),
);

test(
  "resolveModelSelection degrades to passthrough (not a crash) when Cursor.models.list fails and nothing is cached",
  withMockedModelsList(
    () => Promise.reject(new Error("network down")),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const result = await catalog.resolveModelSelection("key", "composer-2.5", "composer-2.5");
      assert.deepEqual(result, { id: "composer-2.5" });
    },
  ),
);

test(
  "toOpenAIModelList includes both canonical ids and aliases, deduplicated",
  withMockedModelsList(
    () => Promise.resolve(sampleModels),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const list = await catalog.toOpenAIModelList("key");
      const ids = list.data.map((m) => m.id).sort();
      assert.deepEqual(ids, ["claude-4.5-sonnet-thinking", "claude-sonnet", "composer-2.5", "composer-2.5-fast"].sort());
      assert.ok(list.data.every((m) => m.object === "model" && m.owned_by === "cursor"));
    },
  ),
);

test(
  "toOpenAIModelList reports context_length from the default variant's context parameter",
  withMockedModelsList(
    () => Promise.resolve(modelsWithContext),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const list = await catalog.toOpenAIModelList("key");
      const sonnet = list.data.find((m) => m.id === "claude-sonnet-5");
      assert.equal(sonnet?.context_length, 1_000_000, "default variant pins 1m");
      const sonnetAlias = list.data.find((m) => m.id === "sonnet-latest");
      assert.equal(sonnetAlias?.context_length, 1_000_000, "aliases inherit the model's context_length");
    },
  ),
);

test(
  "toOpenAIModelList falls back to the largest declared context value when no default variant pins one",
  withMockedModelsList(
    () => Promise.resolve(modelsWithContext),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const list = await catalog.toOpenAIModelList("key");
      const gpt = list.data.find((m) => m.id === "gpt-5.5");
      assert.equal(gpt?.context_length, 1_000_000, "272k vs 1m -> 1m");
    },
  ),
);

test(
  "toOpenAIModelList omits context_length entirely for models with no context parameter",
  withMockedModelsList(
    () => Promise.resolve(modelsWithContext),
    async () => {
      const catalog = new ModelCatalog(silentLog);
      const list = await catalog.toOpenAIModelList("key");
      const composer = list.data.find((m) => m.id === "composer-2.5");
      assert.ok(composer, "model present");
      assert.equal("context_length" in (composer as object), false, "field omitted, not null/0");
    },
  ),
);

test("list() calls Cursor.models.list exactly once for three back-to-back calls with the same key", async (t) => {
  const originalList = Cursor.models.list;
  let calls = 0;
  (Cursor.models as { list: typeof Cursor.models.list }).list = (async () => {
    calls += 1;
    return sampleModels;
  }) as typeof Cursor.models.list;
  t.after(() => {
    (Cursor.models as { list: typeof Cursor.models.list }).list = originalList;
  });

  const catalog = new ModelCatalog(silentLog);
  await Promise.all([catalog.list("key-b"), catalog.list("key-b"), catalog.list("key-b")]);
  assert.equal(calls, 1, "concurrent calls for the same key should share one in-flight fetch");
});

test("list() fetches independently per API key", async (t) => {
  const originalList = Cursor.models.list;
  let calls = 0;
  (Cursor.models as { list: typeof Cursor.models.list }).list = (async () => {
    calls += 1;
    return sampleModels;
  }) as typeof Cursor.models.list;
  t.after(() => {
    (Cursor.models as { list: typeof Cursor.models.list }).list = originalList;
  });

  const catalog = new ModelCatalog(silentLog);
  await catalog.list("key-c1");
  await catalog.list("key-c2");
  assert.equal(calls, 2);
});
