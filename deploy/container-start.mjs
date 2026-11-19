// The engine's start inside its container on Azure (plan 1.3, T18's host part). Run only by the
// team's decision. The container's platform starts it again if it stops.
//
// The forward run's folder is a share that outlives the container (VAULT_FORWARD_DIR). The image
// carries the folder as it stood on this Mac at the moment of the move (/app/seed); it is copied
// into the share once, when the share holds no ledger yet, and never over anything already there.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.VAULT_FORWARD_DIR;
if (!dir) throw new Error("container-start: VAULT_FORWARD_DIR is not set");
const seed = "/app/seed";
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, "ledger.jsonl")) && existsSync(join(seed, "ledger.jsonl"))) {
  cpSync(seed, dir, { recursive: true, force: false }); // never over a file already there (errorOnExist would refuse the folder itself)
  console.log(new Date().toISOString() + " seeded " + dir + " from the image's copy of the run");
}
const { main } = await import("../services/engine/src/main.ts");
const { nodeDeps } = await import("../services/engine/src/gemini.ts");
// The head on chain (T16): only when the vault's address is set. The operator's key is read from
// the Key Vault with the container's identity and stays in this process.
let sender;
if (process.env.VAULT_COMMIT_TO) {
  const { keyFromVault, viemSender } = await import("../services/engine/src/commit.ts");
  const need = (n) => { const v = process.env[n]; if (!v) throw new Error("container-start: missing " + n); return v; };
  const key = await keyFromVault({ clientId: need("VAULT_IDENTITY_CLIENT_ID"), keyVault: need("VAULT_KEYVAULT"), secret: "operator-key" });
  sender = viemSender({ key, rpc: need("VAULT_RPC"), chainId: Number(need("VAULT_CHAIN_ID")), vault: need("VAULT_COMMIT_TO") });
  console.log(new Date().toISOString() + " committing each new head to " + process.env.VAULT_COMMIT_TO);
}
console.log(new Date().toISOString() + " start");
await main({ dir, buildDir: "/app", deps: nodeDeps(), sender });
