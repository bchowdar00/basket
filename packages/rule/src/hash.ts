// The rule's hash: one figure for the settings file and every source file the decision runs
// through. It is fixed before the first forward read and is the plan hash of every epoch.
// Kept apart from the decision so that a page can use the decision without this file.

import { createHash } from "node:crypto";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** SHA-256 over the settings text's own hash and each file's path and hash, the files in path order. */
export function ruleHash(settingsJson: string, files: { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(["rule 1", "settings " + sha256(settingsJson), ...sorted.map((f) => f.sha256 + " " + f.path)].join("\n") + "\n");
}
