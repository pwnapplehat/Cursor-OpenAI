/** Manual verification script for the OpenAI tool-calling bridge (not part of the main smoke suite since tool-calling behavior is more model-dependent). */
import "dotenv/config";

const BASE_URL = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;
const MODEL = process.env["SMOKE_MODEL"] ?? process.env["DEFAULT_MODEL"] ?? "composer-2.5";

const sessionId = `tool-smoke-${Date.now()}`;
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

async function main(): Promise<void> {
  console.log("Step 1: ask a question that should trigger the get_weather tool...");
  const userMessage = { role: "user" as const, content: "What is the weather in Paris right now? Use the get_weather tool to find out." };
  const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      metadata: { session_id: sessionId },
      messages: [userMessage],
      tools,
    }),
  });
  const body1 = (await res1.json()) as {
    choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }>;
  };
  console.log("Response 1:", JSON.stringify(body1, null, 2));

  const choice = body1.choices[0]!;
  if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
    console.error("FAIL: expected finish_reason=tool_calls with a populated tool_calls array");
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: model requested tool "${choice.message.tool_calls[0]!.function.name}" with args ${choice.message.tool_calls[0]!.function.arguments}`);

  console.log("\nStep 2: submit the tool result and confirm the agent continues coherently...");
  const toolCall = choice.message.tool_calls[0]!;
  const res2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      metadata: { session_id: sessionId },
      tools,
      messages: [
        userMessage,
        { role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls },
        { role: "tool", tool_call_id: toolCall.id, content: "Paris: 18C, partly cloudy, light breeze." },
      ],
    }),
  });
  const body2 = (await res2.json()) as { choices: Array<{ message: { content: string | null }; finish_reason: string }> };
  console.log("Response 2:", JSON.stringify(body2, null, 2));
  const finalText = (body2.choices[0]?.message.content ?? "").toLowerCase();
  if (!finalText.includes("18") && !finalText.includes("cloud")) {
    console.error('FAIL: expected the follow-up answer to reference the tool result ("18C" / "cloudy")');
    process.exitCode = 1;
    return;
  }
  console.log("PASS: agent's follow-up answer correctly used the tool result.");
}

main().catch((err: unknown) => {
  console.error("crashed:", err);
  process.exitCode = 1;
});
