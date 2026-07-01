import { test } from "node:test";
import assert from "node:assert/strict";
import { TextAccumulator } from "../src/utils/textAccumulator";

test("TextAccumulator concatenates incremental fragments and returns each one as its own delta", () => {
  const acc = new TextAccumulator();
  assert.equal(acc.update("b"), "b");
  assert.equal(acc.update("an"), "an");
  assert.equal(acc.update("ana"), "ana");
  assert.equal(acc.current, "banana");
});

test("TextAccumulator ignores empty fragments", () => {
  const acc = new TextAccumulator();
  acc.update("hi");
  assert.equal(acc.update(""), "");
  assert.equal(acc.current, "hi");
});

test("TextAccumulator handles a single-fragment reply", () => {
  const acc = new TextAccumulator();
  assert.equal(acc.update("Hello, world!"), "Hello, world!");
  assert.equal(acc.current, "Hello, world!");
});
