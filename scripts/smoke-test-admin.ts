/**
 * End-to-end verification of the admin API / setup wizard backend, against a
 * running instance and a real Cursor account. Not part of `npm test` (needs
 * network + a live server); run manually with `npx tsx scripts/smoke-test-admin.ts`.
 *
 * Expects the server to currently be freshly booted with NO Cursor API key
 * configured (setupComplete === false) - it will complete setup itself.
 */
import "dotenv/config";

let BASE_URL = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`;
const REAL_CURSOR_API_KEY = process.env["SMOKE_CURSOR_API_KEY"];

if (!REAL_CURSOR_API_KEY) {
  console.error("Set SMOKE_CURSOR_API_KEY to a real Cursor API key to run this script.");
  process.exit(1);
}

let adminKey = "";
const results: Array<{ name: string; passed: boolean; detail: string }> = [];

async function record(name: string, fn: () => Promise<string>): Promise<void> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail });
    console.log(`PASS  ${name} - ${detail} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail });
    console.error(`FAIL  ${name} - ${detail}`);
  }
}

async function json(path: string, options: RequestInit = {}, useAdminAuth = true): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (useAdminAuth && adminKey) headers.set("Authorization", `Bearer ${adminKey}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`Running admin smoke tests against ${BASE_URL}\n`);

  await record("GET /api/admin/status before setup", async () => {
    const { status, body } = await json("/api/admin/status", {}, false);
    const b = body as { setupComplete: boolean };
    if (status !== 200) throw new Error(`status ${status}`);
    if (b.setupComplete !== false) throw new Error("expected setupComplete: false on a fresh boot");
    return "setupComplete: false, as expected";
  });

  let previewedModelCount = 0;
  await record("POST /api/admin/setup/preview-models (before setup, no auth required)", async () => {
    const { status, body } = await json("/api/admin/setup/preview-models", { method: "POST", body: JSON.stringify({ cursorApiKey: REAL_CURSOR_API_KEY }) }, false);
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(body)}`);
    const b = body as { user: { userEmail?: string }; models: unknown[] };
    previewedModelCount = b.models.length;
    if (previewedModelCount === 0) throw new Error("expected a non-empty model list");
    return `verified as ${b.user.userEmail}, ${previewedModelCount} models available`;
  });

  await record("POST /api/admin/setup/preview-models rejects a bad key", async () => {
    const { status } = await json("/api/admin/setup/preview-models", { method: "POST", body: JSON.stringify({ cursorApiKey: "crsr_definitely_not_a_real_key" }) }, false);
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
    return "400 as expected";
  });

  await record("POST /api/admin/setup completes setup and issues an admin key", async () => {
    const { status, body } = await json(
      "/api/admin/setup",
      { method: "POST", body: JSON.stringify({ cursorApiKey: REAL_CURSOR_API_KEY, defaultModel: "composer-2.5", generateAuthKey: true }) },
      false,
    );
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(body)}`);
    const b = body as { success: boolean; authKey: string | null };
    if (!b.success || !b.authKey) throw new Error("expected success + an issued authKey");
    adminKey = b.authKey;
    return `issued admin key ${adminKey.slice(0, 8)}...`;
  });

  await record("GET /api/admin/status after setup", async () => {
    const { body } = await json("/api/admin/status", {}, false);
    const b = body as { setupComplete: boolean; authRequired: boolean };
    if (!b.setupComplete || !b.authRequired) throw new Error(`unexpected: ${JSON.stringify(b)}`);
    return "setupComplete: true, authRequired: true";
  });

  await record("Protected admin routes reject requests with no/invalid admin key", async () => {
    const noAuth = await json("/api/admin/config", {}, false);
    if (noAuth.status !== 401) throw new Error(`expected 401 with no key, got ${noAuth.status}`);
    const badAuth = await json("/api/admin/config", { headers: { Authorization: "Bearer wrong-key" } }, false);
    if (badAuth.status !== 401) throw new Error(`expected 401 with wrong key, got ${badAuth.status}`);
    return "401 in both cases, as expected";
  });

  await record("POST /api/admin/login accepts the correct key and rejects a wrong one", async () => {
    const good = await json("/api/admin/login", { method: "POST", body: JSON.stringify({ authKey: adminKey }) }, false);
    if (good.status !== 200) throw new Error(`correct key: expected 200, got ${good.status}`);
    const bad = await json("/api/admin/login", { method: "POST", body: JSON.stringify({ authKey: "nope" }) }, false);
    if (bad.status !== 401) throw new Error(`wrong key: expected 401, got ${bad.status}`);
    return "200 then 401, as expected";
  });

  await record("GET /api/admin/config returns a redacted snapshot", async () => {
    const { status, body } = await json("/api/admin/config");
    if (status !== 200) throw new Error(`status ${status}`);
    const b = body as { cursorApiKey: string; authKey: string; hasCursorApiKey: boolean; defaultModel: string };
    if (b.cursorApiKey === REAL_CURSOR_API_KEY) throw new Error("cursorApiKey was NOT masked - this would be a real secret leak");
    if (!b.hasCursorApiKey) throw new Error("expected hasCursorApiKey: true");
    if (b.defaultModel !== "composer-2.5") throw new Error(`expected defaultModel composer-2.5, got ${b.defaultModel}`);
    return `masked key: ${b.cursorApiKey}, defaultModel: ${b.defaultModel}`;
  });

  await record("GET /api/admin/account returns real verified account info", async () => {
    const { status, body } = await json("/api/admin/account");
    if (status !== 200) throw new Error(`status ${status}`);
    const b = body as { account: { userEmail?: string; apiKeyName?: string } | null };
    if (!b.account) throw new Error("expected a non-null account");
    return `account: ${b.account.userEmail ?? b.account.apiKeyName}`;
  });

  await record("GET /api/admin/models returns the live catalog", async () => {
    const { status, body } = await json("/api/admin/models");
    if (status !== 200) throw new Error(`status ${status}`);
    const b = body as { models: Array<{ id: string }> };
    if (b.models.length === 0) throw new Error("expected a non-empty model list");
    return `${b.models.length} models`;
  });

  await record("PATCH /api/admin/config updates a field live", async () => {
    const { status, body } = await json("/api/admin/config", { method: "PATCH", body: JSON.stringify({ defaultModel: "auto" }) });
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(body)}`);
    const b = body as { defaultModel: string; restartRequired: boolean };
    if (b.defaultModel !== "auto") throw new Error(`expected defaultModel "auto", got ${b.defaultModel}`);
    if (b.restartRequired) throw new Error("changing defaultModel should not require a restart");
    // restore it
    await json("/api/admin/config", { method: "PATCH", body: JSON.stringify({ defaultModel: "composer-2.5" }) });
    return "updated to auto and restored";
  });

  await record("PATCH /api/admin/config rejects invalid values", async () => {
    const { status, body } = await json("/api/admin/config", { method: "PATCH", body: JSON.stringify({ maxConcurrentRuns: -5 }) });
    if (status !== 400) throw new Error(`expected 400, got ${status}: ${JSON.stringify(body)}`);
    return "400 as expected";
  });

  await record("POST /api/admin/test-chat runs a real message through the gateway", async () => {
    const { status, body } = await json("/api/admin/test-chat", { method: "POST", body: JSON.stringify({ message: "Reply with just the word: kiwi" }) });
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(body)}`);
    const b = body as { content: string };
    if (!b.content) throw new Error("expected non-empty content");
    return `got: "${b.content.trim().slice(0, 60)}"`;
  });

  await record("PATCH /api/admin/config rebinds the HTTP server on a new port", async () => {
    const newPort = 8799;
    const { status, body } = await json("/api/admin/config", { method: "PATCH", body: JSON.stringify({ port: newPort }) });
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(body)}`);
    const b = body as { port: number; restartRequired: boolean };
    if (b.port !== newPort || !b.restartRequired) throw new Error(`unexpected: ${JSON.stringify(b)}`);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const oldPortStillUp = await fetch(`${BASE_URL}/health`).then(
      () => true,
      () => false,
    );
    BASE_URL = BASE_URL.replace(/:\d+$/, `:${newPort}`);
    const newPortRes = await fetch(`${BASE_URL}/health`);
    if (!newPortRes.ok) throw new Error("new port did not come up");
    return `old port down: ${!oldPortStillUp}, new port ${newPort} up: ${newPortRes.ok}`;
  });

  await record("POST /api/admin/regenerate-auth-key rotates the key and invalidates the old one", async () => {
    const oldKey = adminKey;
    const { status, body } = await json("/api/admin/regenerate-auth-key", { method: "POST" });
    if (status !== 200) throw new Error(`status ${status}`);
    const b = body as { authKey: string };
    adminKey = b.authKey;
    if (adminKey === oldKey) throw new Error("expected a different key");
    const oldKeyRejected = await json("/api/admin/config", { headers: { Authorization: `Bearer ${oldKey}` } }, false);
    if (oldKeyRejected.status !== 401) throw new Error("old key should now be rejected");
    return "new key issued, old key rejected";
  });

  await record("GET / serves the dashboard HTML", async () => {
    const res = await fetch(`${BASE_URL}/`);
    const text = await res.text();
    if (!res.ok) throw new Error(`status ${res.status}`);
    if (!text.includes("Cursor OpenAI Gateway")) throw new Error("index.html did not contain expected title text");
    return `content-type: ${res.headers.get("content-type")}`;
  });

  await record("GET /app.js and /styles.css are served", async () => {
    const js = await fetch(`${BASE_URL}/app.js`);
    const css = await fetch(`${BASE_URL}/styles.css`);
    if (!js.ok || !css.ok) throw new Error(`app.js: ${js.status}, styles.css: ${css.status}`);
    return `app.js: ${js.status} (${js.headers.get("content-type")}), styles.css: ${css.status} (${css.headers.get("content-type")})`;
  });

  console.log("\nSummary:");
  const passed = results.filter((r) => r.passed).length;
  console.log(`${passed}/${results.length} checks passed`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("Smoke test runner crashed:", err);
  process.exitCode = 1;
});
