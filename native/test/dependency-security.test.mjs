import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("uses the patched brace expansion with both old and new module APIs", () => {
  const braceExpansion = require("brace-expansion");
  assert.equal(typeof braceExpansion, "function");
  assert.equal(typeof braceExpansion.expand, "function");
  assert.deepEqual(braceExpansion("file-{a,b}.js"), [
    "file-a.js",
    "file-b.js",
  ]);
  assert.deepEqual(braceExpansion.expand("file-{a,b}.js"), [
    "file-a.js",
    "file-b.js",
  ]);
  assert.equal(braceExpansion("{1..100005}").length, 100_000);
  assert.equal(braceExpansion.EXPANSION_MAX, 100_000);
  assert.equal(braceExpansion.EXPANSION_MAX_LENGTH, 4_000_000);
});
