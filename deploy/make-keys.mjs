// Makes the two test keys, the deployer's and the operator's, straight into the Key Vault.
//
// His yes, 2026-11-17 ("Yes, make them"). Each key is made in this process, sent over TLS to the
// Key Vault and read back to check that it gives the same address. It is never printed, never
// written to a file and never put in a command's arguments; only the two addresses are printed.
// A name already in the vault is refused, so a second run cannot replace a key that was funded.
//
// Run from build/vault/:  node deploy/make-keys.mjs
// It asks `az` for a Key Vault token as the signed-in person (Key Vault Secrets Officer on this vault).

import { spawnSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const VAULT = "https://vaultkeys277599.vault.azure.net";
const API = "api-version=7.4";
const NAMES = ["deployer-key", "operator-key"];

function token() {
  const r = spawnSync("az", ["account", "get-access-token", "--resource", "https://vault.azure.net", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("make-keys: az gave no Key Vault token");
  return r.stdout.trim();
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** One request to the vault; a 403 is retried for a few minutes, since a new role takes time to reach the vault. */
async function call(method, name, bearer, body) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${VAULT}/secrets/${name}?${API}`, {
      method, headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status !== 403 || i >= 12) return r;
    await sleep(15_000);
  }
}

const bearer = token();
for (const name of NAMES) {
  const before = await call("GET", name, bearer);
  if (before.status !== 404) throw new Error(`make-keys: ${name} is already in the vault (status ${before.status}); nothing was made`);
}
const out = {};
for (const name of NAMES) {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const put = await call("PUT", name, bearer, { value: key, contentType: "evm-private-key", tags: { address, chain: "arc-testnet", made: new Date().toISOString() } });
  if (put.status !== 200) throw new Error(`make-keys: storing ${name} gave status ${put.status}`);
  const back = await call("GET", name, bearer);
  const got = (await back.json()).value;
  if (privateKeyToAccount(got).address !== address) throw new Error(`make-keys: ${name} read back gives another address`);
  out[name] = address;
}
console.log(JSON.stringify(out));
