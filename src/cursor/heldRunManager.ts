import type { ModelSelection, Run, SDKAgent, SDKCustomTool, SDKMessage, SDKUserMessage, TokenUsage } from "@cursor/sdk";
import type { Logger } from "../logger";
import { TextAccumulator } from "../utils/textAccumulator";
import { consumeSdkMessage, type RunSink } from "./runController";
import type { HeldToolGate, HeldToolCall } from "./heldToolGate";
import { HttpError } from "../errors";
import type { CursorAgentModeOption } from "../config";
import { newToolCallId } from "../utils/ids";

/**
 * Keeps a single Cursor run alive across multiple HTTP requests so an entire
 * OpenAI-style tool loop maps to ONE metered Cursor run - the way the native
 * Cursor app behaves - instead of the cancel-and-restart bridge's N runs.
 *
 * How it works: each registered custom tool's `execute()` callback *parks* in
 * a {@link HeldToolGate} (returns a still-pending Promise), so from Cursor's
 * side the one run is simply "waiting on its tools" - exactly the native
 * behavior. The gateway returns the parked call(s) as an OpenAI `tool_calls`
 * response and RETAINS the run. When the client's next request carries the
 * matching `tool` result message(s), the parked Promise(s) resolve, `execute()`
 * returns, and the SAME run continues. Verified against the live Cursor API:
 * one run survives multiple 30-45s cross-request gaps and multiple sequential
 * tool calls, and the SDK dispatches parallel tool calls concurrently (so a
 * batch is answered together).
 *
 * Held runs are looked up on the continuation request by `tool_call_id` (which
 * the client echoes in its `tool` message) - the most robust key, independent
 * of session-id / auto-session-hash behavior. A per-hold inactivity timer
 * bounds how long a run may wait for a result the client never sends.
 */
export interface HeldRunSegment {
  status: "tool_calls" | "final";
  content: string;
  reasoningContent: string;
  toolCalls: HeldToolCall[];
  usage: TokenUsage | undefined;
  agentId: string;
  runId: string;
  model: ModelSelection | undefined;
}

interface HeldRunState {
  run: Run;
  iterator: ReturnType<Run["stream"]>;
  /**
   * An `iterator.next()` promise started in a previous pump that lost the race
   * to the tool batch and is therefore still outstanding. It MUST be reused (not
   * re-issued) on the next pump: async generators queue concurrent `.next()`
   * calls, so a fresh call would let this pending one swallow the first message
   * the run emits after the tool result resolves. Preserving it is what makes
   * one run correctly span multiple HTTP requests.
   */
  pendingNext: Promise<IteratorResult<SDKMessage, void>> | undefined;
  gate: HeldToolGate;
  textAcc: TextAccumulator;
  reasoningAcc: TextAccumulator;
  /** Called exactly once when the run reaches a terminal state (final segment or teardown) - releases the session mutex + concurrency slot and cleans caller-side context. */
  onRelease: () => void;
  onAbort: (() => void) | undefined;
  abortSignal: AbortSignal | undefined;
  timeoutHandle: NodeJS.Timeout | undefined;
  toolResultTimeoutMs: number;
  batchSettleMs: number;
  includeThinking: boolean;
  log: Logger;
  agentId: string;
  runId: string;
  settled: boolean;
}

export interface StartHeldRunParams {
  agent: SDKAgent;
  message: string | SDKUserMessage;
  model: ModelSelection;
  agentMode: CursorAgentModeOption;
  customTools: Record<string, SDKCustomTool>;
  gate: HeldToolGate;
  includeThinking: boolean;
  toolResultTimeoutMs: number;
  batchSettleMs: number;
  onRelease: () => void;
  sink: RunSink | undefined;
  log: Logger;
  abortSignal: AbortSignal | undefined;
}

export class HeldRunManager {
  private readonly held = new Map<string, HeldRunState>();
  private readonly byToolCallId = new Map<string, string>();

  constructor(private readonly log: Logger) {}

  /** Runs currently parked waiting on a tool result (diagnostics/health). */
  get heldCount(): number {
    return this.held.size;
  }

  /** Resolves the agent id of the held run that owns `toolCallId`, if any. */
  findAgentByToolCallId(toolCallId: string): string | undefined {
    return this.byToolCallId.get(toolCallId);
  }

  async start(params: StartHeldRunParams): Promise<HeldRunSegment> {
    const run: Run = await params.agent.send(params.message, {
      model: params.model,
      mode: params.agentMode,
      local: { customTools: params.customTools },
    });
    params.log.info({ runId: run.id, agentId: run.agentId }, "cursor run started (hold mode)");

    const state: HeldRunState = {
      run,
      iterator: run.stream(),
      pendingNext: undefined,
      gate: params.gate,
      textAcc: new TextAccumulator(),
      reasoningAcc: new TextAccumulator(),
      onRelease: params.onRelease,
      onAbort: undefined,
      abortSignal: params.abortSignal,
      timeoutHandle: undefined,
      toolResultTimeoutMs: params.toolResultTimeoutMs,
      batchSettleMs: params.batchSettleMs,
      includeThinking: params.includeThinking,
      log: params.log,
      agentId: run.agentId,
      runId: run.id,
      settled: false,
    };

    this.armAbort(state);
    return this.pump(state, params.sink);
  }

  async provideResultsAndContinue(
    agentId: string,
    results: Array<{ id: string; content: string }>,
    opts: { sink: RunSink | undefined; abortSignal: AbortSignal | undefined; log: Logger },
  ): Promise<HeldRunSegment> {
    const state = this.held.get(agentId);
    if (!state) {
      throw HttpError.badRequest(
        `No held Cursor run is waiting for tool results on agent "${agentId}". It may have timed out, completed, or never existed.`,
      );
    }
    // Detach from the waiting registries; pump() re-registers if it parks again.
    this.forget(agentId);
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    this.disarmAbort(state);

    // Swap in this request's abort signal + logger for the new segment.
    state.abortSignal = opts.abortSignal;
    state.log = opts.log;
    this.armAbort(state);

    const matched = state.gate.provideResults(results);
    opts.log.debug({ agentId, provided: results.length, matched }, "provided tool results to held run");

    return this.pump(state, opts.sink);
  }

  /** Tears down and forgets a held run (e.g. the follow-up request errored before continuing). Safe if unknown. */
  abandon(agentId: string, reason: string): void {
    const state = this.held.get(agentId);
    if (!state) return;
    this.forget(agentId);
    this.teardown(state, reason);
  }

  shutdown(): void {
    for (const [agentId, state] of [...this.held]) {
      this.forget(agentId);
      this.teardown(state, "server shutdown");
    }
  }

  private async pump(state: HeldRunState, sink: RunSink | undefined): Promise<HeldRunSegment> {
    const { run, gate, textAcc, reasoningAcc, log } = state;
    try {
      const batchWait = gate.waitForBatch(state.batchSettleMs);
      let toolBatch: HeldToolCall[] = [];

      for (;;) {
        // Reuse an outstanding next() from a prior segment if present, so the
        // message that arrives right after a tool result isn't dropped.
        const nextPromise = state.pendingNext ?? state.iterator.next();
        state.pendingNext = nextPromise;

        const winner = await Promise.race([
          nextPromise.then((value) => ({ kind: "message" as const, value })),
          batchWait.then((batch) => ({ kind: "tools" as const, batch })),
        ]);

        if (winner.kind === "tools") {
          // Leave state.pendingNext in place - it's still pending and will be
          // consumed by the next pump after tool results are provided.
          toolBatch = winner.batch;
          break;
        }
        // The awaited next() is consumed; clear the slot so the loop issues a fresh one.
        state.pendingNext = undefined;
        if (winner.value.done) break;
        consumeSdkMessage(winner.value.value, textAcc, reasoningAcc, sink, state.includeThinking, log);
      }

      if (toolBatch.length > 0) {
        const toolCalls: HeldToolCall[] = toolBatch.map((c) => ({
          id: c.id || newToolCallId(),
          name: c.name,
          argumentsJson: c.argumentsJson,
        }));
        for (const call of toolCalls) sink?.onToolCallStarted?.(call);

        // Retain the run, index its pending tool-call ids, arm the timer.
        this.held.set(state.agentId, state);
        for (const call of toolCalls) this.byToolCallId.set(call.id, state.agentId);
        state.timeoutHandle = setTimeout(() => {
          log.warn({ agentId: state.agentId, runId: state.runId }, "held run timed out waiting for tool results; tearing down");
          this.forget(state.agentId);
          this.teardown(state, "tool-result timeout");
        }, state.toolResultTimeoutMs);
        state.timeoutHandle.unref?.();

        return {
          status: "tool_calls",
          content: textAcc.current,
          reasoningContent: reasoningAcc.current,
          toolCalls,
          usage: run.usage,
          agentId: state.agentId,
          runId: state.runId,
          model: run.model,
        };
      }

      // Stream ended with nothing parked: the run is finishing.
      const result = await run.wait().catch((err: unknown) => {
        log.debug({ err, runId: run.id }, "run.wait() rejected at hold-mode completion");
        return undefined;
      });
      this.settle(state);

      if (result?.status === "error") {
        throw HttpError.internal(
          `Cursor agent run ${run.id} (agent ${run.agentId}) finished with status "error". ` +
            "Inspect this run in the Cursor dashboard or via Agent.getRun() for details.",
        );
      }

      return {
        status: "final",
        content: textAcc.current,
        reasoningContent: reasoningAcc.current,
        toolCalls: [],
        usage: result?.usage ?? run.usage,
        agentId: state.agentId,
        runId: state.runId,
        model: result?.model ?? run.model,
      };
    } catch (err) {
      this.forget(state.agentId);
      this.teardown(state, "pump error");
      throw err;
    }
  }

  private armAbort(state: HeldRunState): void {
    if (!state.abortSignal) return;
    const onAbort = (): void => {
      state.log.debug({ runId: state.runId }, "client aborted a held run; tearing down");
      this.forget(state.agentId);
      this.teardown(state, "client aborted");
    };
    state.onAbort = onAbort;
    state.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  private disarmAbort(state: HeldRunState): void {
    if (state.abortSignal && state.onAbort) {
      state.abortSignal.removeEventListener("abort", state.onAbort);
    }
    state.onAbort = undefined;
  }

  /** Removes a run from both lookup registries without tearing it down (used before continuing). */
  private forget(agentId: string): void {
    const state = this.held.get(agentId);
    this.held.delete(agentId);
    if (state) {
      for (const [id, owner] of [...this.byToolCallId]) {
        if (owner === agentId) this.byToolCallId.delete(id);
      }
      if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    }
  }

  /** Clean terminal path (run finished normally): release resources exactly once. */
  private settle(state: HeldRunState): void {
    if (state.settled) return;
    state.settled = true;
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    this.disarmAbort(state);
    this.safeRelease(state);
  }

  /** Abnormal terminal path: free parked callbacks, cancel the run, release resources. Idempotent. */
  private teardown(state: HeldRunState, reason: string): void {
    if (state.settled) return;
    state.settled = true;
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    this.disarmAbort(state);
    state.gate.close();
    state.run.cancel().catch((err: unknown) => state.log.debug({ err, runId: state.runId, reason }, "held-run cancel failed"));
    this.safeRelease(state);
    this.log.debug({ agentId: state.agentId, runId: state.runId, reason }, "held run torn down");
  }

  private safeRelease(state: HeldRunState): void {
    try {
      state.onRelease();
    } catch (err) {
      this.log.debug({ err, agentId: state.agentId }, "held-run onRelease threw (ignored)");
    }
  }
}
