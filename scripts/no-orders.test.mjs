// The build places no order and holds no exchange key. This fails if any source file here names the
// exchange's order request or the headers its signed requests carry.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);
const SKIP = new Set(["node_modules", "dist", "artifacts", "cache", "coverage", ".git"]);
const FORBIDDEN = [/prediction-markets\/order/i, /\/v1\/order/i, /x-gemini-apikey/i, /x-gemini-signature/i, /x-gemini-payload/i];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = dir + "/" + name;
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|tsx|mjs|js|json|sol|sh|md)$/.test(name) && path !== self) yield path;
  }
}

test("no file of the build names an order request or a signed-request header", () => {
  const found = [];
  for (const path of files(root.replace(/\/$/, ""))) {
    const text = readFileSync(path, "utf8");
    for (const re of FORBIDDEN) if (re.test(text)) found.push(path.slice(root.length) + " " + re);
  }
  assert.deepEqual(found, []);
});
