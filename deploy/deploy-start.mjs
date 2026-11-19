// The one-off deployment container: reads the deployer's key from the Key Vault with the
// container's identity and starts contracts/scripts/deploy.ts with it in that process's
// environment, the way the host's unit did with its environment file. The key is never printed
// or written. Run once with VAULT_TERMS set to the vault's terms, once with the stage vault's.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const need = (n) => { const v = process.env[n]; if (!v) throw new Error("deploy-start: missing " + n); return v; };
const client = need("VAULT_IDENTITY_CLIENT_ID");
const kv = need("VAULT_KEYVAULT");
const imds = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net&client_id=" + client;
const tok = await (await fetch(imds, { headers: { Metadata: "true" } })).json();
if (!tok.access_token) throw new Error("deploy-start: the identity gave no Key Vault token");
const r = await fetch(kv + "/secrets/deployer-key?api-version=7.4", { headers: { authorization: "Bearer " + tok.access_token } });
if (r.status !== 200) throw new Error("deploy-start: reading the deployer's key gave status " + r.status);
const key = (await r.json()).value;
mkdirSync(dirname(need("VAULT_ADDRESSES")), { recursive: true });
console.log(new Date().toISOString() + " deploying " + need("VAULT_TERMS"));
const run = spawnSync("node", ["contracts/scripts/deploy.ts"], { stdio: "inherit", env: { ...process.env, VAULT_KEY: key } });
process.exit(run.status ?? 1);
