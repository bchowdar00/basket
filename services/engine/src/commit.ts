// The chain's head on Arc: after each pass the engine offers its head, and the operator's key sends
// `commit(head)` to the vault (plan 1.2, T16).
//
// One send at a time. A head offered while a send is out waits, and only the newest waiting head is
// sent next: each head already carries every row before it, so a head skipped over loses nothing.
// A send that fails is written down and not tried again on its own; the next pass's head is the
// retry. Every outcome is one line in `commits.jsonl` beside the ledger (the ledger itself holds
// only rows, so its chain stays checkable), so a gap between two heads on chain can be read off.
//
// The key: on Azure it is read from the Key Vault with the container's identity and held in this
// process only; it is never printed or written. With no settings for it the engine commits nothing.

import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Sender = { send(head: Hex): Promise<Hex> }; // resolves with the transaction's hash once it has landed and succeeded
export type CommitLine = { atMs: number; head: string; tx: string } | { atMs: number; head: string; error: string };

const HEAD = /^[0-9a-f]{64}$/;

/** The head as the contract's bytes32. Throws on anything but 64 lower-case hex digits. */
export function asBytes32(head: string): Hex {
  if (!HEAD.test(head)) throw new Error("commit: the head " + head + " is not 64 hex digits");
  return ("0x" + head) as Hex;
}

export function committer(sender: Sender, keep: (line: CommitLine) => void, nowMs: () => number) {
  let sent: string | null = null; // the last head that landed
  let waiting: string | null = null; // the newest head offered while a send was out
  let busy = false; // a send is out or about to be; set and cleared synchronously with `waiting`
  let out: Promise<void> = Promise.resolve();

  // Sends heads one after another until none is waiting. `busy` is cleared in the same synchronous
  // step that finds nothing waiting, so a head offered at any moment is either taken by this loop or
  // starts a new one; none is left waiting with no loop to take it (review of 2026-11-17).
  // A line that cannot be written must not stop the run: the loop goes on and the next pass's line is tried.
  const write = (line: CommitLine) => { try { keep(line); } catch (e) { console.error("commit: a line could not be written: " + String(e instanceof Error ? e.message : e)); } };
  const drain = async (first: string): Promise<void> => {
    let head: string | null = first;
    while (head !== null) {
      const now: string = head;
      try {
        const tx = await sender.send(asBytes32(now));
        sent = now;
        write({ atMs: nowMs(), head: now, tx });
      } catch (e) {
        write({ atMs: nowMs(), head: now, error: String(e instanceof Error ? e.message : e) });
      }
      const next: string | null = waiting;
      waiting = null;
      head = next !== null && next !== sent ? next : null;
      if (head === null) busy = false;
    }
  };

  return {
    /** Offers the chain's head after a pass. Returns at once; the send runs on its own. */
    offer(head: string): void {
      if (head === sent) return;
      if (busy) { waiting = head; return; }
      busy = true;
      out = drain(head);
    },
    /** Resolves once nothing is out (for a test, and before the loop returns). */
    async idle(): Promise<void> {
      while (busy) await out;
    },
  };
}

/** Sends `commit(head)` from the operator's key and waits for its receipt. */
export function viemSender(a: { key: Hex; rpc: string; chainId: number; vault: Address; timeoutMs?: number }): Sender {
  const chain = defineChain({ id: a.chainId, name: "chain " + a.chainId, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [a.rpc] } } });
  const account = privateKeyToAccount(a.key);
  const wallet = createWalletClient({ account, chain, transport: http(a.rpc) });
  const reader = createPublicClient({ chain, transport: http(a.rpc) });
  const abi = [{ type: "function", name: "commit", stateMutability: "nonpayable", inputs: [{ name: "hash", type: "bytes32" }], outputs: [] }] as const;
  return {
    async send(head) {
      const tx = await wallet.writeContract({ address: a.vault, abi, functionName: "commit", args: [head], account, chain });
      const receipt = await reader.waitForTransactionReceipt({ hash: tx, timeout: a.timeoutMs ?? 120_000 });
      if (receipt.status !== "success") throw new Error("commit: " + tx + " reverted");
      return tx;
    },
  };
}

/** The operator's key from the Key Vault, through the container's identity (the instance metadata service). */
export async function keyFromVault(a: { clientId: string; keyVault: string; secret: string; fetch?: typeof fetch }): Promise<Hex> {
  const f = a.fetch ?? fetch;
  const imds = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net&client_id=" + encodeURIComponent(a.clientId);
  const tok = (await (await f(imds, { headers: { Metadata: "true" } })).json()) as { access_token?: string };
  if (!tok.access_token) throw new Error("commit: the identity gave no Key Vault token");
  const r = await f(a.keyVault + "/secrets/" + a.secret + "?api-version=7.4", { headers: { authorization: "Bearer " + tok.access_token } });
  if (r.status !== 200) throw new Error("commit: reading " + a.secret + " gave status " + r.status);
  const key = ((await r.json()) as { value?: string }).value;
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("commit: " + a.secret + " is not a key");
  return key as Hex;
}
