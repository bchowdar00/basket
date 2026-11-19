// Every amount in this file is invented. None is a reading of any market or price.
// Shared setup for BondedVault's tests: deploys TestDollar and a vault with given settings, and
// funds the named accounts. Every account made here is thrown away with the test run.
import assert from "node:assert/strict";

import { network } from "hardhat";
import { decodeEventLog, type Address, type Hex } from "viem";

export const USD = 1_000_000n; // one test dollar in USDC's six-decimal smallest unit
// Virtual-share scale (VIRTUAL_SHARES in the contract). After the T10-fix1 change, shares carry
// twelve decimals: one USDC unit buys VS share units at par, so a par vault's totalShares is
// assets * VS and a whole dollar (1e6 units) is worth 1e12 share units. Test share figures are
// written as `<usdc units> * VS` at par; off-par figures are hand-worked from the two formulas.
export const VS = 1_000_000n;

/** The stage's settings, from the brief: halves 3, 60-second epochs, part 5,000 bps, fee 2,000 bps. */
export type Settings = {
  drawBondHalves: number;
  drawVaultBps: number;
  gainBps: number;
  epochSeconds: number;
  capPerMarket: bigint;
  depositCap: bigint;
};

export const STAGE: Settings = {
  drawBondHalves: 3,
  drawVaultBps: 5000,
  gainBps: 2000,
  epochSeconds: 60,
  capPerMarket: 1_000n * USD,
  depositCap: 1_000_000n * USD,
};

export async function setup(over: Partial<Settings> = {}) {
  const { viem, networkHelpers } = await network.create();
  const time = networkHelpers.time;
  const wallets = await viem.getWalletClients();
  const [operator, alice, bob, carol, dave, eve, stranger] = wallets;
  const publicClient = await viem.getPublicClient();

  const usdc = await viem.deployContract("TestDollar");
  const s: Settings = { ...STAGE, ...over };
  const vault = await viem.deployContract("BondedVault", [
    usdc.address,
    operator.account.address,
    s.drawBondHalves,
    s.drawVaultBps,
    s.gainBps,
    s.epochSeconds,
    s.capPerMarket,
    s.depositCap,
  ]);

  const accounts = [operator, alice, bob, carol, dave, eve, stranger];
  const BIG = 100_000_000n * USD;
  for (const w of accounts) {
    await usdc.write.mint([w.account.address, BIG]);
    await usdc.write.approve([vault.address, BIG], { account: w.account });
  }

  const addr = (w: (typeof wallets)[number]) => w.account.address as Address;
  const low = (w: (typeof wallets)[number]) => w.account.address.toLowerCase() as Address;
  const balance = (who: Address) => usdc.read.balanceOf([who]);

  /** The vault's own events in a transaction, in order, as [name, argsObject]. */
  async function events(hash: Hex): Promise<[string, Record<string, unknown>][]> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const out: [string, Record<string, unknown>][] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vault.address.toLowerCase()) continue;
      const ev = decodeEventLog({ abi: vault.abi, data: log.data, topics: log.topics });
      out.push([ev.eventName, ev.args as unknown as Record<string, unknown>]);
    }
    return out;
  }

  /** The args of the first event of this name in the transaction. */
  async function event(hash: Hex, name: string): Promise<Record<string, unknown>> {
    const found = (await events(hash)).find(([n]) => n === name);
    assert.ok(found, `event ${name} not emitted`);
    return found[1];
  }

  return {
    viem,
    time,
    publicClient,
    usdc,
    vault,
    settings: s,
    operator,
    alice,
    bob,
    carol,
    dave,
    eve,
    stranger,
    accounts,
    addr,
    low,
    balance,
    events,
    event,
  };
}

export type World = Awaited<ReturnType<typeof setup>>;

/** Asserts a promise rejects with a revert whose decoded name is `errorName`. */
export async function expectRevert(promise: Promise<unknown>, errorName: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    const s = e instanceof Error ? e.message : String(e);
    assert.ok(s.includes(errorName), `expected revert ${errorName}, got:\n${s.slice(0, 400)}`);
    return;
  }
  assert.fail(`expected revert ${errorName}, but the call succeeded`);
}
