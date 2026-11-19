// Makes the three keys the vault's host runs with: deploy, operator, relayer.
//
// A person runs this on the host, once:
//
//   sudo node scripts/make-keys.mjs          (writes /etc/vault/)
//
// Each key goes to its own file, owned by root and readable by root alone, as one line the
// service manager loads (EnvironmentFile=). The script prints the three addresses and nothing
// else. It never prints a key, and it never replaces a key file that is already there: a key
// that holds money cannot be lost by running this twice. These are keys for Arc's test network;
// there is no other folder and no other network here.
import { chownSync, existsSync, mkdirSync, openSync, writeSync, closeSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const NAMES = ["deploy", "operator", "relayer"];
export const DIR = "/etc/vault";

/** A new private key: 32 random bytes from the system's generator, as viem makes them. */
export function newKey() {
  return generatePrivateKey();
}

/**
 * Makes the three keys in `dir`. `generate` and `chown` are replaceable so the tests can run
 * without real keys and without being root. Returns and logs names and addresses only.
 */
export function makeKeys({ dir, generate = newKey, log = console.log, chown }) {
  for (const name of NAMES) {
    if (existsSync(join(dir, name + ".env"))) throw new Error(join(dir, name + ".env") + " is already there; nothing was written");
  }
  const keys = NAMES.map(() => generate());
  if (new Set(keys).size !== keys.length) throw new Error("two keys are the same; nothing was written");
  const made = NAMES.map((name, i) => ({ name, address: privateKeyToAccount(keys[i]).address }));

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (chown) chown(dir);
  for (const [i, name] of NAMES.entries()) {
    const path = join(dir, name + ".env");
    const file = openSync(path, "wx", 0o600); // fails if the file appeared since the check above
    try {
      writeSync(file, "VAULT_KEY=" + keys[i] + "\n");
    } finally {
      closeSync(file);
    }
    chmodSync(path, 0o600);
    if (chown) chown(path);
  }
  for (const m of made) log(m.name + " " + m.address);
  return made;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error("this takes no argument: it makes the test network's three keys in " + DIR);
    if (process.getuid?.() !== 0) throw new Error("run this with sudo: the key files must belong to root");
    makeKeys({ dir: DIR, chown: (path) => chownSync(path, 0, 0) });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
