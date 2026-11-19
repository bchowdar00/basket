// Every value in this file is invented. None is a reading of any market.
// The vault's phone page, end to end on the local chain: the T14 browser wallet (wallet.ts) and the
// T14 vault reader/signer (chain.ts) driving the real relayer (wired as relayer.test.ts wires it)
// through a handout, an approve, a deposit, the shares read back, a requested withdrawal, a claim
// across an epoch, and a default refused before the deadline and sent after. The web files are
// imported by relative path, so no workspace install is needed; none of React or the page's CSS is
// pulled in (only the three pure modules). The phone's key is thrown away with the run.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { Address, Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

import { relayerChain } from "../../services/relayer/src/chain.ts";
import { relayer } from "../../services/relayer/src/relayer.ts";
import { Refused } from "../../services/relayer/src/refused.ts";
import { openStore } from "../../services/relayer/src/store.ts";
import { vaultChain } from "../../web/src/vault/chain.ts";
import { nextStep, type StepInput } from "../../web/src/vault/steps.ts";
import { loadOrMakeKey, type KeyStore } from "../../web/src/vault/wallet.ts";
import { setup, USD } from "./helpers.ts";

const IP = "203.0.113.9";
const FOR_DEPOSIT = 50n * USD; // an invented split of a handout
const FOR_FEES = 5n * USD;
const PLAN = ("0x" + "00".repeat(32)) as Hex;

function memory(): KeyStore {
  const held = new Map<string, string>();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => void held.set(k, v) };
}

/** The relayer over the local chain, with `stranger` as its funded key, and the T14 vault reader. */
async function build() {
  const w = await setup();
  const chainId = await w.publicClient.getChainId();
  const store = openStore(":memory:");
  const clock = { s: Math.floor(Date.now() / 1000), ms: Date.now() };
  const chain = relayerChain({ reader: w.publicClient, wallet: w.stranger, chainId, usdc: w.usdc.address });
  const app = relayer({
    store, chain, now: () => clock.s, nowMs: () => clock.ms,
    vaults: [{ name: "stage", vault: w.vault.address }], usdc: w.usdc.address, forDeposit: FOR_DEPOSIT, forFees: FOR_FEES, most: 20,
  });
  const reader = vaultChain({ reader: w.publicClient, vault: w.vault.address, usdc: w.usdc.address, chainId });
  return { w, chainId, app, reader };
}

/** A phone: the T14 browser wallet with a thrown-away key, given local gas (on Arc the handed
 * dollars themselves pay the fee). */
async function newPhone(w: Awaited<ReturnType<typeof setup>>) {
  const { wallet } = loadOrMakeKey(memory(), await w.publicClient.getChainId(), () => generatePrivateKey());
  const test = await w.viem.getTestClient();
  await test.setBalance({ address: wallet.address, value: 10n ** 18n });
  return wallet;
}

function stepOf(d: Awaited<ReturnType<ReturnType<typeof vaultChain>["read"]>>, nowSec: number) {
  const inp: StepInput = {
    balance: d.balance, allowance: d.allowance, shares: d.shares, claimable: d.claimable, waiting: d.waiting,
    asked: d.asked, epoch: { id: d.epoch.id, open: d.epoch.open, defaulted: d.epoch.defaulted, deadline: d.epoch.deadline },
    room: d.room, forFees: FOR_FEES, nowSec: nowSec,
  };
  return nextStep(inp);
}

describe("the vault's phone page against BondedVault on the local chain", () => {
  it("drives handout, approve, deposit, read-back, withdraw and claim through the page's own modules", async () => {
    const { w, chainId, app, reader } = await build();
    const phone = await newPhone(w);
    const fees = await w.publicClient.estimateFeesPerGas();
    const now = () => Math.floor(Date.now() / 1000);
    let nonce = 0;
    const relayCall = async (to: Address, data: Hex) => {
      const raw = await reader.sign(phone, { to, data }, { nonce: nonce++, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n });
      const { tx } = await app.relay({ raw });
      const r = await w.publicClient.waitForTransactionReceipt({ hash: tx });
      assert.equal(r.status, "success");
    };

    // Before anything, the page offers a handout.
    assert.equal(stepOf(await reader.read(phone.address), now()).kind, "handout");

    const handed = await app.handout({ address: phone.address, device: "device-pagepagepage" }, IP);
    assert.deepEqual([handed.forDeposit, handed.forFees], [FOR_DEPOSIT.toString(), FOR_FEES.toString()]);
    assert.equal(await w.balance(phone.address), FOR_DEPOSIT + FOR_FEES);

    // With dollars in hand and no allowance, the page offers to allow exactly the deposit part.
    const afterHandout = stepOf(await reader.read(phone.address), now());
    assert.equal(afterHandout.kind, "approve");
    assert.equal(afterHandout.amount, FOR_DEPOSIT);

    await relayCall(w.usdc.address, reader.encodeApprove(w.vault.address, FOR_DEPOSIT));
    const afterApprove = stepOf(await reader.read(phone.address), now());
    assert.equal(afterApprove.kind, "deposit");
    assert.equal(afterApprove.amount, FOR_DEPOSIT);

    await relayCall(w.vault.address, reader.encodeDeposit(FOR_DEPOSIT));

    // The shares stand in the vault, read back through chain.ts, and the deposit's worth is exact at
    // par. The fee part is still the phone's to pay its own calls with.
    const held = await reader.read(phone.address);
    assert.ok(held.shares > 0n, "its shares stand in the vault");
    assert.equal(held.worth, FOR_DEPOSIT); // the virtual-share price of what was deposited
    assert.equal(held.balance, FOR_FEES);
    assert.equal(stepOf(held, now()).kind, "ask"); // with no epoch open, the next step is to withdraw now

    // --- a withdrawal asked during an epoch, then claimed after it closes ---
    await w.vault.write.postBond([20n * USD], { account: w.operator.account });
    await w.vault.write.startEpoch([PLAN, 1n * USD], { account: w.operator.account });
    const shares = (await reader.read(phone.address)).shares;
    await relayCall(w.vault.address, reader.encodeRequestWithdraw(shares));

    // While the epoch is open, the asked withdrawal is a wait, not a new action.
    assert.equal(stepOf(await reader.read(phone.address), now()).kind, "waiting");

    await w.vault.write.closeEpoch([1n * USD], { account: w.operator.account });
    const beforeClaim = await w.balance(phone.address);

    // The epoch closed: what was asked is now claimable, so the page offers to claim.
    const ready = await reader.read(phone.address);
    assert.ok(ready.claimable > 0n, "the asked withdrawal is claimable after the close");
    assert.equal(stepOf(ready, now()).kind, "claim");

    await relayCall(w.vault.address, reader.encodeClaim());
    assert.ok((await w.balance(phone.address)) > beforeClaim, "the claim paid test dollars back to the phone");
    assert.equal((await reader.read(phone.address)).shares, 0n);
  });

  it("declares a default after the deadline, refused with the contract's word before and once done", async () => {
    const { w, app, reader } = await build();
    await w.vault.write.deposit([60n * USD], { account: w.alice.account });
    await w.vault.write.postBond([20n * USD], { account: w.operator.account });
    await w.vault.write.startEpoch([PLAN, 1n * USD], { account: w.operator.account });

    await assert.rejects(app.declareDefault("stage", IP), (e: unknown) => e instanceof Refused && e.code === "refused" && e.extra.why === "NotYet");
    await w.time.increase(61);
    const { tx } = await app.declareDefault("stage", IP);
    await w.publicClient.waitForTransactionReceipt({ hash: tx });

    const d = await reader.read(w.alice.account.address);
    assert.equal(d.epoch.defaulted, true);

    await assert.rejects(app.declareDefault("stage", IP), (e: unknown) => e instanceof Refused && e.code === "refused" && e.extra.why === "NoEpoch");
  });

  after(() => {});
});
