import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pino from "pino";
import { listenOnce, listenWithPortFallback } from "../src/utils/findAvailablePort";

const silentLog = pino({ level: "silent" });

test("listenWithPortFallback binds the preferred port when it's free", async () => {
  const app = express();
  const { server, port } = await listenWithPortFallback(app, 18900, "127.0.0.1", silentLog);
  try {
    assert.equal(port, 18900);
  } finally {
    server.close();
  }
});

test("listenWithPortFallback tries the next port when the preferred one is taken", async () => {
  const blockerApp = express();
  const blocker = await listenOnce(blockerApp, 18901, "127.0.0.1");
  try {
    const app = express();
    const { server, port } = await listenWithPortFallback(app, 18901, "127.0.0.1", silentLog);
    try {
      assert.equal(port, 18902, "should fall back to the next port up when 18901 is taken");
    } finally {
      server.close();
    }
  } finally {
    blocker.close();
  }
});

test("listenWithPortFallback skips over multiple consecutively busy ports", async () => {
  const blockerApp1 = express();
  const blockerApp2 = express();
  const blocker1 = await listenOnce(blockerApp1, 18910, "127.0.0.1");
  const blocker2 = await listenOnce(blockerApp2, 18911, "127.0.0.1");
  try {
    const app = express();
    const { server, port } = await listenWithPortFallback(app, 18910, "127.0.0.1", silentLog);
    try {
      assert.equal(port, 18912);
    } finally {
      server.close();
    }
  } finally {
    blocker1.close();
    blocker2.close();
  }
});

test("listenWithPortFallback does not retry on non-address-in-use errors (e.g. an unassignable local address)", async () => {
  const app = express();
  // A syntactically valid IPv4 address that is (almost certainly) not
  // configured on any local interface - binds fail fast with
  // EADDRNOTAVAIL/EINVAL rather than the EADDRINUSE this function retries on.
  await assert.rejects(() => listenWithPortFallback(app, 18920, "10.255.255.1", silentLog, 3));
});

test("listenWithPortFallback gives up after maxAttempts and surfaces the last error", async () => {
  const blockerApp = express();
  const blocker = await listenOnce(blockerApp, 18930, "127.0.0.1");
  try {
    const app = express();
    await assert.rejects(() => listenWithPortFallback(app, 18930, "127.0.0.1", silentLog, 1));
  } finally {
    blocker.close();
  }
});
