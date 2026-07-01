import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Express } from "express";
import pino from "pino";
import { ConfigStore } from "../src/configStore";
import { buildApp } from "../src/server";
import { makeTestConfig } from "./helpers/testConfig";

function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(port, host);
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", (err) => reject(err));
  });
}

/**
 * Regression test for a real deadlock caught by live testing: the naive
 * first implementation of the rebind handler did
 * `await new Promise((resolve) => oldServer.close(() => resolve()))` before
 * returning. But `server.close()`'s callback only fires once every open
 * connection has ended - and the very request that triggered the rebind (a
 * PATCH /api/admin/config call) is itself still being served by
 * `oldServer`, and can't finish sending its response until this async chain
 * (`onServerRebindNeeded` -> `configStore.update()` -> the route handler)
 * returns. Awaiting the drain there deadlocks forever. The fix: kick off
 * `oldServer.close()` without awaiting it, since the current request finishes
 * naturally right after this callback returns.
 */
test("a PATCH /api/admin/config request that changes the port resolves instead of deadlocking", async (t) => {
  const initialPort = 18811;
  const targetPort = 18822;
  const config = makeTestConfig({ port: initialPort, host: "127.0.0.1", authKey: "test-admin-key" });
  const log = pino({ level: "silent" });
  const configStore = new ConfigStore(config, log);
  const { app, sessionManager } = buildApp(configStore, log);
  t.after(() => sessionManager.shutdown());

  let server = await listen(app, initialPort, "127.0.0.1");
  t.after(() => server.close());

  configStore.onServerRebindNeeded(async (newPort, newHost) => {
    const newServer = await listen(app, newPort, newHost);
    const oldServer = server;
    server = newServer;
    // Deliberately not awaited - see the module-level comment above.
    oldServer.close(() => {});
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${initialPort}/api/admin/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-key" },
      body: JSON.stringify({ port: targetPort }),
      signal: controller.signal,
    });
    assert.equal(res.status, 200, "the rebind request must resolve with a real response, not hang");
    const body = (await res.json()) as { port: number; restartRequired: boolean };
    assert.equal(body.port, targetPort);
    assert.equal(body.restartRequired, true);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      assert.fail("request timed out - the rebind handler deadlocked");
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  // The new port should now be serving traffic.
  const healthRes = await fetch(`http://127.0.0.1:${targetPort}/health`);
  assert.equal(healthRes.status, 200);
});
