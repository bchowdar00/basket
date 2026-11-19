// The rule's hash is the same for the same files, covers the three libraries and the settings
// file, and changes when one character of any of them changes.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ruleHashOf, SETTINGS } from "./rule-hash.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function copy() {
  const dir = mkdtempSync(tmpdir() + "/rule-hash-");
  cpSync(root + "/packages", dir + "/packages", { recursive: true, filter: (src) => !src.includes("node_modules") });
  cpSync(root + "/settings", dir + "/settings", { recursive: true });
  return dir;
}
const touch = (path) => writeFileSync(path, readFileSync(path, "utf8") + " ");

test("the rule's hash is 64 hex characters and the same twice", () => {
  const a = ruleHashOf(root), b = ruleHashOf(root);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.hash, b.hash);
});

test("the rule's hash covers every source file of the three libraries", () => {
  const paths = ruleHashOf(root).files.map((f) => f.path);
  for (const lib of ["score", "rule", "ledger"]) assert.ok(paths.includes("packages/" + lib + "/src/index.ts"), lib);
  assert.ok(paths.every((p) => /^packages\/(score|rule|ledger)\/src\/[^/]+\.ts$/.test(p)), paths.join(" "));
});

test("a copy of the build has the same hash, and one character more in any covered file changes it", () => {
  const dir = copy();
  const base = ruleHashOf(root).hash;
  assert.equal(ruleHashOf(dir).hash, base);
  for (const path of [SETTINGS, ...ruleHashOf(dir).files.map((f) => f.path)]) {
    const changed = copy();
    touch(changed + "/" + path);
    assert.notEqual(ruleHashOf(changed).hash, base, path);
  }
});

test("a test file is not part of the rule", () => {
  const dir = copy();
  touch(dir + "/packages/rule/test/rule.test.ts");
  assert.equal(ruleHashOf(dir).hash, ruleHashOf(root).hash);
});
