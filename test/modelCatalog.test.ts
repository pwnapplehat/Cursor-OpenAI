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
