// Makes the relayer's test key straight into the Key Vault, as the secret `relayer-key`.
//
// His yes, 2026-11-18 ("Make relayer key"). The key is made in this process and handed to `az` on
// its standard input, which sends it over TLS to the Key Vault; it is then read back into this
// process to check that it gives the same address. It is never printed, never written to a file
// and never put in a command's arguments; only the address is printed. A name already in the vault
// is refused, so a second run cannot replace a key that was funded.
//
// Unlike `make-keys.mjs`, this asks `az` for no token: `az keyvault secret` signs in by itself as
// the signed-in person (Key Vault Secrets Officer on this vault).
//
// Run from build/vault/:  node deploy/make-relayer-key.mjs

import { spawnSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const VAULT = "vaultkeys277599";
const NAME = "relayer-key";

const az = (args, input) => spawnSync("az", ["keyvault", "secret", ...args, "--vault-name", VAULT, "--name", NAME], { encoding: "utf8", input });

// Only the secret's id is asked for here, never its value.
const before = az(["show", "--query", "id", "-o", "tsv"]);
if (before.status === 0) throw new Error(`make-relayer-key: ${NAME} is already in the vault; nothing was made`);
if (!/SecretNotFound/.test(before.stderr)) throw new Error("make-relayer-key: could not tell whether the name is free; nothing was made");

const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;
const put = az(["set", "--file", "/dev/stdin", "--encoding", "utf-8", "--content-type", "evm-private-key",
  "--tags", "address=" + address, "chain=arc-testnet", "made=" + new Date().toISOString(), "-o", "none"], key);
if (put.status !== 0) throw new Error("make-relayer-key: storing the key failed with status " + put.status);

// The value comes back on a pipe into this process only.
const back = az(["show", "--query", "value", "-o", "tsv"]);
const got = back.stdout.trim();
if (back.status !== 0 || !/^0x[0-9a-fA-F]{64}$/.test(got) || privateKeyToAccount(got).address !== address) {
  throw new Error("make-relayer-key: the key read back is not the one made");
}
console.log(JSON.stringify({ [NAME]: address }));
