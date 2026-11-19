// The chain over the engine's rows: each row's hash takes in the hash before it, so no row can
// be changed or dropped later without every hash after it changing. The first "previous hash"
// is the rule's hash. Kept apart from the ledger's rules so that a page can use those without
// this file.

import { createHash } from "node:crypto";

/** SHA-256, as hex, over the previous hash (64 hex characters, lower case) and then the row's text. */
export function chain(prevHex: string, rowJson: string): string {
  if (!/^[0-9a-f]{64}$/.test(prevHex)) throw new Error("chain: the previous hash is not 64 hex characters in lower case");
  if (typeof rowJson !== "string" || rowJson === "") throw new Error("chain: the row is not text");
  return createHash("sha256").update(prevHex + rowJson).digest("hex");
}
