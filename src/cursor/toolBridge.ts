import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import type { ChatCompletionTool } from "../types/openai";
import { newToolCallId } from "../utils/ids";

export interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * One-shot signal used to bridge OpenAI-style "the model wants to call a
 * client-side function" semantics onto Cursor's SDK, which executes
 * registered custom tools inline inside its own agent loop rather than
 * pausing for an external caller.
 *
 * We register each OpenAI `tools[]` function as a Cursor `SDKCustomTool`.
 * When the agent decides to invoke one, our `execute()` callback fires with
 * the call's arguments; instead of doing real work (we don't have the
 * client's implementation, only its JSON schema) we capture the call here and
 * the run controller cancels the underlying Cursor run, translating the
 * captured call into an OpenAI `tool_calls` response so the *actual* calling
 * application can execute it and continue the conversation with a `tool`
 * role message on its next request - exactly like talking to OpenAI directly.
 *
 * Limitation (documented in README): only the first tool call requested in a
 * turn is captured. If a turn wants to call multiple tools in parallel,
 * subsequent calls in that same turn are not observed because the run is
 * cancelled as soon as the first one fires.
 */
export class ToolCallCapture {
  private resolveFn?: (call: PendingToolCall) => void;
  private readonly promise: Promise<PendingToolCall>;
  private resolved = false;

  constructor() {
    this.promise = new Promise<PendingToolCall>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  wait(): Promise<PendingToolCall> {
    return this.promise;
  }

  capture(call: PendingToolCall): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveFn?.(call);
  }

  get hasCaptured(): boolean {
    return this.resolved;
  }
}

export function buildBridgedCustomTools(
  tools: ChatCompletionTool[] | undefined,
  capture: ToolCallCapture,
): Record<string, SDKCustomTool> | undefined {
  const functionTools = (tools ?? []).filter((tool) => tool.type === "function");
  if (functionTools.length === 0) return undefined;

  const customTools: Record<string, SDKCustomTool> = {};
  for (const tool of functionTools) {
    const fn = tool.function;
    customTools[fn.name] = {
      description: fn.description,
      inputSchema: (fn.parameters as Record<string, SDKJsonValue> | undefined) ?? {},
      execute: (args, context) => {
        const id = context.toolCallId ?? newToolCallId();
        capture.capture({ id, name: fn.name, argumentsJson: safeStringify(args) });
        return {
          content: [
            {
              type: "text",
              text: "(deferred: this call is answered by the requesting application, not executed by the gateway)",
            },
          ],
        };
      },
    };
  }
  return customTools;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
