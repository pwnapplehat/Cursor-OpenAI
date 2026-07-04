import type { SDKCustomTool, SDKCustomToolContent, SDKImage, SDKJsonValue } from "@cursor/sdk";
import type { ChatCompletionTool } from "../types/openai";
import { newToolCallId } from "../utils/ids";

export interface HeldToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * A client-supplied result for a parked tool call. `images` carries any image
 * parts the client embedded in its `tool` message (e.g. screenshots from a
 * vision-capable tool loop); they are forwarded to the model as real image
 * blocks rather than being flattened away with the text.
 */
export interface HeldToolResult {
  id: string;
  content: string;
  images?: SDKImage[];
}

interface ParkedCall extends HeldToolCall {
  resolveResult: (content: SDKCustomToolContent[]) => void;
}

/**
 * Converts a client tool result into SDK custom-tool content blocks. Base64
 * images become real `image` blocks (the SDK delivers them to the model as
 * pixels - this is what keeps screenshots visible to vision-capable models
 * across a held tool loop). URL-only images cannot be expressed as
 * `SDKCustomToolContent`, so they are referenced in a text block instead of
 * being dropped silently.
 */
function toCustomToolContent(result: { content: string; images?: SDKImage[] }): SDKCustomToolContent[] {
  const blocks: SDKCustomToolContent[] = [];
  const images = result.images ?? [];
  if (result.content.length > 0 || images.length === 0) {
    blocks.push({ type: "text", text: result.content });
  }
  for (const image of images) {
    if ("data" in image) {
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
    } else {
      blocks.push({ type: "text", text: `[image: ${image.url}]` });
    }
  }
  return blocks;
}

/**
 * The "hold mode" counterpart to {@link ToolCallCapture}.
 *
 * In cancel mode, the first tool call cancels the Cursor run and the gateway
 * returns `tool_calls`; the client's follow-up starts a brand-new run. That
 * turns one logical OpenAI tool loop into N separately-metered Cursor runs.
 *
 * In hold mode we instead keep the run alive. Each registered custom tool's
 * `execute()` callback *parks* here - returning a Promise that stays pending -
 * so from Cursor's side the single run is simply "waiting on its tools", which
 * is exactly how the native app behaves. The gateway returns the parked
 * call(s) as an OpenAI `tool_calls` response; when the client sends the tool
 * result back on its next request, {@link provideResults} resolves the parked
 * Promise, `execute()` returns, and the SAME run continues. The whole tool
 * loop is therefore one Cursor run / one metered request.
 *
 * The SDK invokes `execute()` for parallel tool calls concurrently (verified
 * live), so this gate collects a *batch*: {@link waitForBatch} returns once at
 * least one call has parked and the set has settled (no new calls for a short
 * window), letting the gateway answer all of a turn's parallel calls together.
 * This also removes cancel mode's "only the first tool call is observed"
 * limitation.
 */
export class HeldToolGate {
  private readonly parked = new Map<string, ParkedCall>();
  private pendingBatch: ParkedCall[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  private notify(): void {
    const current = this.waiters;
    this.waiters = [];
    for (const resolve of current) resolve();
  }

  private waitForSignal(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private park(call: HeldToolCall): Promise<SDKCustomToolContent[]> {
    return new Promise<SDKCustomToolContent[]>((resolve) => {
      if (this.closed) {
        resolve([{ type: "text", text: HeldToolGate.ABANDONED_RESULT }]);
        return;
      }
      const parked: ParkedCall = { ...call, resolveResult: resolve };
      this.parked.set(call.id, parked);
      this.pendingBatch.push(parked);
      this.notify();
    });
  }

  /**
   * Resolves once at least one tool call has parked and the batch has settled
   * (`settleMs` with no additional calls arriving), returning that batch and
   * clearing it. Returns an empty array if the gate is closed before any call
   * fires (used to unblock the pump on teardown).
   */
  async waitForBatch(settleMs: number): Promise<HeldToolCall[]> {
    while (this.pendingBatch.length === 0) {
      if (this.closed) return [];
      await this.waitForSignal();
    }
    // Settle: wait until the count stops growing, so all of a turn's
    // concurrently-dispatched parallel calls land in the same batch.
    let previousCount = -1;
    while (this.pendingBatch.length !== previousCount) {
      previousCount = this.pendingBatch.length;
      await delay(settleMs);
      if (this.closed) break;
    }
    const batch = this.pendingBatch.map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson }));
    this.pendingBatch = [];
    return batch;
  }

  /** Resolves parked calls with their results; returns how many matched. Unmatched ids are ignored (the caller decides what that means). */
  provideResults(results: HeldToolResult[]): number {
    let matched = 0;
    for (const result of results) {
      const parked = this.parked.get(result.id);
      if (parked) {
        this.parked.delete(result.id);
        parked.resolveResult(toCustomToolContent(result));
        matched += 1;
      }
    }
    return matched;
  }

  /** Ids of calls that have parked but not yet received a result. */
  get pendingIds(): string[] {
    return [...this.parked.keys()];
  }

  hasPending(): boolean {
    return this.parked.size > 0;
  }

  /**
   * Tears the gate down: any still-parked `execute()` callbacks are resolved
   * with an "abandoned" marker so the underlying run unwinds instead of
   * hanging forever, and future parks resolve immediately. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, parked] of this.parked) {
      this.parked.delete(id);
      parked.resolveResult([{ type: "text", text: HeldToolGate.ABANDONED_RESULT }]);
    }
    this.notify();
  }

  static readonly ABANDONED_RESULT = "(tool call abandoned: the gateway stopped waiting for a result)";

  /**
   * Builds the Cursor `SDKCustomTool` map whose `execute()` callbacks park in
   * this gate. Mirrors {@link buildBridgedCustomTools}'s schema handling but
   * awaits the client-supplied result instead of returning a placeholder.
   */
  buildCustomTools(tools: ChatCompletionTool[] | undefined): Record<string, SDKCustomTool> | undefined {
    const functionTools = (tools ?? []).filter((tool) => tool.type === "function");
    if (functionTools.length === 0) return undefined;

    const customTools: Record<string, SDKCustomTool> = {};
    for (const tool of functionTools) {
      const fn = tool.function;
      customTools[fn.name] = {
        description: fn.description,
        inputSchema: (fn.parameters as Record<string, SDKJsonValue> | undefined) ?? {},
        execute: async (args, context) => {
          const id = context.toolCallId ?? newToolCallId();
          const content = await this.park({ id, name: fn.name, argumentsJson: safeStringify(args) });
          return { content };
        },
      };
    }
    return customTools;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
