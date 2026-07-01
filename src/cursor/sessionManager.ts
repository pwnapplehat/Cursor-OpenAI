import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Agent } from "@cursor/sdk";
import type { SDKAgent, ModelSelection } from "@cursor/sdk";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { ChatCompletionMessage, ChatCompletionRequestMetadata } from "../types/openai";
import { computeNewSuffix, hashMessages } from "../utils/hash";
import { Mutex } from "../utils/concurrency";

export interface SessionHandle {
  agent: SDKAgent;
  mutex: Mutex;
  cwd: string;
  key: string;
  /** True the first time this agent handle is used (nothing has been sent to it yet through this gateway). */
  isFirstTurn: boolean;
  /** The subset of the request's `messages[]` this turn should actually send - see {@link computeNewSuffix}. */
  newMessages: ChatCompletionMessage[];
}

export interface SessionSummary {
  id: string;
  type: "explicit" | "resume" | "auto" | "fresh";
  agentId: string;
  model: string | undefined;
  messageCount: number;
  createdAt: number;
  lastUsedAt: number;
}

interface SessionEntry {
  agent: SDKAgent;
  mutex: Mutex;
  cwd: string;
  lastUsedAt: number;
  createdAt: number;
  /** Full message array (client-visible turns, our reply included) this agent was last known to be in sync with. */
  lastMessages: ChatCompletionMessage[];
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isStableKey(key: string): boolean {
  return key.startsWith("explicit:") || key.startsWith("resume:");
}

/**
 * Owns the mapping from an OpenAI-style conversation to a live Cursor
 * `SDKAgent`, so multi-turn conversations can reuse native agent context
 * instead of paying to replay full history on every request.
 *
 * Three ways a request can be associated with an existing agent, checked in
 * priority order:
 *
 * 1. `metadata.cursor_agent_id` - resume a specific Cursor agent by id.
 * 2. `metadata.session_id` - an opaque id the client controls and always
 *    reuses for one logical conversation. Kept under a stable key forever
 *    (never re-hashed/evicted-by-rename) since the client depends on being
 *    able to look that exact id back up on every subsequent turn.
 * 3. Auto-session - hash `messages[0..-2]` and look for a cached agent that
 *    was last left with exactly that prefix. Enabled by default; this is
 *    what makes plain, session-unaware OpenAI clients "just work" across
 *    turns as long as they resend full history (the normal OpenAI pattern).
 *
 * Regardless of which path resolves a session, {@link computeNewSuffix}
 * figures out exactly which of the request's messages are actually new to
 * this agent - correctly handling both clients that resend full history and
 * clients that send only the new message(s) per turn under an explicit id.
 */
export class SessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(config.sessionTtlMs, 60_000));
    this.sweepTimer.unref();
  }

  async resolve(params: {
    apiKey: string;
    model: ModelSelection;
    messages: ChatCompletionMessage[];
    metadata: ChatCompletionRequestMetadata | undefined;
  }): Promise<SessionHandle> {
    const { apiKey, model, messages, metadata } = params;
    const apiKeyPart = shortHash(apiKey);

    const resumeId = metadata?.["cursor_agent_id"] ?? metadata?.["cursorAgentId"];
    if (typeof resumeId === "string" && resumeId.length > 0) {
      const key = `resume:${apiKeyPart}:${resumeId}`;
      const cached = this.entries.get(key);
      if (cached) return this.toHandle(key, cached, messages);

      const agent = await Agent.resume(resumeId, { apiKey });
      const cwd = this.ensureCwd(key);
      // A resumed agent already has real history on Cursor's side even
      // though we've never seen it locally - treat every message the client
      // sends as new content for this turn rather than "cold replay" history.
      const entry: SessionEntry = { agent, mutex: new Mutex(), cwd, lastUsedAt: Date.now(), createdAt: Date.now(), lastMessages: [] };
      this.entries.set(key, entry);
      this.enforceCapacity();
      return { agent, mutex: entry.mutex, cwd, key, isFirstTurn: false, newMessages: messages };
    }

    const explicitSessionId = metadata?.["session_id"] ?? metadata?.["sessionId"];
    if (this.config.sessionsEnabled && typeof explicitSessionId === "string" && explicitSessionId.length > 0) {
      const key = `explicit:${apiKeyPart}:${explicitSessionId}`;
      const cached = this.entries.get(key);
      if (cached) return this.toHandle(key, cached, messages);
      const entry = await this.createEntry(apiKey, model, key);
      return { agent: entry.agent, mutex: entry.mutex, cwd: entry.cwd, key, isFirstTurn: true, newMessages: messages };
    }

    if (this.config.sessionsEnabled && this.config.autoSessionEnabled && messages.length > 1) {
      const prefix = messages.slice(0, -1);
      const autoKey = `auto:${apiKeyPart}:${model.id}:${hashMessages(model.id, prefix)}`;
      const cached = this.entries.get(autoKey);
      if (cached) return this.toHandle(autoKey, cached, messages);
    }

    const freshKey = `fresh:${apiKeyPart}:${shortHash(`${Date.now()}:${Math.random()}`)}`;
    const entry = await this.createEntry(apiKey, model, freshKey);
    return { agent: entry.agent, mutex: entry.mutex, cwd: entry.cwd, key: freshKey, isFirstTurn: true, newMessages: messages };
  }

  /** Refreshes bookkeeping for this conversation's cache entry once a turn completes successfully. */
  remember(params: { apiKey: string; model: ModelSelection; messages: ChatCompletionMessage[]; handle: SessionHandle }): void {
    if (!this.config.sessionsEnabled) return;
    const { apiKey, model, messages, handle } = params;

    if (isStableKey(handle.key)) {
      const entry = this.entries.get(handle.key) ?? this.entryFromHandle(handle);
      entry.lastMessages = messages;
      entry.lastUsedAt = Date.now();
      this.entries.set(handle.key, entry);
      this.enforceCapacity();
      return;
    }

    if (!this.config.autoSessionEnabled) return;

    const apiKeyPart = shortHash(apiKey);
    const autoKey = `auto:${apiKeyPart}:${model.id}:${hashMessages(model.id, messages)}`;
    const entry = this.entries.get(handle.key) ?? this.entryFromHandle(handle);
    entry.lastMessages = messages;
    entry.lastUsedAt = Date.now();

    if (handle.key !== autoKey) this.entries.delete(handle.key);
    this.entries.set(autoKey, entry);
    this.enforceCapacity();
  }

  stats(): { cachedAgents: number; maxCachedAgents: number } {
    return { cachedAgents: this.entries.size, maxCachedAgents: this.config.maxCachedAgents };
  }

  /** Snapshot of every cached session for the admin dashboard - newest-used first. Never exposes the agent object itself, only display-safe metadata. */
  listSessions(): SessionSummary[] {
    return [...this.entries.entries()]
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .map(([key, entry]) => ({
        id: key,
        type: (key.split(":")[0] as SessionSummary["type"] | undefined) ?? "fresh",
        agentId: entry.agent.agentId,
        model: entry.agent.model?.id,
        messageCount: entry.lastMessages.length,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      }));
  }

  /** Evicts one cached session by its `id` (the same opaque string returned by `listSessions()`). Returns true if it existed. */
  evict(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.disposeEntry(id, entry, "manually evicted from admin dashboard");
    return true;
  }

  /** Evicts every cached session. Returns how many were removed. */
  evictAll(): number {
    const count = this.entries.size;
    for (const [key, entry] of [...this.entries]) {
      this.disposeEntry(key, entry, "manually cleared from admin dashboard");
    }
    return count;
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const [key, entry] of this.entries) {
      this.disposeEntry(key, entry, "server shutdown");
    }
  }

  private toHandle(key: string, entry: SessionEntry, messages: ChatCompletionMessage[]): SessionHandle {
    entry.lastUsedAt = Date.now();
    return {
      agent: entry.agent,
      mutex: entry.mutex,
      cwd: entry.cwd,
      key,
      isFirstTurn: false,
      newMessages: computeNewSuffix(entry.lastMessages, messages),
    };
  }

  private entryFromHandle(handle: SessionHandle): SessionEntry {
    return {
      agent: handle.agent,
      mutex: handle.mutex,
      cwd: handle.cwd,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      lastMessages: [],
    };
  }

  private async createEntry(apiKey: string, model: ModelSelection, key: string): Promise<SessionEntry> {
    const cwd = this.ensureCwd(key);
    const agent = await Agent.create({
      apiKey,
      model,
      name: "cursor-openai-gateway",
      mode: this.config.cursorAgentMode,
      local:
        this.config.cursorRuntime === "local"
          ? { cwd, settingSources: [], enableAgentRetries: true }
          : undefined,
      cloud: this.config.cursorRuntime === "cloud" ? {} : undefined,
    });
    const entry: SessionEntry = { agent, mutex: new Mutex(), cwd, lastUsedAt: Date.now(), createdAt: Date.now(), lastMessages: [] };
    this.entries.set(key, entry);
    this.enforceCapacity();
    return entry;
  }

  private ensureCwd(key: string): string {
    const dir = path.join(this.config.cursorWorkdirRoot, shortHash(key));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private enforceCapacity(): void {
    if (this.entries.size <= this.config.maxCachedAgents) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = this.entries.size - this.config.maxCachedAgents;
    for (let i = 0; i < excess; i += 1) {
      const item = sorted[i];
      if (!item) continue;
      const [key, entry] = item;
      this.disposeEntry(key, entry, "capacity eviction");
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.config.sessionTtlMs) {
        this.disposeEntry(key, entry, "ttl expired");
      }
    }
  }

  private disposeEntry(key: string, entry: SessionEntry, reason: string): void {
    this.entries.delete(key);
    try {
      entry.agent.close();
    } catch (err) {
      this.log.debug({ err, key, reason }, "error disposing cached Cursor agent");
    }
  }
}
