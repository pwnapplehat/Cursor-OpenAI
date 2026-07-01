import type { TokenUsage } from "@cursor/sdk";

export type ActivityStatus = "ok" | "tool_calls" | "error" | "cancelled";

export interface ActivityEntry {
  id: string;
  timestamp: number;
  requestId: string;
  endpoint: "/v1/chat/completions" | "/v1/completions" | "/api/admin/test-chat";
  model: string;
  streaming: boolean;
  status: ActivityStatus;
  durationMs: number;
  usage: TokenUsage | undefined;
  errorMessage: string | undefined;
  cursorAgentId: string | undefined;
}

export interface ActivityStats {
  totalRequests: number;
  totalErrors: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  requestsByModel: Record<string, number>;
  /** Request counts for the last 24 one-hour buckets, oldest first, indexed by `Math.floor(timestamp / 3_600_000)`. */
  hourlyBuckets: Array<{ hourStart: number; count: number }>;
}

const MAX_ENTRIES = 200;
const HOURLY_BUCKET_COUNT = 24;
const HOUR_MS = 3_600_000;

/**
 * In-memory (not persisted - intentionally reset on restart, this is a
 * live-operations view, not an analytics warehouse) ring buffer of recent
 * gateway activity, plus running aggregate counters, powering the admin
 * dashboard's Overview and Activity views. Every real request path (chat
 * completions, legacy completions, and the admin dashboard's own test-chat)
 * records through the same `record()` call in `gateway/orchestrator.ts`, so
 * the dashboard reflects genuine traffic, not a mocked-up preview.
 */
export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private nextId = 1;
  private totalRequests = 0;
  private totalErrors = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private readonly requestsByModel = new Map<string, number>();
  private readonly hourlyCounts = new Map<number, number>();

  record(entry: Omit<ActivityEntry, "id" | "timestamp"> & { timestamp?: number }): void {
    const timestamp = entry.timestamp ?? Date.now();
    const full: ActivityEntry = { ...entry, id: `act_${this.nextId++}`, timestamp };

    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    this.totalRequests += 1;
    if (full.status === "error") this.totalErrors += 1;
    if (full.usage) {
      this.totalPromptTokens += full.usage.inputTokens;
      this.totalCompletionTokens += full.usage.outputTokens;
    }
    this.requestsByModel.set(full.model, (this.requestsByModel.get(full.model) ?? 0) + 1);

    const hourKey = Math.floor(timestamp / HOUR_MS);
    this.hourlyCounts.set(hourKey, (this.hourlyCounts.get(hourKey) ?? 0) + 1);
    const oldestAllowed = Math.floor(Date.now() / HOUR_MS) - HOURLY_BUCKET_COUNT;
    for (const key of this.hourlyCounts.keys()) {
      if (key < oldestAllowed) this.hourlyCounts.delete(key);
    }
  }

  /** Most recent entries first. */
  recent(limit = MAX_ENTRIES): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  stats(): ActivityStats {
    const currentHour = Math.floor(Date.now() / HOUR_MS);
    const hourlyBuckets: ActivityStats["hourlyBuckets"] = [];
    for (let i = HOURLY_BUCKET_COUNT - 1; i >= 0; i -= 1) {
      const hourKey = currentHour - i;
      hourlyBuckets.push({ hourStart: hourKey * HOUR_MS, count: this.hourlyCounts.get(hourKey) ?? 0 });
    }

    return {
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      requestsByModel: Object.fromEntries(this.requestsByModel),
      hourlyBuckets,
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.requestsByModel.clear();
    this.hourlyCounts.clear();
  }
}
