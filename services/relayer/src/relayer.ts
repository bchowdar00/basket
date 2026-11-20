// The relayer, put together: the five things it does, over one store and one chain. Every send it
// signs itself (routes 2, 3, 4) goes through one lane, so its key never has two transactions
// racing for a nonce. Passing a phone's own signed call on (route 6) uses no key.
import type { Address, Hex } from "viem";

import { check } from "./checks.ts";
import { Reverted, SendUnknown } from "./chain.ts";
import type { ChainAccount, RelayerChain } from "./chain.ts";
import { Refused } from "./refused.ts";
import type { Store } from "./store.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEVICE = /^[A-Za-z0-9_-]{16,64}$/;
const ONE_DOLLAR = 1_000_000n; // USDC's smallest units in one whole dollar
const HANDOUTS_AN_HOUR = 40; // from one network address: under the whole dispenser, so one address cannot take it all in an hour (audit of the candidate, 2026-11-18); a room behind one address is slowed, not shut out
const DEFAULTS_A_MINUTE = 30; // from one network address
const TXS_AN_HOUR = 30; // from one signer
const FEES_MOST = 2; // top-ups an address
const ACCOUNT_FOR_MS = 1_000; // an address's chain reading is held this long

export type Relayer = ReturnType<typeof relayer>;

/** A serial lane: each piece of work starts when the one before it has ended, well or not. */
function lane(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = last.then(work);
    last = next.catch(() => {});
    return next;
  };
}

export function relayer(a: {
  store: Store;
  chain: RelayerChain;
  now: () => number;
  nowMs?: () => number;
  vaults: { name: string; vault: Address }[];
  usdc: Address;
  forDeposit: bigint;
  forFees: bigint;
  most: number;
  log?: (line: Record<string, unknown>) => void;
}) {
  const nowMs = a.nowMs ?? (() => Date.now());
  const one = lane();
  const byName = new Map(a.vaults.map((v) => [v.name, v.vault]));
  const set = new Set(a.vaults.map((v) => v.vault.toLowerCase()));
  const accounts = new Map<string, { at: number; value: Promise<ChainAccount> }>();

  const need = (v: unknown): string => (typeof v === "string" ? v : "");
  const handout = a.forDeposit + a.forFees;

  const NAME_ONLY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
  const DEFAULT_ERRORS = new Set(["NoEpoch", "NotYet", "Defaulted"]); // the words declareDefault() can be turned back with; any other word is not the contract's
  // a decoded contract error name, never a message, hash or URL
  const log = a.log ?? (() => {});
  const detail = (e: unknown): string => (e instanceof Error ? e.message : e === undefined ? "" : String(e));
  /** A refusal whose body carries only the code, plus a named contract error where there is one; the rest goes to the log. */
  function refusal(status: number, code: string, e?: unknown): Refused {
    const msg = detail(e);
    if (msg) log({ what: "refused", code, why: msg }); // the internal detail reaches the server's log only
    return new Refused(status, code, NAME_ONLY.test(msg) ? { why: msg } : {});
  }

  function accountOf(who: Address): Promise<ChainAccount> {
    const key = who.toLowerCase();
    const held = accounts.get(key);
    if (held && nowMs() - held.at < ACCOUNT_FOR_MS) return held.value;
    const value = a.chain.account(who);
    accounts.set(key, { at: nowMs(), value });
    value.catch(() => { if (accounts.get(key)?.value === value) accounts.delete(key); });
    if (accounts.size > 5_000) for (const [k, v] of accounts) if (nowMs() - v.at >= ACCOUNT_FOR_MS) accounts.delete(k);
    return value;
  }

  return {
    /** Route 1. The public figures: no key, no relayer balance. */
    info: async () => ({
      chainId: a.chain.chainId,
      usdc: a.usdc,
      relayer: a.chain.relayer,
      forDeposit: a.forDeposit.toString(),
      forFees: a.forFees.toString(),
      vaults: a.vaults.map((v) => ({ name: v.name, vault: v.vault })),
    }),

    /** Route 2. Hands a phone its test dollars, once. */
    async handout(body: unknown, ip: string): Promise<{ tx: Hex; forDeposit: string; forFees: string }> {
      const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      const address = need(b.address).toLowerCase() as Address;
      const device = need(b.device);
      if (!ADDRESS.test(address) || !DEVICE.test(device)) throw new Refused(400, "bad-request");
      if (a.store.handed(address) || a.store.handedDevice(device)) throw new Refused(409, "already-handed");
      if (a.store.hitCount("handout", ip, a.now() - 3600) >= HANDOUTS_AN_HOUR) throw new Refused(429, "too-many");
      const got = a.store.grant(address, device, ip, a.now(), a.most); // written before the send, so two at once cannot both be paid
      if (got === "address" || got === "device") throw new Refused(409, "already-handed");
      if (got === "none-left") throw new Refused(409, "none-left");
      a.store.noteHit("handout", ip, a.now()); // counted before the first await, so a burst cannot pass the per-address limit
      if ((await a.chain.balanceOf(a.chain.relayer)) < handout + ONE_DOLLAR) {
        a.store.ungrant(address);
        throw new Refused(503, "empty");
      }
      let sent: { hash: Hex; wait: () => Promise<void> };
      try {
        sent = await one(() => a.chain.transfer(address, handout)); // the send, serialized so the key's nonce never races
      } catch (e) {
        if (e instanceof SendUnknown) throw refusal(503, "send-unknown", e); // the node never answered the send: it may be out, so the record is KEPT
        a.store.ungrant(address); // (a) the send failed, nothing was broadcast: take the record out, a retry may be paid
        throw refusal(503, "send-failed", e);
      }
      try {
        await sent.wait(); // the receipt, apart from the send
      } catch (e) {
        if (e instanceof Reverted) {
          a.store.ungrant(address); // (b) broadcast but mined as a revert: take the record out
          throw refusal(503, "send-failed", e);
        }
        throw refusal(503, "send-unknown", e); // (c) broadcast, outcome unknown: KEEP the record so a retry is refused as already handed
      }
      return { tx: sent.hash, forDeposit: a.forDeposit.toString(), forFees: a.forFees.toString() };
    },

    /** Route 3. Tops up a phone's fee money, at most twice. */
    async topUp(body: unknown): Promise<{ tx: Hex; forFees: string }> {
      const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      const address = need(b.address).toLowerCase() as Address;
      if (!ADDRESS.test(address)) throw new Refused(400, "bad-request");
      if (!a.store.handed(address)) throw new Refused(403, "not-handed");
      // Reserve the top-up (and check it is under the count) synchronously, before the first await,
      // exactly as grant/ungrant do for handouts, so a burst cannot all slip past the count and over-pay.
      const slot = a.store.grantFee(address, a.now(), FEES_MOST);
      if (slot === "too-many") throw new Refused(429, "too-many");
      try {
        if ((await a.chain.balanceOf(address)) >= a.forFees) {
          a.store.ungrantFee(slot); // not low: nothing is sent, so release the reservation
          throw new Refused(409, "not-low");
        }
      } catch (e) {
        if (e instanceof Refused) throw e;
        a.store.ungrantFee(slot); // the balance read failed: release the reservation
        throw e;
      }
      let sent: { hash: Hex; wait: () => Promise<void> };
      try {
        sent = await one(() => a.chain.transfer(address, a.forFees)); // the send, serialized on the key's lane
      } catch (e) {
        if (e instanceof SendUnknown) throw refusal(503, "send-unknown", e); // the node never answered the send: the reservation is KEPT
        a.store.ungrantFee(slot); // (a) the send failed, nothing broadcast
        throw refusal(503, "send-failed", e);
      }
      try {
        await sent.wait(); // the receipt, apart from the send
      } catch (e) {
        if (e instanceof Reverted) {
          a.store.ungrantFee(slot); // (b) broadcast but mined as a revert
          throw refusal(503, "send-failed", e);
        }
        throw refusal(503, "send-unknown", e); // (c) broadcast, outcome unknown: KEEP the reservation so a retry is refused
      }
      return { tx: sent.hash, forFees: a.forFees.toString() };
    },

    /** Route 4. Sends declareDefault() on a vault when a phone asks, paying the fee itself. */
    async declareDefault(name: string, ip: string): Promise<{ tx: Hex }> {
      const vault = byName.get(name);
      if (!vault) throw new Refused(404, "not-found");
      if (a.store.hitCount("default", ip, a.now() - 60) >= DEFAULTS_A_MINUTE) throw new Refused(429, "too-many");
      a.store.noteHit("default", ip, a.now()); // counted when tried
      try {
        const tx = await one(() => a.chain.tryDefault(vault));
        return { tx };
      } catch (e) {
        // A named contract revert is a refusal (409) with that name; anything else is the chain being unavailable (503).
        throw DEFAULT_ERRORS.has(detail(e)) ? refusal(409, "refused", e) : refusal(503, "chain-unavailable", e);
      }
    },

    /** Route 5. Tells a phone what it needs to sign a call. Held one second an address. */
    async account(address: string): Promise<{ nonce: string; maxFeePerGas: string; maxPriorityFeePerGas: string; balance: string }> {
      if (!ADDRESS.test(address)) throw new Refused(400, "bad-request");
      // Only a phone this relayer handed dollars to: anyone else would make it ask the chain for nothing (audit of the candidate).
      if (!a.store.handed(address.toLowerCase() as Address)) throw new Refused(403, "not-handed");
      const r = await accountOf(address as Address);
      return { nonce: r.nonce.toString(), maxFeePerGas: r.maxFeePerGas.toString(), maxPriorityFeePerGas: r.maxPriorityFeePerGas.toString(), balance: r.balance.toString() };
    },

    /** Route 6. Passes on a transaction the phone signed, only if it is one of the four calls. */
    async relay(body: unknown): Promise<{ tx: Hex }> {
      const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      const checked = await check(b.raw, { chainId: a.chain.chainId, usdc: a.usdc, vaults: set, handed: (who) => a.store.handed(who) });
      const signer = checked.signer.toLowerCase();
      if (a.store.hitCount("tx", signer, a.now() - 3600) >= TXS_AN_HOUR) throw new Refused(429, "too-many");
      a.store.noteHit("tx", signer, a.now()); // counted when tried
      try {
        await a.chain.dryRun({ from: checked.signer, to: checked.to, data: checked.data, value: 0n });
      } catch (e) {
        throw refusal(409, "refused", e);
      }
      try {
        return { tx: await a.chain.sendRaw(b.raw as Hex) };
      } catch (e) {
        throw refusal(503, "send-failed", e); // the node turned the phone's own transaction back: a refusal the page has words for, not an internal error
      }
    },
  };
}
