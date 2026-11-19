// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Address, Hex } from "viem";

import { relayer } from "../src/relayer.ts";
import { Reverted, SendUnknown } from "../src/chain.ts";
import { Refused } from "../src/refused.ts";
import { openStore } from "../src/store.ts";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const RELAYER = "0x00000000000000000000000000000000000000e0" as Address;
const VAULT = "0x00000000000000000000000000000000000000a1" as Address;
const DEPOSIT = 100_000_000n, FEES = 1_000_000n;
const addr = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Address;
const device = (n: number) => ("device-" + n.toString().padStart(12, "0")).slice(0, 40);
const TX = ("0x" + "ff".repeat(32)) as Hex;

/** A stand-in chain that counts what it is asked. */
function fakeChain(over: { relayerBalance?: bigint; defaultThrows?: string; transferThrows?: boolean | string; transferUnknown?: boolean; waitThrows?: boolean | string; waitReverts?: boolean } = {}) {
  const balances = new Map<string, bigint>([[RELAYER.toLowerCase(), over.relayerBalance ?? 10n ** 18n]]);
  const transfers: { to: string; amount: bigint }[] = [];
  const defaults: string[] = [];
  let accountCalls = 0;
  const chain = {
    chainId: 5042002, usdc: USDC, relayer: RELAYER,
    balanceOf: async (who: Address) => balances.get(who.toLowerCase()) ?? 0n,
    account: async (who: Address) => {
      accountCalls++;
      return { nonce: 3n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, balance: balances.get(who.toLowerCase()) ?? 0n };
    },
    transfer: async (to: Address, amount: bigint) => {
      if (over.transferUnknown) throw new SendUnknown("the request timed out http://rpc.invalid/secret"); // the node never answered the send
      if (over.transferThrows) throw new Error(typeof over.transferThrows === "string" ? over.transferThrows : "the chain turned it back"); // (a) send failed
      transfers.push({ to: to.toLowerCase(), amount }); // broadcast
      balances.set(to.toLowerCase(), (balances.get(to.toLowerCase()) ?? 0n) + amount);
      return {
        hash: TX,
        wait: async () => {
          if (over.waitThrows) throw new Error(typeof over.waitThrows === "string" ? over.waitThrows : "receipt wait failed"); // (c) outcome unknown
          if (over.waitReverts) throw new Reverted("transfer", TX); // (b) mined as a revert
        },
      };
    },
    tryDefault: async (vault: Address) => { if (over.defaultThrows) throw new Error(over.defaultThrows); defaults.push(vault.toLowerCase()); return TX; },
    dryRun: async () => {},
    sendRaw: async () => TX,
  };
  return { chain, transfers, defaults, balances, accountCalls: () => accountCalls, setBalance: (a: Address, v: bigint) => balances.set(a.toLowerCase(), v), failWait: (v: boolean | string) => { over.waitThrows = v; } };
}

function make(over: Parameters<typeof fakeChain>[0] = {}, cfg: { most?: number; store?: ReturnType<typeof openStore>; clock?: { s: number; ms: number } } = {}) {
  const f = fakeChain(over);
  const clock = cfg.clock ?? { s: 1_000, ms: 1_000_000 };
  const store = cfg.store ?? openStore(":memory:");
  const app = relayer({
    store, chain: f.chain as never, now: () => clock.s, nowMs: () => clock.ms,
    vaults: [{ name: "stage", vault: VAULT }], usdc: USDC, forDeposit: DEPOSIT, forFees: FEES, most: cfg.most ?? 3,
  });
  return { app, store, clock, ...f };
}

test("GET / tells the public figures and no key or relayer balance", async () => {
  const { app } = make();
  const info = await app.info();
  assert.deepEqual(info, { chainId: 5042002, usdc: USDC, relayer: RELAYER, forDeposit: "100000000", forFees: "1000000", vaults: [{ name: "stage", vault: VAULT }] });
  assert.ok(!JSON.stringify(info).includes("balance"));
});

test("a handout sends one transfer of the two parts", async () => {
  const { app, transfers } = make();
  const r = await app.handout({ address: addr(1), device: device(1) }, "203.0.113.7");
  assert.deepEqual(r, { tx: TX, forDeposit: "100000000", forFees: "1000000" });
  assert.deepEqual(transfers, [{ to: addr(1).toLowerCase(), amount: DEPOSIT + FEES }]);
});

test("a second ask by the same address, and the same device with another address, are refused", async () => {
  const { app, transfers } = make();
  await app.handout({ address: addr(1), device: device(1) }, "203.0.113.7");
  await assert.rejects(app.handout({ address: addr(1), device: device(2) }, "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "already-handed");
  await assert.rejects(app.handout({ address: addr(2), device: device(1) }, "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "already-handed");
  assert.equal(transfers.length, 1);
});

test("forty asks at once for one address pay exactly once", async () => {
  const { app, transfers } = make();
  const asks = Array.from({ length: 40 }, () => app.handout({ address: addr(5), device: device(5) }, "203.0.113.7").then(() => "ok", () => "no"));
  const got = await Promise.all(asks);
  assert.equal(got.filter((x) => x === "ok").length, 1);
  assert.equal(transfers.length, 1);
});

test("a failed send takes the record out, and the next ask is paid", async () => {
  const bad = make({ transferThrows: true });
  await assert.rejects(bad.app.handout({ address: addr(9), device: device(9) }, "203.0.113.7"));
  assert.equal(bad.transfers.length, 0);
  // the same address may be handed again once a send works: re-point the chain at a working transfer
  assert.equal(bad.store.handed(addr(9)), false);
});

test("the count stops at the most", async () => {
  const { app } = make({}, { most: 2 });
  await app.handout({ address: addr(10), device: device(10) }, "203.0.113.7");
  await app.handout({ address: addr(11), device: device(11) }, "203.0.113.7");
  await assert.rejects(app.handout({ address: addr(12), device: device(12) }, "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "none-left");
});

test("a relayer balance under one handout plus one dollar refuses as empty", async () => {
  const { app } = make({ relayerBalance: DEPOSIT + FEES }); // short of the extra dollar
  await assert.rejects(app.handout({ address: addr(13), device: device(13) }, "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "empty");
});

test("more than twelve handouts an hour from one address are refused", async () => {
  const { app } = make({}, { most: 1000 });
  for (let i = 0; i < 12; i++) await app.handout({ address: addr(1000 + i), device: device(1000 + i) }, "198.51.100.9");
  await assert.rejects(app.handout({ address: addr(2000), device: device(2000) }, "198.51.100.9"), (e: unknown) => e instanceof Refused && e.code === "too-many");
});

test("a top-up pays only a handed address under the fee part, and the third is refused", async () => {
  const m = make();
  await assert.rejects(m.app.topUp({ address: addr(20) }), (e: unknown) => e instanceof Refused && e.code === "not-handed");
  await m.app.handout({ address: addr(20), device: device(20) }, "203.0.113.7");
  m.setBalance(addr(20), FEES); // exactly the fee part: not low
  await assert.rejects(m.app.topUp({ address: addr(20) }), (e: unknown) => e instanceof Refused && e.code === "not-low");
  m.setBalance(addr(20), 0n);
  assert.deepEqual(await m.app.topUp({ address: addr(20) }), { tx: TX, forFees: "1000000" });
  m.setBalance(addr(20), 0n);
  await m.app.topUp({ address: addr(20) });
  m.setBalance(addr(20), 0n);
  await assert.rejects(m.app.topUp({ address: addr(20) }), (e: unknown) => e instanceof Refused && e.code === "too-many");
});

test("a default is refused with the contract's word when the dry run turns it back", async () => {
  const { app } = make({ defaultThrows: "NotYet" });
  await assert.rejects(app.declareDefault("stage", "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "refused" && e.extra.why === "NotYet");
});

test("a default is sent when the dry run passes, and an unknown name is not found", async () => {
  const { app, defaults } = make();
  assert.deepEqual(await app.declareDefault("stage", "203.0.113.7"), { tx: TX });
  assert.deepEqual(defaults, [VAULT.toLowerCase()]);
  await assert.rejects(app.declareDefault("ghost", "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "not-found");
});

test("more than thirty default asks a minute from one address are refused", async () => {
  const { app } = make();
  for (let i = 0; i < 30; i++) await app.declareDefault("stage", "198.51.100.9");
  await assert.rejects(app.declareDefault("stage", "198.51.100.9"), (e: unknown) => e instanceof Refused && e.code === "too-many");
});

test("accounts asks the chain once a second however many ask", async () => {
  const { app, accountCalls, clock, setBalance } = make();
  await assert.rejects(app.account(addr(30)), (e: unknown) => e instanceof Refused && e.status === 403 && e.code === "not-handed"); // a stranger's address asks the chain nothing
  assert.equal(accountCalls(), 0);
  await app.handout({ address: addr(30), device: device(30) }, "203.0.113.7");
  setBalance(addr(30), 0n);
  for (let i = 0; i < 5; i++) await app.account(addr(30));
  assert.equal(accountCalls(), 1);
  clock.ms += 1_000;
  const a = await app.account(addr(30));
  assert.equal(accountCalls(), 2);
  assert.deepEqual(a, { nonce: "3", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000000", balance: "0" });
});

test("fix 3: 150 concurrent handouts from one network address pay at most the hourly limit", async () => {
  const { app, transfers } = make({}, { most: 1000 });
  const asks = Array.from({ length: 150 }, (_, i) =>
    app.handout({ address: addr(3000 + i), device: device(3000 + i) }, "198.51.100.9").then(() => "ok", () => "no"));
  const got = await Promise.all(asks);
  assert.equal(got.filter((x) => x === "ok").length, 12);
  assert.equal(transfers.length, 12);
});

test("fix 1: 20 concurrent top-ups for one phone pay at most twice, and a later third is refused", async () => {
  const m = make();
  await m.app.handout({ address: addr(6001), device: device(6001) }, "203.0.113.7");
  m.setBalance(addr(6001), 0n); // under the fee part
  const base = m.transfers.length; // the handout itself sent one transfer
  const asks = Array.from({ length: 20 }, () => m.app.topUp({ address: addr(6001) }).then(() => "ok", () => "no"));
  const got = await Promise.all(asks);
  assert.equal(got.filter((x) => x === "ok").length, 2);
  assert.equal(m.transfers.length - base, 2);
  m.setBalance(addr(6001), 0n);
  await assert.rejects(m.app.topUp({ address: addr(6001) }), (e: unknown) => e instanceof Refused && e.code === "too-many");
});

test("fix 2a: a handout whose send never broadcasts removes the record and answers send-failed", async () => {
  const m = make({ transferThrows: true });
  await assert.rejects(m.app.handout({ address: addr(6100), device: device(6100) }, "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.status === 503 && e.code === "send-failed");
  assert.equal(m.transfers.length, 0);
  assert.equal(m.store.handed(addr(6100)), false);
});

test("fix 2b: a handout mined as a revert removes the record and answers send-failed", async () => {
  const m = make({ waitReverts: true });
  await assert.rejects(m.app.handout({ address: addr(6101), device: device(6101) }, "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.status === 503 && e.code === "send-failed");
  assert.equal(m.transfers.length, 1); // it was broadcast
  assert.equal(m.store.handed(addr(6101)), false);
});

test("fix 2c: a handout broadcast with an unknown outcome KEEPS the record and answers send-unknown; a retry sends nothing", async () => {
  const m = make({ waitThrows: "connect ETIMEDOUT http://rpc.invalid/secret 0x" + "cd".repeat(32) });
  await assert.rejects(m.app.handout({ address: addr(6102), device: device(6102) }, "203.0.113.7"),
    (e: unknown) => {
      assert.ok(e instanceof Refused && e.status === 503 && e.code === "send-unknown");
      const body = JSON.stringify({ error: e.code, ...e.extra });
      assert.ok(!body.includes("secret") && !body.includes("0x"), "body leaks internal text: " + body);
      return true;
    });
  assert.equal(m.transfers.length, 1); // broadcast once
  assert.equal(m.store.handed(addr(6102)), true); // kept
  await assert.rejects(m.app.handout({ address: addr(6102), device: device(6103) }, "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.code === "already-handed");
  assert.equal(m.transfers.length, 1); // the retry sent nothing
});

test("fix 2c: a top-up broadcast with an unknown outcome keeps the reservation; retries do not re-pay past the limit", async () => {
  const m = make();
  await m.app.handout({ address: addr(6200), device: device(6200) }, "203.0.113.7"); // succeeds
  m.failWait(true); // from here the receipt wait throws: the outcome is unknown
  m.setBalance(addr(6200), 0n);
  const base = m.transfers.length; // the handout itself sent one transfer
  await assert.rejects(m.app.topUp({ address: addr(6200) }), (e: unknown) => e instanceof Refused && e.code === "send-unknown");
  m.setBalance(addr(6200), 0n);
  await assert.rejects(m.app.topUp({ address: addr(6200) }), (e: unknown) => e instanceof Refused && e.code === "send-unknown");
  assert.equal(m.transfers.length - base, 2); // two reservations used, both broadcast
  m.setBalance(addr(6200), 0n);
  await assert.rejects(m.app.topUp({ address: addr(6200) }), (e: unknown) => e instanceof Refused && e.code === "too-many");
  assert.equal(m.transfers.length - base, 2); // the retry sent nothing: the kept reservations hold the limit
});

test("fix 4: an internal failure message never reaches the response body", async () => {
  const nasty = "connect ECONNREFUSED http://rpc.invalid/secret 0x" + "ab".repeat(32);
  const { app } = make({ transferThrows: nasty });
  await assert.rejects(
    app.handout({ address: addr(7001), device: device(7001) }, "203.0.113.7"),
    (e: unknown) => {
      assert.ok(e instanceof Refused && e.code === "send-failed");
      const body = JSON.stringify({ error: e.code, ...e.extra });
      assert.ok(!body.includes("secret"), "body leaks internal text: " + body);
      assert.ok(!body.includes("0x"), "body leaks a hash: " + body);
      return true;
    },
  );
});

test("fix 4: an RPC failure in the declareDefault dry run is 503 chain-unavailable, not 409 refused", async () => {
  const { app } = make({ defaultThrows: "connect ECONNREFUSED http://rpc.invalid/secret" });
  await assert.rejects(
    app.declareDefault("stage", "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.status === 503 && e.code === "chain-unavailable",
  );
});

test("a restart on the same database keeps what was handed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "vault-relayer-")), "relayer.db");
  const first = make({}, { store: openStore(path) });
  await first.app.handout({ address: addr(40), device: device(40) }, "203.0.113.7");
  first.store.close();
  const again = make({}, { store: openStore(path) });
  assert.equal(again.store.handed(addr(40)), true);
  await assert.rejects(again.app.handout({ address: addr(40), device: device(41) }, "203.0.113.7"), (e: unknown) => e instanceof Refused && e.code === "already-handed");
  again.store.close();
});

// Audit round 2.
test("round 2: a handout whose send the node never answered KEEPS the record and answers send-unknown", async () => {
  const m = make({ transferUnknown: true });
  await assert.rejects(m.app.handout({ address: addr(7001), device: device(7001) }, "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.status === 503 && e.code === "send-unknown" && !JSON.stringify(e.extra).includes("secret"));
  assert.equal(m.store.handed(addr(7001)), true);
  await assert.rejects(m.app.handout({ address: addr(7001), device: device(7002) }, "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.code === "already-handed");
});

test("round 2: a top-up whose send the node never answered keeps its reservation", async () => {
  const m = make();
  await m.app.handout({ address: addr(7003), device: device(7003) }, "203.0.113.7");
  m.setBalance(addr(7003), 0n);
  const n = make({ transferUnknown: true }, { store: m.store });
  n.setBalance(addr(7003), 0n);
  for (let i = 0; i < 2; i++) await assert.rejects(n.app.topUp({ address: addr(7003) }), (e: unknown) => e instanceof Refused && e.code === "send-unknown");
  await assert.rejects(n.app.topUp({ address: addr(7003) }), (e: unknown) => e instanceof Refused && e.code === "too-many");
});

test("round 2: a one-word failure that is not one of declareDefault's own errors is 503, and a long name is not passed on", async () => {
  await assert.rejects(make({ defaultThrows: "ECONNREFUSED" }).app.declareDefault("stage", "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.status === 503 && e.code === "chain-unavailable");
  await assert.rejects(make({ defaultThrows: "NotYet" }).app.declareDefault("stage", "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.status === 409 && e.code === "refused" && e.extra.why === "NotYet");
  await assert.rejects(make({ transferThrows: "A".repeat(1200) }).app.handout({ address: addr(7004), device: device(7004) }, "203.0.113.7"),
    (e: unknown) => e instanceof Refused && e.code === "send-failed" && JSON.stringify(e.extra) === "{}");
});
