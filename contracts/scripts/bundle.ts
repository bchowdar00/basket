// Run on the build machine after `npm run build -w @app/contracts`:
//
//   node contracts/scripts/bundle.ts deploy/bundle.json
//
// Writes the one file the host needs to deploy: the compiled code and the SHA-256 of the source
// it was compiled from. Prints that hash, so it can be set beside the hash the audit read.
import { readFileSync, writeFileSync } from "node:fs";

import { makeBundle } from "./deploy.ts";

const out = process.argv[2];
if (!out) {
  console.error("say where to write the bundle: node contracts/scripts/bundle.ts <file>");
  process.exit(1);
}
const artifact = JSON.parse(readFileSync(new URL("../artifacts/contracts/BondedVault.sol/BondedVault.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../contracts/BondedVault.sol", import.meta.url), "utf8");
const bundle = makeBundle(artifact, source);
writeFileSync(out, JSON.stringify(bundle) + "\n");
console.log(`bundle written to ${out}; source SHA-256 ${bundle.sourceSha256}; creation code ${(bundle.bytecode.length - 2) / 2} bytes`);
