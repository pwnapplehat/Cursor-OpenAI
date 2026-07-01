import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityLog } from "../src/observability/activityLog";

function baseEntry(overrides: Partial<Parameters<ActivityLog["record"]>[0]> = {}) {
  return {
    requestId: "req_1",
    endpoint: "/v1/chat/completions" as const,
    model: "composer-2.5",
    streaming: false,
    status: "ok" as const,
    durationMs: 100,
    usage: undefined,
    errorMessage: undefined,
    cursorAgentId: "agent-1",
    ...overrides,
  };
}

test("ActivityLog.recent returns entries newest-first", () => {
  const log = new ActivityLog();
  log.record(baseEntry({ requestId: "req_1" }));
  log.record(baseEntry({ requestId: "req_2" }));
  log.record(baseEntry({ requestId: "req_3" }));

  const recent = log.recent();
  assert.deepEqual(
    recent.map((e) => e.requestId),
    ["req_3", "req_2", "req_1"],
  );
});

test("ActivityLog assigns a unique id and timestamp to each entry", () => {
  const log = new ActivityLog();
  log.record(baseEntry());
  log.record(baseEntry());
  const [a, b] = log.recent();
  assert.notEqual(a!.id, b!.id);
  assert.ok(typeof a!.timestamp === "number" && a!.timestamp > 0);
});

test("ActivityLog caps the ring buffer at 200 entries, dropping the oldest", () => {
  const log = new ActivityLog();
  for (let i = 0; i < 205; i += 1) {
    log.record(baseEntry({ requestId: `req_${i}` }));
  }
  const recent = log.recent(1000);
  assert.equal(recent.length, 200);
  assert.equal(recent[0]!.requestId, "req_204", "newest entry should be first");
  assert.equal(recent[recent.length - 1]!.requestId, "req_5", "the oldest 5 entries should have been dropped");
});

test("ActivityLog.recent respects a smaller limit than the buffer size", () => {
  const log = new ActivityLog();
  for (let i = 0; i < 10; i += 1) log.record(baseEntry({ requestId: `req_${i}` }));
  assert.equal(log.recent(3).length, 3);
});

test("ActivityLog.stats aggregates totals, errors, and token usage across recorded entries", () => {
  const log = new ActivityLog();
  log.record(
    baseEntry({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } }),
  );
  log.record(baseEntry({ status: "error", usage: undefined }));
  log.record(
    baseEntry({ usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 28 } }),
  );

  const stats = log.stats();
  assert.equal(stats.totalRequests, 3);
  assert.equal(stats.totalErrors, 1);
  assert.equal(stats.totalPromptTokens, 30);
  assert.equal(stats.totalCompletionTokens, 13);
});

test("ActivityLog.stats tracks per-model request counts", () => {
  const log = new ActivityLog();
  log.record(baseEntry({ model: "composer-2.5" }));
  log.record(baseEntry({ model: "composer-2.5" }));
  log.record(baseEntry({ model: "auto" }));

  const stats = log.stats();
  assert.deepEqual(stats.requestsByModel, { "composer-2.5": 2, auto: 1 });
});

test("ActivityLog.stats always returns 24 hourly buckets, most recent last, including empty ones", () => {
  const log = new ActivityLog();
  log.record(baseEntry());
  const stats = log.stats();
  assert.equal(stats.hourlyBuckets.length, 24);
  const lastBucket = stats.hourlyBuckets[stats.hourlyBuckets.length - 1]!;
  assert.equal(lastBucket.count, 1, "the current hour's bucket should include the entry just recorded");
  assert.ok(stats.hourlyBuckets.slice(0, -1).every((bucket) => bucket.count === 0));
});

test("ActivityLog.clear resets entries and all aggregate counters", () => {
  const log = new ActivityLog();
  log.record(baseEntry());
  log.record(baseEntry({ status: "error" }));
  log.clear();

  assert.equal(log.recent().length, 0);
  const stats = log.stats();
  assert.equal(stats.totalRequests, 0);
  assert.equal(stats.totalErrors, 0);
  assert.deepEqual(stats.requestsByModel, {});
  assert.ok(stats.hourlyBuckets.every((bucket) => bucket.count === 0));
});
