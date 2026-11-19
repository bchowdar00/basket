// Prints the rule's hash: the settings file and every source file of the three libraries the
// decision and its ledger run through. Run from anywhere; it reads the build it sits in.
//   node scripts/rule-hash.mjs          the hash alone
//   node scripts/rule-hash.mjs --files  the hash, then each file's own hash
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ruleHash } from "../packages/rule/src/hash.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
export const LIBRARIES = ["score", "rule", "ledger"];
export const SETTINGS = "settings/rule.json";

/** The rule's hash of the build at `dir`, and the files it covers. Throws when a library has no source. */
export function ruleHashOf(dir) {
  const files = [];
  for (const name of LIBRARIES) {
    const src = "packages/" + name + "/src";
    const names = readdirSync(dir + "/" + src).filter((f) => f.endsWith(".ts")).sort();
    if (names.length === 0) throw new Error("rule-hash: " + src + " holds no source file");
    for (const f of names) files.push({ path: src + "/" + f, sha256: createHash("sha256").update(readFileSync(dir + "/" + src + "/" + f)).digest("hex") });
  }
  return { hash: ruleHash(readFileSync(dir + "/" + SETTINGS, "utf8"), files), files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { hash, files } = ruleHashOf(root.replace(/\/$/, ""));
  console.log(hash);
  if (process.argv.includes("--files")) for (const f of files) console.log(f.sha256 + "  " + f.path);
}
