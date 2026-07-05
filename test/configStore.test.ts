import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { ALL_EDITABLE_CONFIG_FIELDS, ConfigStore } from "../src/configStore";
import { HttpError } from "../src/errors";
import { makeTestConfig } from "./helpers/testConfig";

const silentLog = pino({ level: "silent" });

test("ConfigStore.setupComplete reflects whether a Cursor API key (or passthrough mode) is present", () => {
  const withKey = new ConfigStore(makeTestConfig({ cursorApiKey: "crsr_x" }), silentLog);
  assert.equal(withKey.setupComplete, true);

  const withoutKey = new ConfigStore(makeTestConfig({ cursorApiKey: undefined, cursorKeyMode: "server" }), silentLog);
  assert.equal(withoutKey.setupComplete, false);

  const passthrough = new ConfigStore(makeTestConfig({ cursorApiKey: undefined, cursorKeyMode: "passthrough" }), silentLog);
  assert.equal(passthrough.setupComplete, true);
});

test("ConfigStore.redactedSnapshot masks secrets and never exposes them in full", () => {
  const apiKey = "crsr_abcdefghijklmnop";
  const store = new ConfigStore(makeTestConfig({ cursorApiKey: apiKey, authKey: "gwk_1234567890" }), silentLog);
  const snapshot = store.redactedSnapshot();

  assert.notEqual(snapshot["cursorApiKey"], apiKey);
  const masked = snapshot["cursorApiKey"] as string;
  assert.equal(masked.length, apiKey.length);
  assert.equal(masked.slice(-4), apiKey.slice(-4));
  assert.ok(/^\*+/.test(masked), "everything but the last 4 characters should be masked");
  assert.equal(masked.slice(0, -4), "*".repeat(apiKey.length - 4));

  assert.notEqual(snapshot["authKey"], "gwk_1234567890");
  assert.equal(snapshot["hasCursorApiKey"], true);
  assert.equal(snapshot["hasAuthKey"], true);
  assert.equal(snapshot["isSetupComplete"], true);
});

test("ConfigStore.redactedSnapshot reports null/false for unset secrets", () => {
  const store = new ConfigStore(makeTestConfig({ cursorApiKey: undefined, authKey: undefined, cursorKeyMode: "passthrough" }), silentLog);
  const snapshot = store.redactedSnapshot();
  assert.equal(snapshot["cursorApiKey"], null);
  assert.equal(snapshot["authKey"], null);
  assert.equal(snapshot["hasCursorApiKey"], false);
  assert.equal(snapshot["hasAuthKey"], false);
});

test("ConfigStore persists user-editable overrides to settings.json and reloads them on the next instance", async () => {
  const initial = makeTestConfig({ defaultModel: "composer-2.5" });
  const store1 = new ConfigStore(initial, silentLog);
  await store1.update({ defaultModel: "claude-4.5-sonnet-thinking" });

  const settingsPath = path.join(path.dirname(initial.cursorWorkdirRoot), "settings.json");
  assert.ok(fs.existsSync(settingsPath));
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(onDisk.defaultModel, "claude-4.5-sonnet-thinking");

  // A second ConfigStore reading from the same data dir picks up the overlay.
  const freshBase = makeTestConfig({ cursorWorkdirRoot: initial.cursorWorkdirRoot, defaultModel: "composer-2.5" });
  const store2 = new ConfigStore(freshBase, silentLog);
  assert.equal(store2.config.defaultModel, "claude-4.5-sonnet-thinking");
});

test("ConfigStore.update validates string fields and rejects empty values", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await assert.rejects(() => store.update({ defaultModel: "" }), HttpError);
  await assert.rejects(() => store.update({ defaultModel: 123 as unknown as string }), HttpError);
});

test("ConfigStore.update validates boolean fields", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await assert.rejects(() => store.update({ sessionsEnabled: "yes" as unknown as boolean }), HttpError);
  await store.update({ sessionsEnabled: false });
  assert.equal(store.config.sessionsEnabled, false);
});

test("ConfigStore.update validates integer fields (non-negative integers only)", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await assert.rejects(() => store.update({ maxConcurrentRuns: -1 }), HttpError);
  await assert.rejects(() => store.update({ maxConcurrentRuns: 1.5 }), HttpError);
  await assert.rejects(() => store.update({ maxConcurrentRuns: "8" as unknown as number }), HttpError);
  await store.update({ maxConcurrentRuns: 12 });
  assert.equal(store.config.maxConcurrentRuns, 12);
});

test("ConfigStore.update enforces maxCachedAgents/maxConcurrentRuns >= 1 and port range", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await assert.rejects(() => store.update({ maxCachedAgents: 0 }), HttpError);
  await assert.rejects(() => store.update({ maxConcurrentRuns: 0 }), HttpError);
  await assert.rejects(() => store.update({ port: 0 }), HttpError);
  await assert.rejects(() => store.update({ port: 70000 }), HttpError);
});

test("ConfigStore.update enforces jsonBodyLimitMb bounds (1-1024)", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await assert.rejects(() => store.update({ jsonBodyLimitMb: 0 }), HttpError);
  await assert.rejects(() => store.update({ jsonBodyLimitMb: 2048 }), HttpError);
  await store.update({ jsonBodyLimitMb: 50 });
  assert.equal(store.config.jsonBodyLimitMb, 50);
});

test("ConfigStore.update validates enum-like fields (cursorKeyMode, cursorRuntime, cursorAgentMode, logLevel)", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await assert.rejects(() => store.update({ cursorKeyMode: "invalid" }), HttpError);
  await assert.rejects(() => store.update({ cursorRuntime: "invalid" }), HttpError);
  await assert.rejects(() => store.update({ cursorAgentMode: "invalid" }), HttpError);
  await assert.rejects(() => store.update({ logLevel: "invalid" }), HttpError);

  await store.update({ cursorKeyMode: "passthrough", cursorRuntime: "cloud", cursorAgentMode: "plan", logLevel: "debug" });
  assert.equal(store.config.cursorKeyMode, "passthrough");
  assert.equal(store.config.cursorRuntime, "cloud");
  assert.equal(store.config.cursorAgentMode, "plan");
  assert.equal(store.config.logLevel, "debug");
});

test("ConfigStore.update rejects unrecognized field names outright (regression test for a silent no-op bug)", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  // A real bug found via live CLI testing: sending the web UI's convenience
  // field name ("...Seconds") instead of the real millisecond field the API
  // actually accepts used to be silently accepted and silently do nothing.
  await assert.rejects(() => store.update({ rateLimitWindowSeconds: 45 }), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.match(err.message, /Unrecognized config field/);
    assert.match(err.message, /rateLimitWindowSeconds/);
    return true;
  });
  assert.equal(store.config.rateLimitWindowMs, 60_000, "the real field should be untouched, not silently left at some half-applied state");
});

test("ConfigStore.update rejects an entirely-invalid input atomically (no partial application)", async () => {
  const store = new ConfigStore(makeTestConfig({ defaultModel: "composer-2.5", maxConcurrentRuns: 8 }), silentLog);
  await assert.rejects(() => store.update({ defaultModel: "gpt-5", maxConcurrentRuns: -5 }), HttpError);
  // Neither field should have been applied, since maxConcurrentRuns failed validation.
  assert.equal(store.config.defaultModel, "composer-2.5");
  assert.equal(store.config.maxConcurrentRuns, 8);
});

test("ConfigStore.update calls the rebind callback when port or host changes, and reports restart: http-rebind", async () => {
  const store = new ConfigStore(makeTestConfig({ port: 8787, host: "127.0.0.1" }), silentLog);
  const calls: Array<[number, string]> = [];
  store.onServerRebindNeeded(async (port, host) => {
    calls.push([port, host]);
  });

  const result = await store.update({ port: 9999 });
  assert.equal(result.restart, "http-rebind");
  assert.deepEqual(calls, [[9999, "127.0.0.1"]]);
  assert.equal(store.config.port, 9999);
});

test("ConfigStore.update does not call the rebind callback when port/host are unchanged", async () => {
  const store = new ConfigStore(makeTestConfig({ port: 8787, defaultModel: "composer-2.5" }), silentLog);
  let called = false;
  store.onServerRebindNeeded(async () => {
    called = true;
  });
  const result = await store.update({ defaultModel: "auto" });
  assert.equal(result.restart, "none");
  assert.equal(called, false);
});

test("ConfigStore.update rolls back port/host when the rebind callback fails", async () => {
  const store = new ConfigStore(makeTestConfig({ port: 8787, host: "127.0.0.1" }), silentLog);
  store.onServerRebindNeeded(async () => {
    throw new Error("EADDRINUSE: address already in use");
  });

  await assert.rejects(() => store.update({ port: 80 }), HttpError);
  assert.equal(store.config.port, 8787, "port should be rolled back to its previous value after a failed rebind");
});

test("ConfigStore.generateAuthKey creates and persists a new key, and clearAuthKey removes it", () => {
  const store = new ConfigStore(makeTestConfig({ authKey: undefined }), silentLog);
  const key = store.generateAuthKey();
  assert.match(key, /^gwk_[0-9a-f]{48}$/);
  assert.equal(store.config.authKey, key);

  store.clearAuthKey();
  assert.equal(store.config.authKey, undefined);
});

test("ConfigStore.isEditableField accepts every field update() actually applies, and rejects only truly computed/non-editable ones", () => {
  for (const field of ALL_EDITABLE_CONFIG_FIELDS) {
    assert.equal(ConfigStore.isEditableField(field), true, `${field} should be editable`);
  }
  // Every real AppConfig field is editable now (including cursorWorkdirRoot, nodeEnv, and authKey) -
  // only fields computed/derived by redactedSnapshot(), which never exist on AppConfig itself, are not.
  for (const field of ["hasCursorApiKey", "hasAuthKey", "isSetupComplete", "totallyMadeUp"]) {
    assert.equal(ConfigStore.isEditableField(field), false, `${field} should not be editable`);
  }
});

test("ConfigStore.update accepts a custom authKey (min length enforced) and can clear it via null/empty", async () => {
  const store = new ConfigStore(makeTestConfig({ authKey: undefined }), silentLog);
  await assert.rejects(() => store.update({ authKey: "short" }), HttpError);
  await store.update({ authKey: "a-perfectly-fine-custom-admin-key" });
  assert.equal(store.config.authKey, "a-perfectly-fine-custom-admin-key");

  await store.update({ authKey: null });
  assert.equal(store.config.authKey, undefined);
});

test("ConfigStore.update resolves cursorWorkdirRoot to an absolute path and creates it, rejecting an unwritable one", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  const tmp = path.join(path.dirname(store.config.cursorWorkdirRoot), "moved-workdir");
  await store.update({ cursorWorkdirRoot: tmp });
  assert.equal(store.config.cursorWorkdirRoot, path.resolve(tmp));
  assert.ok(fs.existsSync(tmp));
});

test("ConfigStore.update accepts nodeEnv like any other editable string field", async () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  await store.update({ nodeEnv: "staging" });
  assert.equal(store.config.nodeEnv, "staging");
});

test("ConfigStore.requestRestart invokes the registered onRestartRequested callback", () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  let called = 0;
  store.onRestartRequested(() => {
    called += 1;
  });
  store.requestRestart();
  store.requestRestart();
  assert.equal(called, 2);
});

test("ConfigStore.requestRestart does not throw when no restart handler is registered", () => {
  const store = new ConfigStore(makeTestConfig(), silentLog);
  assert.doesNotThrow(() => store.requestRestart());
});

test("ConfigStore mutates the exact same config object it was constructed with (reference semantics consumers rely on)", async () => {
  const initial = makeTestConfig({ defaultModel: "composer-2.5" });
  const store = new ConfigStore(initial, silentLog);
  assert.equal(store.config, initial, "ConfigStore should not clone the initial config object");
  await store.update({ defaultModel: "auto" });
  assert.equal(initial.defaultModel, "auto", "mutating via the store must be visible through any other reference to the same object");
});
