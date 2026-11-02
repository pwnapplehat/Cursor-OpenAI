import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, resolveSdkToolsOption, validateToolsPolicy } from "../src/config";

test("validateToolsPolicy accepts all / mcp-only / none", () => {
  assert.equal(validateToolsPolicy("all"), "all");
  assert.equal(validateToolsPolicy("mcp-only"), "mcp-only");
  assert.equal(validateToolsPolicy("none"), "none");
});

test("validateToolsPolicy rejects unknown values", () => {
  assert.throws(() => validateToolsPolicy("builtins-off"), ConfigError);
  assert.throws(() => validateToolsPolicy(""), ConfigError);
});

test("resolveSdkToolsOption maps policy onto SDK AgentOptions.tools", () => {
  assert.equal(resolveSdkToolsOption("all"), undefined);
  assert.deepEqual(resolveSdkToolsOption("mcp-only"), ["mcp"]);
  assert.deepEqual(resolveSdkToolsOption("none"), []);
});
