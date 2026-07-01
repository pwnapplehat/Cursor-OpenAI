import { test } from "node:test";
import assert from "node:assert/strict";
import { safeCompare } from "../src/utils/safeCompare";

test("safeCompare returns true for identical strings", () => {
  assert.equal(safeCompare("secret-key-123", "secret-key-123"), true);
});

test("safeCompare returns false for different strings of the same length", () => {
  assert.equal(safeCompare("secret-key-123", "secret-key-124"), false);
});

test("safeCompare returns false for strings of different lengths", () => {
  assert.equal(safeCompare("short", "a-much-longer-string"), false);
  assert.equal(safeCompare("a-much-longer-string", "short"), false);
});

test("safeCompare handles empty strings", () => {
  assert.equal(safeCompare("", ""), true);
  assert.equal(safeCompare("", "x"), false);
});
