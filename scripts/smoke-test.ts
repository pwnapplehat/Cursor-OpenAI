/**
 * End-to-end smoke test against a *running* instance of this gateway,
 * exercising real Cursor agent runs (this costs real Cursor usage - don't
 * run it in a tight loop). Start the server first (`npm run dev` or
 * `npm start`), then run `npm run smoke`.
 */
import "dotenv/config";

const BASE_URL = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;
const AUTH_KEY = process.env["AUTH_KEY"];
const MODEL = process.env["SMOKE_MODEL"] ?? process.env["DEFAULT_MODEL"] ?? "composer-2.5";

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_KEY) h["Authorization"] = `Bearer ${AUTH_KEY}`;
  return h;
}

async function record(name: string, fn: () => Promise<string>): Promise<void> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail: `${detail} (${Date.now() - startedAt}ms)` });
    console.log(`PASS  ${name} - ${detail} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail });
    console.error(`FAIL  ${name} - ${detail}`);
  }
}

async function main(): Promise<void> {
  console.log(`Running smoke tests against ${BASE_URL} (model: ${MODEL})\n`);

  await record("GET /health", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { status: string };
    if (body.status !== "ok") throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    return "status ok";
  });

  await record("GET /v1/models", async () => {
    const res = await fetch(`${BASE_URL}/v1/models`, { headers: headers() });
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    if (!Array.isArray(body.data) || body.data.length === 0) throw new Error("model list was empty");
    return `${body.data.length} models, e.g. ${body.data[0]!.id}`;
  });

  await record("POST /v1/chat/completions (non-streaming)", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "Reply with exactly one short sentence. No markdown." },
          { role: "user", content: "Say hello and name the current AI coding tool you are running on top of." },
        ],
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: unknown };
    const content = body.choices[0]?.message.content ?? "";
    if (!content || content.trim().length === 0) throw new Error("empty completion content");
    return `got ${content.length} chars: "${content.slice(0, 80).replace(/\n/g, " ")}${content.length > 80 ? "..." : ""}"`;
  });

  let sessionMetadata: Record<string, string> = {};
  await record("POST /v1/chat/completions (streaming + session continuity)", async () => {
    const sessionId = `smoke-${Date.now()}`;
    sessionMetadata = { session_id: sessionId };
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        metadata: sessionMetadata,
        messages: [{ role: "user", content: "Remember the secret word: pineapple. Reply with just \"ok\"." }],
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    if (!res.body) throw new Error("no response body stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkCount = 0;
    let sawDone = false;
    let sawUsage = false;

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
        chunkCount += 1;
        const parsed = JSON.parse(payload) as { usage?: unknown };
        if (parsed.usage) sawUsage = true;
      }
    }
    if (!sawDone) throw new Error("stream never sent [DONE]");
    if (chunkCount === 0) throw new Error("no chunks received");
    if (!sawUsage) throw new Error("final chunk did not include usage despite stream_options.include_usage");
    return `${chunkCount} SSE chunks, [DONE] received, usage present`;
  });

  await record("POST /v1/chat/completions (follow-up reuses the session)", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        metadata: sessionMetadata,
        messages: [{ role: "user", content: "What was the secret word I told you? Reply with just the word." }],
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = (body.choices[0]?.message.content ?? "").toLowerCase();
    if (!content.includes("pineapple")) {
      throw new Error(`expected the agent to recall "pineapple" from the earlier turn, got: "${content}"`);
    }
    return `agent correctly recalled the session: "${content.trim()}"`;
  });

  await record("POST /v1/completions (legacy)", async () => {
    const res = await fetch(`${BASE_URL}/v1/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: MODEL, prompt: "Reply with just the word: banana" }),
    });
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices: Array<{ text: string }> };
    const text = body.choices[0]?.text ?? "";
    if (!text) throw new Error("empty legacy completion text");
    return `got: "${text.trim().slice(0, 60)}"`;
  });

  await record("POST /v1/embeddings returns a clear not-implemented error", async () => {
    const res = await fetch(`${BASE_URL}/v1/embeddings`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: MODEL, input: "hi" }),
    });
    if (res.status !== 501) throw new Error(`expected 501, got ${res.status}`);
    const body = (await res.json()) as { error: { message: string } };
    if (!body.error?.message) throw new Error("error body missing message");
    return `501 as expected: "${body.error.message.slice(0, 60)}..."`;
  });

  console.log("\nSummary:");
  const passed = results.filter((r) => r.passed).length;
  console.log(`${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test runner crashed:", err);
  process.exitCode = 1;
});
