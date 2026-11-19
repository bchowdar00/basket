// Every value in this file is invented. None is a reading of any market.
// Tests for the key script. No real key is made here: the generator is replaced by three fixed,
// publicly known, worthless numbers, so nothing these tests leave in the temp folder is a secret.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import { DIR, NAMES, makeKeys, newKey } from "./make-keys.mjs";

const FAKE = [1, 2, 3].map((n) => "0x" + n.toString(16).padStart(64, "0"));
const fake = () => {
  let i = 0;
  return () => FAKE[i++];
};
const fresh = () => mkdtempSync(join(tmpdir(), "vault-keys-test-"));

test("three files, one for each name, each readable by its owner alone and holding one line", () => {
  const dir = join(fresh(), "vault");
  makeKeys({ dir, generate: fake(), log: () => {} });
  assert.deepEqual(readdirSync(dir).sort(), ["deploy.env", "operator.env", "relayer.env"]);
  assert.deepEqual(NAMES, ["deploy", "operator", "relayer"]);
  for (const [i, name] of NAMES.entries()) {
    const path = join(dir, name + ".env");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), "VAULT_KEY=" + FAKE[i] + "\n");
  }
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("it prints the three names with their addresses and nothing else, and never a key", () => {
  const dir = join(fresh(), "vault");
  const lines = [];
  const made = makeKeys({ dir, generate: fake(), log: (line) => lines.push(line) });
  const want = NAMES.map((name, i) => name + " " + privateKeyToAccount(FAKE[i]).address);
  assert.deepEqual(lines, want);
  assert.deepEqual(made, NAMES.map((name, i) => ({ name, address: privateKeyToAccount(FAKE[i]).address })));
  for (const line of lines) for (const key of FAKE) assert.ok(!line.toLowerCase().includes(key.slice(2)));
  assert.ok(!JSON.stringify(made).includes(FAKE[0].slice(2)));
});

test("if any key file is already there it stops, says which, and writes nothing", () => {
  const dir = fresh();
  writeFileSync(join(dir, "operator.env"), "VAULT_KEY=kept\n");
  assert.throws(() => makeKeys({ dir, generate: fake(), log: () => {} }), /operator\.env is already there/);
  assert.deepEqual(readdirSync(dir), ["operator.env"]);
  assert.equal(readFileSync(join(dir, "operator.env"), "utf8"), "VAULT_KEY=kept\n");
});

test("a generator that repeats itself is refused before anything is written", () => {
  const dir = join(fresh(), "vault");
  assert.throws(() => makeKeys({ dir, generate: () => FAKE[0], log: () => {} }), /two keys are the same/);
  assert.throws(() => readdirSync(dir), /ENOENT/);
});

test("the owner is set on every file and on the folder when one is given", () => {
  const dir = join(fresh(), "vault");
  const owned = [];
  makeKeys({ dir, generate: fake(), log: () => {}, chown: (path) => owned.push(path) });
  assert.deepEqual(owned.sort(), [dir, ...NAMES.map((name) => join(dir, name + ".env"))].sort());
});

test("the keys' folder on the host is /etc/vault: the test network's, and there is no other", () => {
  assert.equal(DIR, "/etc/vault");
});

test("a new key is 32 random bytes, different each time; none is written anywhere by this test", () => {
  const a = newKey();
  const b = newKey();
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
