/**
 * End-to-end verification that the hold-mode tool bridge keeps ONE Cursor run
 * (one metered request) alive across a full multi-step OpenAI tool loop -
 * exactly how the native Cursor app behaves, instead of the cancel-mode
 * bridge's N separate runs.
 *
 * Runs against a RUNNING gateway with a real Cursor account (like the other
 * smoke tests). Sends a prompt that forces two sequential tool calls, answers
 * each on its own follow-up request (standard OpenAI tool loop), and asserts
 * every response carries the SAME cursor_agent_id - proving it was one run.
 *
 *   npx tsx scripts/smoke-test-hold-mode.ts
 */
import "dotenv/config";

const BASE_URL = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;
const MODEL = process.env["SMOKE_MODEL"] ?? process.env["DEFAULT_MODEL"] ?? "composer-2.5";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  },
];

interface ChatChoice {
  message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  finish_reason: string;
}
interface ChatResponse {
  choices: ChatChoice[];
  cursor_agent_id?: string;
}

type Msg = Record<string, unknown>;

async function send(messages: Msg[]): Promise<ChatResponse> {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as ChatResponse;
}

async function main(): Promise<void> {
  const agentIds = new Set<string>();
  const messages: Msg[] = [
    {
      role: "user",
      content:
        "Use the get_weather tool to check Paris, and after you get that result use it again for London. Then reply with one sentence summarizing both.",
    },
  ];

  let step = 0;
  for (;;) {
    step += 1;
    if (step > 6) throw new Error("tool loop did not converge within 6 steps");

    const resp = await send(messages);
    if (resp.cursor_agent_id) agentIds.add(resp.cursor_agent_id);
    const choice = resp.choices[0]!;
    console.log(`step ${step}: finish_reason=${choice.finish_reason} agent=${resp.cursor_agent_id ?? "?"}`);

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      messages.push({ role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls });
      for (const call of choice.message.tool_calls) {
        const city = (JSON.parse(call.function.arguments || "{}") as { city?: string }).city ?? "?";
        console.log(`   -> answering tool call ${call.id} (${call.function.name} ${city})`);
        messages.push({ role: "tool", tool_call_id: call.id, content: `${city}: 18C, partly cloudy` });
      }
      continue;
    }

    console.log(`\nfinal answer: ${(choice.message.content ?? "").slice(0, 200)}`);
    break;
  }

  console.log(`\ndistinct cursor_agent_ids across the whole loop: ${agentIds.size} -> ${[...agentIds].join(", ")}`);
  if (agentIds.size === 1) {
    console.log("PASS: the entire multi-tool loop ran on ONE Cursor run/agent (native-app-equivalent behavior).");
  } else {
    console.error(`FAIL: expected exactly 1 agent id, saw ${agentIds.size}. Hold mode is not keeping the run alive.`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("crashed:", err);
  process.exitCode = 1;
});
