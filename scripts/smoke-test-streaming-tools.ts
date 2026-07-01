/** Manual verification: streaming mode combined with the tool-calling bridge (the one combination not covered by the other smoke scripts). */
import "dotenv/config";

const BASE_URL = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;
const MODEL = process.env["SMOKE_MODEL"] ?? process.env["DEFAULT_MODEL"] ?? "composer-2.5";

async function main(): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    console.error(`FAIL: status ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawToolCallStart = false;
  let sawToolCallArgs = false;
  let sawFinishReasonToolCalls = false;
  let sawDone = false;
  const chunks: unknown[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      const parsed = JSON.parse(payload) as {
        choices: Array<{ delta: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason: string | null }>;
      };
      chunks.push(parsed);
      const choice = parsed.choices[0];
      if (choice?.delta.tool_calls?.some((tc) => tc.id && tc.function?.name)) sawToolCallStart = true;
      if (choice?.delta.tool_calls?.some((tc) => tc.function?.arguments)) sawToolCallArgs = true;
      if (choice?.finish_reason === "tool_calls") sawFinishReasonToolCalls = true;
    }
  }

  console.log(`Received ${chunks.length} SSE chunks. Full stream:`);
  console.log(JSON.stringify(chunks, null, 2));

  const checks = { sawToolCallStart, sawToolCallArgs, sawFinishReasonToolCalls, sawDone };
  console.log("\nChecks:", checks);

  if (!Object.values(checks).every(Boolean)) {
    console.error("FAIL: streaming + tool-calling bridge did not behave as expected");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: streaming tool-call chunks (start + arguments), finish_reason=tool_calls, and [DONE] all observed correctly.");
}

main().catch((err: unknown) => {
  console.error("crashed:", err);
  process.exitCode = 1;
});
