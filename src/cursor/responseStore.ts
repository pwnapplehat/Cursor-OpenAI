import type { AppConfig } from "../config";
import type { ChatCompletionMessage, ResponsesObject } from "../types/openai";

export interface StoredResponse {
  id: string;
  /**
   * Cursor API key that created this entry. Lookups must present the same
   * key - without this, passthrough-mode clients could retrieve or continue
   * each other's conversations by guessing a `resp_` id. Same contract as
   * held-run lookup by tool_call_id.
   */
  apiKey: string;
  createdAt: number;
  /** Inactivity clock - TTL matches SessionManager (`sessionTtlMs`). */
  lastUsedAt: number;
  /** Shared across a previous_response_id chain so one Cursor agent is reused. */
  sessionId: string;
  messages: ChatCompletionMessage[];
  response: ResponsesObject;
}

/**
 * In-memory map of Responses API ids onto conversation state, so
 * `previous_response_id` can continue a Cursor session (including held
 * tool loops). TTL matches `sessionTtlMs` of inactivity; capacity matches
 * `maxCachedAgents` (LRU by last use). Does not survive process restart -
 * same contract as SessionManager.
 *
 * Entries are scoped to the creating API key: `get(id, otherKey)` returns
 * undefined (indistinguishable from a missing id) so one client cannot
 * continue another client's chain.
 */
export class ResponseStore {
  private readonly entries = new Map<string, StoredResponse>();

  constructor(private readonly config: AppConfig) {}

  get(id: string, apiKey: string): StoredResponse | undefined {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(id);
      return undefined;
    }
    if (entry.apiKey !== apiKey) return undefined;
    entry.lastUsedAt = Date.now();
    return entry;
  }

  put(entry: StoredResponse): void {
    this.sweep();
    const now = Date.now();
    this.entries.set(entry.id, {
      ...entry,
      lastUsedAt: entry.lastUsedAt ?? now,
    });
    this.enforceCapacity();
  }

  get size(): number {
    return this.entries.size;
  }

  shutdown(): void {
    this.entries.clear();
  }

  private isExpired(entry: StoredResponse): boolean {
    return Date.now() - entry.lastUsedAt > this.config.sessionTtlMs;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.config.sessionTtlMs) this.entries.delete(id);
    }
  }

  private enforceCapacity(): void {
    const cap = Math.max(1, this.config.maxCachedAgents);
    if (this.entries.size <= cap) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = this.entries.size - cap;
    for (let i = 0; i < excess; i += 1) {
      const item = sorted[i];
      if (item) this.entries.delete(item[0]);
    }
  }
}
