// The one-off stage-round container: reads the OPERATOR's key from the Key Vault with the
// container's identity and starts contracts/scripts/stage.ts with it in that process's environment,
// the way deploy-start.mjs did with the deployer's key. The key is never printed or written. Run
// with VAULT_STAGE_STEPS set to the round's steps.
import { spawnSync } from "node:child_process";

const need = (n) => { const v = process.env[n]; if (!v) throw new Error("stage-start: missing " + n); return v; };
const client = need("VAULT_IDENTITY_CLIENT_ID");
const kv = need("VAULT_KEYVAULT");
const imds = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net&client_id=" + client;
const tok = await (await fetch(imds, { headers: { Metadata: "true" } })).json();
if (!tok.access_token) throw new Error("stage-start: the identity gave no Key Vault token");
const r = await fetch(kv + "/secrets/operator-key?api-version=7.4", { headers: { authorization: "Bearer " + tok.access_token } });
if (r.status !== 200) throw new Error("stage-start: reading the operator's key gave status " + r.status);
const key = (await r.json()).value;
console.log(new Date().toISOString() + " running stage round on " + (process.env.VAULT_STAGE_NAME || "stage"));
const run = spawnSync("node", ["contracts/scripts/stage.ts"], { stdio: "inherit", env: { ...process.env, VAULT_KEY: key } });
process.exit(run.status ?? 1);
