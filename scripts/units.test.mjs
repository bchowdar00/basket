// Every value in this file is invented. None is a reading of any market.
// Tests for what goes on the host to deploy: the one-shot unit and the two terms files. Nothing
// here runs on the host or needs it. The unit is read as text and held against the program it
// starts and the files it names, so the three cannot drift apart unseen.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readTerms } from "../contracts/scripts/deploy.ts";
import { DIR, NAMES } from "./make-keys.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY = join(ROOT, "deploy");
const ON_HOST = "/opt/vault"; // where the build is copied to
const SOMEBODY = "0x" + "12".repeat(20); // stands in for the operator's address until the keys are made
const VAULTS = ["vault", "stage"];

/** A unit file as { Section: { Key: [values in order] } }, with `%i` filled in. */
function unit(name, instance = "") {
  const out = {};
  let section = "";
  for (const raw of readFileSync(join(DEPLOY, name), "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) {
      section = head[1];
      out[section] ??= {};
      continue;
    }
    const at = line.indexOf("=");
    assert.ok(at > 0 && section !== "", name + ": not a setting: " + line);
    (out[section][line.slice(0, at)] ??= []).push(line.slice(at + 1).replaceAll("%i", instance));
  }
  return out;
}
const one = (u, section, key) => {
  assert.equal(u[section]?.[key]?.length, 1, `${section}.${key} is set once`);
  return u[section][key][0];
};
const env = (u) => Object.fromEntries(u.Service.Environment.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
const here = (hostPath) => join(ROOT, hostPath.slice(ON_HOST.length + 1));

test("the deploy unit is one shot, runs as the unprivileged user, and loads the deploy key's file and no other", () => {
  const u = unit("vault-deploy@.service", "stage");
  assert.equal(one(u, "Service", "Type"), "oneshot");
  assert.equal(one(u, "Service", "User"), "vault");
  assert.equal(one(u, "Service", "WorkingDirectory"), ON_HOST);
  assert.ok(NAMES.includes("deploy"));
  assert.equal(one(u, "Service", "EnvironmentFile"), DIR + "/deploy.env");
  assert.equal(one(u, "Service", "NoNewPrivileges"), "yes");
  assert.equal(one(u, "Service", "ProtectSystem"), "strict");
  assert.equal(one(u, "Service", "StateDirectory"), "vault");
});

test("it starts the deployment script that is in the build, with every setting the script asks for and no key", () => {
  const u = unit("vault-deploy@.service", "stage");
  const start = one(u, "Service", "ExecStart").split(" ");
  assert.equal(start.length, 2);
  assert.ok(existsSync(join(ROOT, start[1])), start[1] + " is in the build");
  const script = readFileSync(join(ROOT, start[1]), "utf8");
  const asked = [...script.matchAll(/need\("([A-Z_]+)"\)/g)].map((m) => m[1]).sort();
  const e = env(u);
  assert.deepEqual(Object.keys(e).sort(), asked.filter((name) => name !== "VAULT_KEY"));
  assert.ok(asked.includes("VAULT_KEY"), "the key comes from the key file alone");
  assert.equal(e.VAULT_CHAIN_ID, "5042002");
  assert.match(e.VAULT_RPC, /^https:\/\/rpc\.testnet\./);
  assert.match(e.VAULT_USDC, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(e.VAULT_ADDRESSES, "/var/lib/vault/addresses.json");
  assert.equal(e.VAULT_BUNDLE, ON_HOST + "/deploy/bundle.json");
});

test("each vault has its own terms file, named by the unit's instance, whole but for the operator", () => {
  for (const name of VAULTS) {
    const e = env(unit("vault-deploy@.service", name));
    assert.equal(e.VAULT_TERMS, `${ON_HOST}/deploy/terms-${name}.json`);
    const json = JSON.parse(readFileSync(here(e.VAULT_TERMS), "utf8"));
    // Empty until the keys are made, then the operator's address (written in on 2026-11-17, when they were).
    assert.match(json.operator, /^(0x[0-9a-fA-F]{40})?$/, name + ": the operator is empty or an address");
    assert.throws(() => readTerms({ ...json, operator: "" }), /operator is not an address/); // so a deployment without it stops, and sends nothing
    const terms = readTerms({ ...json, operator: SOMEBODY });
    assert.equal(terms.name, name);
    assert.equal(terms.gainBps, 2000); // the operator keeps a fifth of a gain
    assert.ok(terms.drawBondHalves <= 4); // a draw of at most twice the bond
  }
});

test("the stage vault's deadline is a minute, and it has the main vault's limits", () => {
  const read = (name) => readTerms({ ...JSON.parse(readFileSync(join(DEPLOY, `terms-${name}.json`), "utf8")), operator: SOMEBODY });
  const [vault, stage] = VAULTS.map(read);
  assert.equal(stage.epochSeconds, 60);
  assert.ok(vault.epochSeconds > 24 * 60 * 60, "an epoch closed once a day has room to be closed late");
  assert.deepEqual([stage.drawBondHalves, stage.drawVaultBps, stage.gainBps, stage.capPerMarket], [vault.drawBondHalves, vault.drawVaultBps, vault.gainBps, vault.capPerMarket]);
});

test("nothing kept for the host holds anything shaped like a key", () => {
  for (const name of readdirSync(DEPLOY)) {
    if (name === "bundle.json") continue; // compiled code: long hex by nature, made from the audited source
    if (statSync(join(DEPLOY, name)).isDirectory()) continue; // an empty seed folder, nothing to read
    assert.doesNotMatch(readFileSync(join(DEPLOY, name), "utf8"), /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/, name);
  }
});
