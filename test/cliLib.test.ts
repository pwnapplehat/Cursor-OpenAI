import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceConfigValue, parseKeyValuePairs, parseArgv, resolveBaseUrl, resolveAdminKey, parseSseChunk, stripBom } from "../bin/cli-lib.mjs";

test("coerceConfigValue converts boolean fields from common truthy/falsy strings", () => {
  assert.equal(coerceConfigValue("sessionsEnabled", "true"), true);
  assert.equal(coerceConfigValue("sessionsEnabled", "YES"), true);
  assert.equal(coerceConfigValue("sessionsEnabled", "1"), true);
  assert.equal(coerceConfigValue("sessionsEnabled", "false"), false);
  assert.equal(coerceConfigValue("sessionsEnabled", "0"), false);
  assert.equal(coerceConfigValue("sessionsEnabled", "off"), false);
});

test("coerceConfigValue throws a clear error for an unrecognized boolean value", () => {
  assert.throws(() => coerceConfigValue("sessionsEnabled", "maybe"), /expects a boolean/);
});

test("coerceConfigValue converts number fields", () => {
  assert.equal(coerceConfigValue("maxConcurrentRuns", "16"), 16);
  assert.equal(coerceConfigValue("port", "8080"), 8080);
});

test("coerceConfigValue throws a clear error for a non-numeric number field", () => {
  assert.throws(() => coerceConfigValue("port", "abc"), /expects a number/);
});

test("coerceConfigValue passes string fields through unchanged", () => {
  assert.equal(coerceConfigValue("defaultModel", "composer-2.5"), "composer-2.5");
  assert.equal(coerceConfigValue("host", "0.0.0.0"), "0.0.0.0");
});

test("coerceConfigValue passes unknown keys through as strings (lets the server reject them)", () => {
  assert.equal(coerceConfigValue("totallyMadeUpField", "whatever"), "whatever");
});

test("parseKeyValuePairs builds a typed patch object from key=value strings", () => {
  const result = parseKeyValuePairs(["defaultModel=composer-2.5", "maxConcurrentRuns=16", "sessionsEnabled=false"]);
  assert.deepEqual(result, { defaultModel: "composer-2.5", maxConcurrentRuns: 16, sessionsEnabled: false });
});

test("parseKeyValuePairs handles values that themselves contain an equals sign", () => {
  const result = parseKeyValuePairs(["corsOrigin=https://a.com,https://b.com?x=1"]);
  assert.deepEqual(result, { corsOrigin: "https://a.com,https://b.com?x=1" });
});

test("parseKeyValuePairs throws on a pair with no equals sign", () => {
  assert.throws(() => parseKeyValuePairs(["justAKey"]), /Expected "key=value"/);
});

test("parseKeyValuePairs throws on an empty key", () => {
  assert.throws(() => parseKeyValuePairs(["=value"]), /Empty key/);
});

test("parseArgv separates positionals from --flag value pairs", () => {
  const result = parseArgv(["config", "set", "port=8080", "--url", "http://localhost:9000"]);
  assert.deepEqual(result.positionals, ["config", "set", "port=8080"]);
  assert.deepEqual(result.flags, { url: "http://localhost:9000" });
});

test("parseArgv supports --flag=value syntax", () => {
  const result = parseArgv(["chat", "hello", "--model=composer-2.5"]);
  assert.deepEqual(result.positionals, ["chat", "hello"]);
  assert.deepEqual(result.flags, { model: "composer-2.5" });
});

test("parseArgv treats a flag with no following value (or followed by another flag) as boolean true", () => {
  const result = parseArgv(["activity", "--json"]);
  assert.deepEqual(result.flags, { json: true });

  const result2 = parseArgv(["chat", "hi", "--no-stream", "--model", "auto"]);
  assert.deepEqual(result2.flags, { "no-stream": true, model: "auto" });
});

test("parseArgv treats everything after a bare -- as positional", () => {
  const result = parseArgv(["chat", "--", "--this-looks-like-a-flag"]);
  assert.deepEqual(result.positionals, ["chat", "--this-looks-like-a-flag"]);
});

test("resolveBaseUrl prefers the --url flag, then GATEWAY_URL, then PORT-based default", () => {
  assert.equal(resolveBaseUrl({ flags: { url: "http://example.com/" }, env: {} }), "http://example.com");
  assert.equal(resolveBaseUrl({ flags: {}, env: { GATEWAY_URL: "http://gw:1234/" } }), "http://gw:1234");
  assert.equal(resolveBaseUrl({ flags: {}, env: { PORT: "9999" } }), "http://127.0.0.1:9999");
  assert.equal(resolveBaseUrl({ flags: {}, env: {} }), "http://127.0.0.1:8787");
});

test("resolveAdminKey prefers the --key flag, then GATEWAY_ADMIN_KEY, then the local settings file", () => {
  assert.equal(resolveAdminKey({ flags: { key: "from-flag" }, env: { GATEWAY_ADMIN_KEY: "from-env" }, settingsAuthKey: "from-file" }), "from-flag");
  assert.equal(resolveAdminKey({ flags: {}, env: { GATEWAY_ADMIN_KEY: "from-env" }, settingsAuthKey: "from-file" }), "from-env");
  assert.equal(resolveAdminKey({ flags: {}, env: {}, settingsAuthKey: "from-file" }), "from-file");
  assert.equal(resolveAdminKey({ flags: {}, env: {}, settingsAuthKey: undefined }), undefined);
});

test("parseSseChunk parses complete data: frames and returns a partial-line remainder", () => {
  const chunk = 'data: {"type":"text","delta":"hi"}\n\ndata: {"type":"text","delta":"the';
  const { frames, remainder } = parseSseChunk(chunk);
  assert.deepEqual(frames, [{ done: false, data: { type: "text", delta: "hi" } }]);
  assert.equal(remainder, 'data: {"type":"text","delta":"the');
});

test("parseSseChunk recognizes the [DONE] sentinel", () => {
  const { frames } = parseSseChunk("data: [DONE]\n\n");
  assert.deepEqual(frames, [{ done: true }]);
});

test("stripBom removes a leading UTF-8 BOM so JSON.parse doesn't reject the file", () => {
  const withBom = "\uFEFF" + JSON.stringify({ a: 1 });
  assert.equal(stripBom(withBom), JSON.stringify({ a: 1 }));
  assert.doesNotThrow(() => JSON.parse(stripBom(withBom)));
});

test("stripBom leaves text without a BOM unchanged", () => {
  const text = JSON.stringify({ a: 1 });
  assert.equal(stripBom(text), text);
});

test("parseSseChunk skips malformed JSON frames without throwing", () => {
  const { frames } = parseSseChunk("data: {not json}\n\ndata: {\"type\":\"done\"}\n\n");
  assert.deepEqual(frames, [{ done: false, data: { type: "done" } }]);
});
