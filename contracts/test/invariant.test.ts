// Every amount in this file is invented. None is a reading of any market or price.
// A seeded run of 1,000 random steps over six accounts. After every step the contract holds at
// least what its books say it owes; no call made here reverts for lack of money; and nobody is
// credited a share that was not minted (the sum of owed shares plus askedShares never exceeds
// totalShares). At the end everybody withdraws and claims everything, and what is left beyond the
// bond is dust nobody can extract.
//
// The dust bound (fix brief 2): count a rounding ONLY where a conversion to DOLLARS left a remainder
// — _toAssets, at an immediate withdrawal, at the dollars set aside at a close, and at a claim. A
// conversion to shares that rounds down (_toShares: a deposit mint, a settle, a close's waiting
// mint) leaves no dollar behind — it only redistributes value among the shares — so it is not
// counted. Deposits are any amount from 1 unit to 50 dollars, not whole dollars only.
//
// Some runs push the price down with self-funded losing epochs until a start is refused with
// PriceTooLow (the floor); that refusal is expected and is counted, not an error.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Hex } from "viem";

import { setup, USD, VS, type World } from "./helpers.ts";

const VA = 1n; // VIRTUAL_ASSETS
const STEPS = 1000;
// Two seeds by default: one ordinary run that ends by default, and one that pushes to the price
// floor and goes on after it (audit round 3, R3-2: the default seed alone never reached the floor).
// SEED=<n> runs that one seed instead.
const AT_THE_FLOOR = 7;
const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : [0xc0ffee, AT_THE_FLOOR];
const PLAN: Hex = `0x${"a5".repeat(32)}`;

/** mulberry32: a small deterministic PRNG, so the run is reproducible from the printed seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A division truncated iff it left a remainder. Only the dollar side (_toAssets) is counted.
const rem = (num: bigint, den: bigint): bigint => (num % den === 0n ? 0n : 1n);
const assetsTrunc = (shares: bigint, a: bigint, s: bigint): bigint => rem(shares * (a + VA), s + VS);

describe("invariant", () => {
  for (const SEED of SEEDS) it(`holds over ${STEPS} random steps (seed ${SEED})`, async () => {
    const w = await setup({ drawBondHalves: 4, drawVaultBps: 5000, gainBps: 2000, epochSeconds: 100, depositCap: 200_000n * USD });
    const v = w.vault;
    const rnd = rng(SEED);
    const users = [w.alice, w.bob, w.carol, w.dave, w.eve, w.stranger];
    const pickUser = () => users[Math.floor(rnd() * users.length)];
    const between = (lo: bigint, hi: bigint) => lo + BigInt(Math.floor(rnd() * Number(hi - lo + 1n)));
    const gainBps = BigInt(await v.read.gainBps());
    const drawVaultBps = BigInt(await v.read.drawVaultBps());
    const depositCap = await v.read.depositCap();

    let roundings = 0n; // the _toAssets divisions that ACTUALLY left a remainder
    // About one run in three is allowed to end an epoch by default; about two in five push toward the
    // price floor. A defaulting run holds its default until 60 epochs have closed; a floor-pushing run
    // reaches far more closes than that before it freezes, so the busy minimum is always met first.
    const allowDefault = rnd() < 1 / 3;
    const floorMode = rnd() < 0.4;
    let floored = false; // set once a start is refused with PriceTooLow (the floor is reached)
    const count: Record<string, number> = { deposit: 0, withdraw: 0, claim: 0, postBond: 0, withdrawBond: 0, start: 0, close: 0, default: 0, refused: 0 };

    async function state() {
      const [bond, assets, totalShares, totalWaiting, setAside, askedShares, open, defaulted, epochId, drawn, deadline, bal] = await Promise.all([
        v.read.bond(),
        v.read.assets(),
        v.read.totalShares(),
        v.read.totalWaiting(),
        v.read.setAside(),
        v.read.askedShares(),
        v.read.open(),
        v.read.defaulted(),
        v.read.epochId(),
        v.read.drawn(),
        v.read.deadline(),
        w.balance(v.address),
      ]);
      return { bond, assets, totalShares, totalWaiting, setAside, askedShares, open, defaulted, epochId, drawn, deadline, bal };
    }

    function checkMoney(s: Awaited<ReturnType<typeof state>>, where: string) {
      // the contract never owes more than it holds
      assert.ok(s.bal >= s.bond + s.assets + s.totalWaiting + s.setAside, `money invariant broken after ${where}: bal=${s.bal} owed=${s.bond + s.assets + s.totalWaiting + s.setAside}`);
    }

    // nobody is credited a share that was not minted: owed shares (settled view) over all six
    // accounts, plus the open epoch's askedShares, never exceed totalShares.
    async function checkShares(where: string) {
      const [totalShares, askedShares] = await Promise.all([v.read.totalShares(), v.read.askedShares()]);
      let sum = askedShares;
      for (const u of users) sum += (await v.read.owed([w.addr(u)]))[0];
      assert.ok(sum <= totalShares, `share-conservation invariant broken after ${where}: owed+asked=${sum} > totalShares=${totalShares}`);
    }

    // The _toAssets truncation a user's pending _collect would do at the current state: the asked
    // withdrawal is a dollar conversion; the waiting-default leg pays whole, so it is no division.
    async function collectTrunc(u: World["alice"], epochId: bigint, open: boolean): Promise<bigint> {
      const [shares, epoch] = await v.read.askedOf([w.addr(u)]);
      if (shares === 0n) return 0n;
      if (epoch === epochId && open) return 0n;
      const [ca, cs] = await v.read.closes([epoch]);
      return assetsTrunc(shares, ca, cs);
    }

    // The _toAssets truncation a close/default records for its asked withdrawals (0 when none asked).
    function closeAskedTrunc(s: Awaited<ReturnType<typeof state>>, a1: bigint): bigint {
      return s.askedShares > 0n ? assetsTrunc(s.askedShares, a1, s.totalShares) : 0n;
    }

    async function tryStart(draw: bigint): Promise<"ok" | "refused"> {
      try {
        await v.write.startEpoch([PLAN, draw], { account: w.operator.account });
        return "ok";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("PriceTooLow")) return "refused";
        throw e;
      }
    }

    // --- the actions; each checks its own preconditions, then must not revert for lack of money ---

    async function doDeposit() {
      const u = pickUser();
      const s = await state();
      if (s.defaulted) return;
      const amt = between(1n, 50n * USD); // any amount, 1 unit to 50 dollars
      if (s.assets + s.totalWaiting + (s.open ? s.drawn : 0n) + amt > depositCap) return;
      if (!s.open && amt * (s.totalShares + VS) < s.assets + VA) return; // would mint 0
      await v.write.deposit([amt], { account: u.account });
      count.deposit++;
      // the mint is share-side: no dollar left behind, nothing counted
    }

    async function doWithdraw() {
      const u = pickUser();
      const s = await state();
      const [shares] = await v.read.owed([w.addr(u)]);
      if (shares === 0n) return;
      const n = between(1n, shares);
      let t = await collectTrunc(u, s.epochId, s.open); // the _collect dollar conversion, if any
      if (!s.open) t += assetsTrunc(n, s.assets, s.totalShares); // the immediate payout
      await v.write.requestWithdraw([n], { account: u.account });
      count.withdraw++;
      roundings += t;
    }

    async function doClaim() {
      const u = pickUser();
      const s = await state();
      const [, claimable] = await v.read.owed([w.addr(u)]);
      if (claimable === 0n) return;
      const t = await collectTrunc(u, s.epochId, s.open);
      await v.write.claim({ account: u.account });
      count.claim++;
      roundings += t;
    }

    async function doPostBond() {
      const s = await state();
      if (s.defaulted) return;
      await v.write.postBond([between(1n, 30n) * USD], { account: w.operator.account });
      count.postBond++;
    }

    async function doWithdrawBond() {
      const s = await state();
      if (s.open || s.defaulted || s.bond === 0n) return;
      await v.write.withdrawBond([between(1n, s.bond)], { account: w.operator.account });
      count.withdrawBond++;
    }

    async function doStart() {
      const s = await state();
      if (s.open || s.defaulted) return;
      const [, , maxDraw] = await v.read.limits();
      if (maxDraw === 0n) return;
      const res = await tryStart(between(1n, maxDraw));
      if (res === "refused") {
        floored = true;
        count.refused++;
      } else count.start++;
    }

    async function doClose(returned: bigint) {
      const s = await state();
      if (!s.open) return;
      const r = returned > 2n * s.drawn ? 2n * s.drawn : returned;
      let a1: bigint;
      if (r >= s.drawn) {
        const gain = r - s.drawn;
        a1 = s.assets + s.drawn + gain - (gain * gainBps) / 10000n; // the recorded close assets
      } else {
        const loss = s.drawn - r;
        const fromBond = loss < s.bond ? loss : s.bond;
        a1 = s.assets + r + fromBond;
      }
      const t = closeAskedTrunc(s, a1); // only the asked-out dollar conversion is counted
      await v.write.closeEpoch([r], { account: w.operator.account });
      count.close++;
      roundings += t;
    }

    async function doDefault() {
      const s = await state();
      if (!s.open) return;
      await w.time.increaseTo(Number(s.deadline) + 1);
      const t = closeAskedTrunc(s, s.assets + s.bond); // the whole bond comes in before the epoch ends
      await v.write.declareDefault({ account: pickUser().account });
      count.default++;
      roundings += t;
    }

    // Push the price down to reach the floor: top the assets back up (a mint — share-side, not
    // counted), then draw the most the assets allow against the least bond, returning nothing, so the
    // loss falls on assets and the ratio climbs. Once a start is refused, `floored` is set and the run
    // falls through to the ordinary random mix for the rest of its steps.
    async function doFloorPush() {
      const s = await state();
      if (s.open || s.defaulted) return;
      if (s.assets < depositCap / 16n) {
        const room = depositCap - s.assets - s.totalWaiting;
        if (room > 0n) {
          await v.write.deposit([room], { account: w.alice.account }); // a user, so it is drained at the end
          count.deposit++;
        }
        return;
      }
      const draw = (s.assets * drawVaultBps) / 10000n;
      if (draw === 0n) return;
      const need = (2n * draw + 3n) / 4n; // bond >= draw * 2 / halves, halves = 4
      if (s.bond < need) {
        await v.write.postBond([need - s.bond], { account: w.operator.account });
        count.postBond++;
      }
      const res = await tryStart(draw);
      if (res === "refused") {
        floored = true;
        count.refused++;
      } else count.start++;
    }

    // --- the run ---
    for (let i = 0; i < STEPS; i++) {
      const s = await state();
      const r = rnd();
      if (s.defaulted) {
        if (r < 0.5) await doWithdraw();
        else await doClaim();
      } else if (floorMode && !floored) {
        // drive toward the floor: start/push when closed, close with nothing when open
        if (s.open) await doClose(0n);
        else await doFloorPush();
      } else if (s.open) {
        // default only on an allowed run and only once 60 epochs have closed, so the busy minimum is
        // reached first; otherwise close (sometimes with nothing returned), with deposits mixed in.
        if (allowDefault && count.close >= 60 && r < 0.05) await doDefault();
        else if (r < 0.2) await doClose(0n); // close with nothing returned
        else if (r < 0.5) await doClose(between(0n, 2n * s.drawn));
        else if (r < 0.82) await doDeposit();
        else if (r < 0.9) await doWithdraw();
        else if (r < 0.96) await doClaim();
        else await doPostBond();
      } else {
        if (r < 0.46) await doDeposit();
        else if (r < 0.76) await doStart();
        else if (r < 0.85) await doWithdraw();
        else if (r < 0.92) await doClaim();
        else if (r < 0.97) await doPostBond();
        else await doWithdrawBond();
      }
      const after = await state();
      checkMoney(after, `step ${i}`);
      await checkShares(`step ${i}`);
    }

    // --- drain: close any open epoch, then everybody claims and withdraws everything ---
    let end = await state();
    if (end.open) {
      roundings += closeAskedTrunc(end, end.assets); // flat close: a1 = assets (no gain, no loss)
      await v.write.closeEpoch([end.drawn], { account: w.operator.account });
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const u of users) {
        const s = await state();
        const [, claimable] = await v.read.owed([w.addr(u)]);
        if (claimable > 0n) {
          roundings += await collectTrunc(u, s.epochId, s.open);
          await v.write.claim({ account: u.account });
        }
        const s2 = await state();
        const [shares] = await v.read.owed([w.addr(u)]);
        if (shares > 0n) {
          roundings += await collectTrunc(u, s2.epochId, s2.open);
          if (!s2.open) roundings += assetsTrunc(shares, s2.assets, s2.totalShares);
          await v.write.requestWithdraw([shares], { account: u.account });
        }
      }
    }

    end = await state();
    checkMoney(end, "drain");
    await checkShares("drain");
    // everything waiting has been claimed back
    assert.equal(end.totalWaiting, 0n, "all waiting deposits claimed");
    // the books balance exactly: no unaccounted USDC (none was sent astray)
    assert.equal(end.bal, end.bond + end.assets + end.totalWaiting + end.setAside, "books balance the holdings");
    // what is left beyond the bond is dust nobody can extract, at most one unit per dollar truncation
    const dust = end.assets + end.setAside;
    assert.ok(dust <= roundings, `dust ${dust} exceeds the ${roundings} dollar truncations counted`);

    // every real owner's shares are out; only orphan shares (nobody's, from rounding) may remain
    for (const u of users) assert.equal(await v.read.sharesOf([w.addr(u)]), 0n, "every account withdrew its shares");

    // the run really exercised the machinery: busy by design
    assert.ok(count.deposit >= 150, `too few deposits: ${count.deposit}`);
    assert.ok(count.close >= 60, `too few closes: ${count.close}`);
    assert.ok(count.start >= 60 && count.withdraw >= 10, `thin coverage: ${JSON.stringify(count)}`);

    // the floor seed really reached the floor: a start was refused there, and the run went on after it
    if (SEED === AT_THE_FLOOR && !process.env.SEED) assert.ok(floorMode && count.refused > 0, `seed ${SEED} did not reach the floor: ${JSON.stringify(count)}`);

    // eslint-disable-next-line no-console
    console.log(
      `invariant: seed ${SEED}, dust=${dust}, bound=${roundings}, closes=${count.close}, defaults=${count.default}, ` +
        `deposits=${count.deposit}, refused=${count.refused}, floorMode=${floorMode}, allowDefault=${allowDefault}, actions=${JSON.stringify(count)}`,
    );
  });
});
