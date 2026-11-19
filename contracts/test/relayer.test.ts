// Every value in this file is invented. None is a reading of any market.
// The relayer against the real BondedVault and TestDollar on the local chain: its real chain.ts
// and an in-memory store, with a phone whose key signs its own calls. The relayer is imported by
// relative path, not by package name, so no workspace install is needed to run this file.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { relayerChain } from "../../services/relayer/src/chain.ts";
import { relayer } from "../../services/relayer/src/relayer.ts";
import { Refused } from "../../services/relayer/src/refused.ts";
import { openStore } from "../../services/relayer/src/store.ts";
import { setup, USD } from "./helpers.ts";

const IP = "203.0.113.7";
const FOR_DEPOSIT = 50n * USD; // invented split of a handout
const FOR_FEES = 5n * USD;
const PLAN = ("0x" + "00".repeat(32)) as Hex;
const ERC20 = parseAbi(["function approve(address spender, uint256 amount)", "function transfer(address to, uint256 amount)"]);
const VAULTCALLS = parseAbi(["function deposit(uint256 amount)", "function requestWithdraw(uint256 shares)", "function claim()", "function startEpoch(bytes32 plan, uint256 draw)"]);

/** Builds the relayer over the local chain, with `stranger` as the relayer's funded key. */
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
  return { w, chainId, store, app, clock };
}

/** A phone: a thrown-away key given some of the local chain's own coin for gas. */
async function newPhone(w: Awaited<ReturnType<typeof setup>>) {
  const account = privateKeyToAccount(generatePrivateKey());
  const test = await w.viem.getTestClient();
  await test.setBalance({ address: account.address, value: 10n ** 18n }); // local gas; on Arc the handed dollars pay the fee
  return account;
}

describe("the relayer against BondedVault on the local chain", () => {
  it("hands a phone dollars; it approves and deposits exactly the deposit part, and the fee part survives, then withdraws and claims through an epoch", async () => {
    const { w, chainId, app } = await build();
    const phone = await newPhone(w);
    const fees = await w.publicClient.estimateFeesPerGas();
    let nonce = 0;
    const send = async (to: Address, data: Hex) => {
      const raw = (await phone.signTransaction({ to, data, value: 0n, gas: 400_000n, nonce: nonce++, chainId, type: "eip1559", maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })) as Hex;
      const { tx } = await app.relay({ raw });
      const r = await w.publicClient.waitForTransactionReceipt({ hash: tx });
      assert.equal(r.status, "success");
    };

    const handed = await app.handout({ address: phone.address, device: "device-aaaaaaaaaaaa" }, IP);
    assert.deepEqual([handed.forDeposit, handed.forFees], [FOR_DEPOSIT.toString(), FOR_FEES.toString()]);
    assert.equal(await w.balance(phone.address), FOR_DEPOSIT + FOR_FEES);

    await send(w.usdc.address, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [w.vault.address, FOR_DEPOSIT + FOR_FEES] }));
    await send(w.vault.address, encodeFunctionData({ abi: VAULTCALLS, functionName: "deposit", args: [FOR_DEPOSIT] }));

    assert.ok((await w.vault.read.sharesOf([phone.address])) > 0n, "its shares stand in the vault");
    // deposit() pulled exactly the deposit part; the fee part is still the phone's to pay its calls with.
    assert.equal(await w.balance(phone.address), FOR_FEES);

    // --- the fee part carries the phone through a withdraw and a claim across an epoch ---
    await w.vault.write.postBond([20n * USD], { account: w.operator.account });
    await w.vault.write.startEpoch([PLAN, 1n * USD], { account: w.operator.account });
    const shares = await w.vault.read.sharesOf([phone.address]);
    await send(w.vault.address, encodeFunctionData({ abi: VAULTCALLS, functionName: "requestWithdraw", args: [shares] }));
    await w.vault.write.closeEpoch([1n * USD], { account: w.operator.account });
    const before = await w.balance(phone.address);
    await send(w.vault.address, encodeFunctionData({ abi: VAULTCALLS, functionName: "claim", args: [] }));
    assert.ok((await w.balance(phone.address)) > before, "the asked withdrawal is claimed and paid");
    assert.equal(await w.vault.read.sharesOf([phone.address]), 0n);

    // The hub's point 1 ("deposit all"): a deposit of the phone's WHOLE balance dry-runs fine here,
    // because the local chain's fee is not paid in the token. The relayer therefore cannot keep a
    // phone from depositing its fee money too; capping a deposit under the balance is the page's job
    // in T14 and is recorded here only, not enforced.
    const whole = await w.balance(phone.address);
    assert.ok(whole > FOR_FEES, "the claim put real dollars back into the phone's hands");
    await send(w.usdc.address, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [w.vault.address, whole] }));
    await send(w.vault.address, encodeFunctionData({ abi: VAULTCALLS, functionName: "deposit", args: [whole] }));
    assert.equal(await w.balance(phone.address), 0n); // the fee part went in too — the relayer cannot stop it here
  });

  it("sends a default after the deadline and refuses it with the contract's word before, and once it is done", async () => {
    const { w, app } = await build();
    await w.vault.write.deposit([60n * USD], { account: w.alice.account });
    await w.vault.write.postBond([20n * USD], { account: w.operator.account });
    await w.vault.write.startEpoch([PLAN, 1n * USD], { account: w.operator.account });

    await assert.rejects(app.declareDefault("stage", IP), (e: unknown) => e instanceof Refused && e.code === "refused" && e.extra.why === "NotYet");
    await w.time.increase(61);
    const { tx } = await app.declareDefault("stage", IP);
    await w.publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal(await w.vault.read.defaulted(), true);
    await assert.rejects(app.declareDefault("stage", IP), (e: unknown) => e instanceof Refused && e.code === "refused" && e.extra.why === "NoEpoch");
  });

  it("refuses a signed startEpoch and a signed USDC transfer through route 6, sending nothing", async () => {
    const { w, chainId, app } = await build();
    const phone = await newPhone(w);
    await app.handout({ address: phone.address, device: "device-bbbbbbbbbbbb" }, IP);
    const fees = await w.publicClient.estimateFeesPerGas();

    // A signed startEpoch (the operator's own kind of call) is refused by its selector, whoever signs it.
    const op = await newPhone(w);
    const opBefore = await w.publicClient.getTransactionCount({ address: op.address });
    const opTx = (await op.signTransaction({ to: w.vault.address, data: encodeFunctionData({ abi: VAULTCALLS, functionName: "startEpoch", args: [PLAN, 1n * USD] }), value: 0n, gas: 300_000n, nonce: opBefore, chainId, type: "eip1559", maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })) as Hex;
    await assert.rejects(app.relay({ raw: opTx }), (e: unknown) => e instanceof Refused && e.code === "not-a-vault-call");
    assert.equal(await w.publicClient.getTransactionCount({ address: op.address }), opBefore);

    const phBefore = await w.publicClient.getTransactionCount({ address: phone.address });
    const phTx = (await phone.signTransaction({ to: w.usdc.address, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [w.operator.account.address, 1n * USD] }), value: 0n, gas: 300_000n, nonce: phBefore, chainId, type: "eip1559", maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })) as Hex;
    await assert.rejects(app.relay({ raw: phTx }), (e: unknown) => e instanceof Refused && e.code === "not-a-vault-call");
    assert.equal(await w.publicClient.getTransactionCount({ address: phone.address }), phBefore);
  });

  after(() => {});
});
