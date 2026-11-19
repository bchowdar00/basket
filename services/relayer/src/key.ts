// The relayer's key comes either from a raw setting (local tests only) or from Azure Key Vault
// through the host's managed identity. The text below is copied, not imported, from the engine's
// `keyFromVault` (services/engine/src/commit.ts): the relayer must not depend on the engine.
// The key is held in the process only; it is never printed, logged or written.
import type { Hex } from "viem";

export async function keyFromVault(a: { clientId: string; keyVault: string; secret: string; fetch?: typeof fetch }): Promise<Hex> {
  const f = a.fetch ?? fetch;
  const imds = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net&client_id=" + encodeURIComponent(a.clientId);
  const tok = (await (await f(imds, { headers: { Metadata: "true" } })).json()) as { access_token?: string };
  if (!tok.access_token) throw new Error("the identity gave no Key Vault token");
  const r = await f(a.keyVault + "/secrets/" + a.secret + "?api-version=7.4", { headers: { authorization: "Bearer " + tok.access_token } });
  if (r.status !== 200) throw new Error("reading " + a.secret + " gave status " + r.status);
  const key = ((await r.json()) as { value?: string }).value;
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(a.secret + " is not a key");
  return key as Hex;
}
