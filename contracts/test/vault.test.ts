// Every amount in this file is invented. None is a reading of any market or price.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zeroAddress, type Hex } from "viem";

import { setup, expectRevert, USD, VS, STAGE, type World } from "./helpers.ts";

const PLAN: Hex = `0x${"ab".repeat(32)}`;
const PLAN2: Hex = `0x${"cd".repeat(32)}`;

// The two conversion formulas the contract uses (floor). VIRTUAL_ASSETS = 1, VIRTUAL_SHARES = VS.
// Used here only to spell the hand-working beside off-par assertions; the real check is the contract.
const toShares = (amount: bigint, a: bigint, s: bigint) => (amount * (s + VS)) / (a + 1n);
const toAssets = (shares: bigint, a: bigint, s: bigint) => (shares * (a + 1n)) / (s + VS);

// ----- small flows, spelled out so each test reads as one behaviour -----
const deposit = (w: World, who: World["alice"], amt: bigint) => w.vault.write.deposit([amt], { account: who.account });
const postBond = (w: World, amt: bigint) => w.vault.write.postBond([amt], { account: w.operator.account });
const start = (w: World, draw: bigint, plan: Hex = PLAN) => w.vault.write.startEpoch([plan, draw], { account: w.operator.account });
const close = (w: World, returned: bigint) => w.vault.write.closeEpoch([returned], { account: w.operator.account });

async function passDeadline(w: World) {
  const d = await w.vault.read.deadline();
  await w.time.increaseTo(Number(d) + 1);
}

// 1 ------------------------------------------------------------------------
describe("1 settings", async () => {
  const w = await setup();
  const base = () => [w.usdc.address, w.operator.account.address, STAGE.drawBondHalves, STAGE.drawVaultBps, STAGE.gainBps, STAGE.epochSeconds, STAGE.capPerMarket, STAGE.depositCap] as const;

  it("the stage settings deploy and are immutable and public", async () => {
    const v = await w.viem.deployContract("BondedVault", [...base()]);
    assert.equal((await v.read.operator()).toLowerCase(), w.operator.account.address.toLowerCase());
    assert.equal(await v.read.drawBondHalves(), 3);
    assert.equal(await v.read.drawVaultBps(), 5000);
    assert.equal(await v.read.gainBps(), 2000);
    assert.equal(await v.read.epochSeconds(), 60);
    assert.equal(await v.read.capPerMarket(), STAGE.capPerMarket);
    assert.equal(await v.read.depositCap(), STAGE.depositCap);
  });

  it("each out-of-range constructor value reverts BadSetting", async () => {
    const bad: (readonly unknown[])[] = [
      [zeroAddress, w.operator.account.address, 3, 5000, 2000, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, zeroAddress, 3, 5000, 2000, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 0, 5000, 2000, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 5, 5000, 2000, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 3, 0, 2000, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 3, 10000, 2000, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 3, 5000, 10001, 60, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 3, 5000, 2000, 0, STAGE.capPerMarket, STAGE.depositCap],
      [w.usdc.address, w.operator.account.address, 3, 5000, 2000, 60, STAGE.capPerMarket, 0n],
    ];
    for (const args of bad) await expectRevert(w.viem.deployContract("BondedVault", args as never), "BadSetting");
    // the boundaries that are allowed: halves 1 and 4, bps 1 and 9999, gain 0 and 10000
    await w.viem.deployContract("BondedVault", [w.usdc.address, w.operator.account.address, 1, 1, 0, 1, 0n, 1n] as never);
    await w.viem.deployContract("BondedVault", [w.usdc.address, w.operator.account.address, 4, 9999, 10000, 60, STAGE.capPerMarket, STAGE.depositCap] as never);
  });
});

// 2 ------------------------------------------------------------------------
describe("2 the deposit cap", () => {
  it("no epoch open: reaching the cap passes, one unit more reverts OverCap", async () => {
    const w = await setup({ depositCap: 1_000n * USD });
    await deposit(w, w.alice, 600n * USD);
    await deposit(w, w.bob, 400n * USD); // assets now exactly the cap
    assert.equal(await w.vault.read.assets(), 1_000n * USD);
    await expectRevert(deposit(w, w.carol, 1n), "OverCap");
  });

  // F4 (fix brief): the cap, exactly, with an epoch open — assets + totalWaiting + drawn must reach
  // the cap, no looser. Replaces the old "waiting deposits count" test, which took the looser sum.
  it("an epoch open: assets + waiting + the draw must reach the cap, exactly", async () => {
    const w = await setup({ depositCap: 1_000n * USD });
    await deposit(w, w.alice, 500n * USD); // assets 500
    await postBond(w, 1_000n * USD);
    await start(w, 200n * USD); // byVault = 500*5000/10000 = 250 >= 200; assets 300, drawn 200
    // room = cap - assets(300) - waiting(0) - drawn(200) = 500
    assert.equal(await w.vault.read.room(), 500n * USD);
    // one unit over the exact cap reverts: assets(300)+waiting(500.000001)+drawn(200) = cap + 1
    await expectRevert(deposit(w, w.bob, 500n * USD + 1n), "OverCap");
    // exactly the cap passes: assets(300) + waiting(500) + drawn(200) = 1000 = cap
    await deposit(w, w.bob, 500n * USD);
    assert.equal(await w.vault.read.totalWaiting(), 500n * USD);
    assert.equal(await w.vault.read.room(), 0n);
    // now one unit more reverts
    await expectRevert(deposit(w, w.carol, 1n), "OverCap");
  });

  it("after a gain lifts assets past the cap, a deposit reverts but a withdrawal still pays", async () => {
    const w = await setup({ depositCap: 1_000n * USD });
    await deposit(w, w.alice, 1_000n * USD); // shares 1000*VS
    await postBond(w, 1_000n * USD);
    await start(w, 500n * USD); // assets 500
    await close(w, 700n * USD); // gain 200, fee 40, assets 1160 > cap
    assert.equal(await w.vault.read.assets(), 1_160n * USD);
    await expectRevert(deposit(w, w.bob, 1n), "OverCap");
    const before = await w.balance(w.addr(w.alice));
    // withdraw all 1000*VS shares: toAssets(1000*VS, 1160*USD, 1000*VS)
    //   = 1000*VS*(1160e6+1)/(1000*VS+1e6) = 1000e6*1_160_000_001/1_000_000_001 = 1_159_999_999
    const paid = toAssets(1_000n * USD * VS, 1_160n * USD, 1_000n * USD * VS);
    assert.equal(paid, 1_159_999_999n);
    await w.vault.write.requestWithdraw([1_000n * USD * VS], { account: w.alice.account });
    assert.equal(await w.balance(w.addr(w.alice)), before + 1_159_999_999n);
  });
});

// F3 (fix brief): the deposit cap counts money that is out with the operator (PoC C) -------------
describe("F3 the cap counts the draw", () => {
  it("room() subtracts the draw; a deposit that would pass only on the draw reverts; a flat close stays under cap", async () => {
    const w = await setup({ depositCap: 1_000n * USD, drawVaultBps: 9999, drawBondHalves: 4 });
    await deposit(w, w.alice, 1_000n * USD); // assets at the cap
    await postBond(w, 1_000n * USD);
    await start(w, 999_900_000n); // draw 999.9; assets 100_000, drawn 999_900_000
    // room = cap - assets(100_000) - waiting(0) - drawn(999_900_000) = 0
    assert.equal(await w.vault.read.room(), 0n);
    assert.equal(
      await w.vault.read.room(),
      1_000n * USD - (await w.vault.read.assets()) - (await w.vault.read.totalWaiting()) - (await w.vault.read.drawn()),
    );
    // without counting the draw this would pass (assets 100_000 + amount 999_900_000 = cap); it must not
    await expectRevert(deposit(w, w.bob, 999_900_000n), "OverCap");
    await close(w, 999_900_000n); // flat; assets 100_000 + drawn 999_900_000 = 1_000_000_000 = cap
    assert.ok((await w.vault.read.assets()) <= 1_000n * USD);
    assert.equal(await w.vault.read.assets(), 1_000n * USD);
  });
});

// F1 (fix brief): a pair who lift the price cannot take a waiting deposit (PoC A) ----------------
describe("F1 a waiting deposit cannot be taken by a price-setting pair", () => {
  it("the outsider keeps shares worth ~what they put in, and the pair end worse off", async () => {
    const w = await setup();
    const op = w.operator.account;
    const pair0 = (await w.balance(w.addr(w.operator))) + (await w.balance(w.addr(w.alice)));
    const victim0 = await w.balance(w.addr(w.bob));
    await w.vault.write.postBond([1n * USD], { account: op });
    await w.vault.write.deposit([2n], { account: w.alice.account }); // minted 2*VS = 2_000_000, assets 2
    await start(w, 1n); // assets 1
    await w.vault.write.deposit([1_000n * USD], { account: w.bob.account }); // victim waits
    await close(w, 1n + 2_500n * USD); // gain 2500, fee 500; record assets 2_000_000_002, shares 2_000_000
    // waiting mints toShares(1000e6, 2_000_000_002, 2_000_000) = 1000e6*3_000_000/2_000_000_003 = 1_499_999
    assert.equal((await w.vault.read.owed([w.addr(w.bob)]))[0], 1_499_999n);
    assert.ok((await w.vault.read.owed([w.addr(w.bob)]))[0] > 0n, "victim credited shares, not zero");

    // victim withdraws: toAssets(1_499_999, 3_000_000_002, 3_499_999) = 1_499_999*3_000_000_003/4_499_999 = 999_999_556
    await w.vault.write.requestWithdraw([1_499_999n], { account: w.bob.account });
    const victimNet = (await w.balance(w.addr(w.bob))) - victim0;
    assert.equal(victimNet, 999_999_556n - 1_000n * USD); // -444: within 1000 units of whole
    assert.ok(victim0 - (await w.balance(w.addr(w.bob))) <= 1_000n, "victim out at most 1000 units"); // out 444

    // the pair unwind: alice withdraws her 2*VS shares, the operator takes its bond back
    await w.vault.write.requestWithdraw([2n * VS], { account: w.alice.account });
    await w.vault.write.withdrawBond([1n * USD], { account: op });
    const pairNet = (await w.balance(w.addr(w.operator))) + (await w.balance(w.addr(w.alice))) - pair0;
    // The pair are worse off AT THIS POINT ONLY: the gain they paid is held against the virtual
    // shares, which no depositor can withdraw. It is not final — with nobody else holding shares the
    // operator can draw it back over later epochs, a draw less its bond at a time, and end ahead
    // (see evidence/T10-poc2-f1-recover.test.ts.txt and T10-poc2-f1-scaled.test.ts.txt). What does
    // not change is the victim's loss: the 444 units rounding took, either way.
    assert.ok(pairNet < 0n, `pair should end worse off at this point, net ${pairNet}`);
  });
});

// F2 (fix brief): asked-out shares leave no assets without shares (PoC B) -----------------------
describe("F2 asked-out shares leave no assets without shares", () => {
  it("totalShares stays positive, and a later depositor cannot take the pot", async () => {
    const w = await setup();
    const op = w.operator.account;
    await w.vault.write.postBond([1n * USD], { account: op });
    await w.vault.write.deposit([2n], { account: w.alice.account }); // 2*VS shares
    await start(w, 1n);
    await w.vault.write.requestWithdraw([2n * VS], { account: w.alice.account }); // all shares asked
    await w.vault.write.deposit([1_000n * USD], { account: w.bob.account }); // victim waits
    await close(w, 1n + 2_500n * USD);
    // record assets 2_000_000_002, shares 2_000_000; asked out 1_333_333_335; waiting mints 1_499_999
    assert.equal(await w.vault.read.totalShares(), 1_499_999n);
    assert.ok((await w.vault.read.totalShares()) > 0n, "totalShares not zero");
    assert.equal(await w.vault.read.assets(), 1_666_666_667n); // 666_666_667 (after asked) + 1000e6 waiting

    // a one-unit deposit cannot buy a share here: toShares(1, 1_666_666_667, 1_499_999) = 0
    await expectRevert(deposit(w, w.carol, 1n), "Nothing");
    // a 1,000-unit deposit mints 1 share (toShares(1000,..)=1) and a full withdrawal pays no more than it
    const b0 = await w.balance(w.addr(w.carol));
    await w.vault.write.deposit([1_000n], { account: w.carol.account });
    const sh = await w.vault.read.sharesOf([w.addr(w.carol)]);
    assert.equal(sh, 1n); // toShares(1000, 1_666_666_667, 1_499_999) = 1000*2_499_999/1_666_666_668 = 1
    await w.vault.write.requestWithdraw([sh], { account: w.carol.account });
    const carolNet = (await w.balance(w.addr(w.carol))) - b0;
    assert.ok(carolNet <= 1_000n, `carol got ${carolNet}, more than put in`); // 1000 in, 666 out
  });
});

// 2a -----------------------------------------------------------------------
describe("2a minting shares", () => {
  it("the first deposit mints amount*VS; a later deposit buys at the virtual-share price rounded down", async () => {
    const w = await setup();
    // empty vault: minted = toShares(1000e6, 0, 0) = 1000e6 * (0 + 1e6) / (0 + 1) = 1000e6 * 1e6 = 1e15
    const h = await deposit(w, w.alice, 1_000n * USD);
    assert.equal((await w.event(h, "Deposited")).minted, 1_000n * USD * VS);
    assert.equal(await w.vault.read.sharesOf([w.addr(w.alice)]), 1_000n * USD * VS);
    assert.equal(await w.vault.read.totalShares(), 1_000n * USD * VS);

    // lift the price with a gain: assets 1080, totalShares 1e15
    await postBond(w, 1_000n * USD);
    await start(w, 500n * USD);
    await close(w, 600n * USD); // gain 100, fee 20, assets 1080
    assert.equal(await w.vault.read.assets(), 1_080n * USD);

    // bob deposits 7 units: toShares(7, 1080e6, 1e15) = 7*(1e15+1e6)/(1080e6+1)
    //   = 7*1_000_000_001_000_000 / 1_080_000_001 = 6_481_481 (rounded down)
    const expected = toShares(7n, 1_080n * USD, 1_000n * USD * VS);
    assert.equal(expected, 6_481_481n);
    const hb = await deposit(w, w.bob, 7n);
    assert.equal((await w.event(hb, "Deposited")).minted, 6_481_481n);
    assert.equal(await w.vault.read.sharesOf([w.addr(w.bob)]), 6_481_481n);
    // (a deposit too small to mint a share needs a far larger gain than this — see F6)
  });
});

// F5 (fix brief): an empty vault's first deposit ------------------------------------------------
describe("F5 an empty vault's first deposit", () => {
  it("mints amount*VS, and sharePrice is 1e18 before and after", async () => {
    const w = await setup();
    assert.equal(await w.vault.read.sharePrice(), 10n ** 18n); // empty: ((0+1)*1e18*1e6)/(0+1e6)=1e18
    const h = await deposit(w, w.alice, 2_500n * USD); // minted = 2500e6 * 1e6 = 2.5e15
    assert.equal((await w.event(h, "Deposited")).minted, 2_500n * USD * VS);
    assert.equal(await w.vault.read.totalShares(), 2_500n * USD * VS);
    // at par totalShares = assets*1e6, so sharePrice = ((a+1)*1e18*1e6)/(a*1e6+1e6) = 1e18
    assert.equal(await w.vault.read.sharePrice(), 10n ** 18n);
  });
});

// F6 (fix brief): a deposit too small to buy a share unit reverts Nothing after a big gain -------
describe("F6 a deposit too small to buy a share unit", () => {
  it("reverts Nothing once one share unit costs more than one USDC unit", async () => {
    const w = await setup();
    await deposit(w, w.alice, 2n); // assets 2, shares 2*VS = 2_000_000
    await postBond(w, 1n * USD); // byBond = 1e6*3/2 = 1_500_000 >= draw 1
    await start(w, 1n); // byVault = 2*5000/10000 = 1 >= draw 1; assets 1
    // gain 7_500_000, fee = 7_500_000*2000/10000 = 1_500_000; assets = 1 + 1 + 7_500_000 - 1_500_000
    await close(w, 7_500_001n);
    assert.equal(await w.vault.read.assets(), 6_000_002n);
    assert.equal(await w.vault.read.totalShares(), 2n * VS);
    // one share unit now costs toAssets(1, 6_000_002, 2_000_000) = 3_000_003/3_000_000 = 1 ... actually
    //   (6_000_002+1)/(2_000_000+1_000_000) = 6_000_003/3_000_000 = 2 units > 1
    assert.equal(toAssets(1n, 6_000_002n, 2n * VS), 2n);
    // so one USDC unit buys toShares(1, 6_000_002, 2_000_000) = 3_000_000/6_000_003 = 0 share units
    assert.equal(toShares(1n, 6_000_002n, 2n * VS), 0n);
    await expectRevert(deposit(w, w.bob, 1n), "Nothing");
  });
});

// 3 ------------------------------------------------------------------------
describe("3 the bond", () => {
  it("only the operator posts and withdraws; open reverts EpochOpen; over the bond reverts NotEnough", async () => {
    const w = await setup();
    await expectRevert(w.vault.write.postBond([100n * USD], { account: w.stranger.account }), "NotOperator");
    const hp = await postBond(w, 1_000n * USD);
    assert.deepEqual((await w.event(hp, "BondPosted")), { amount: 1_000n * USD, bond: 1_000n * USD });
    assert.equal(await w.vault.read.bond(), 1_000n * USD);

    await expectRevert(w.vault.write.withdrawBond([1n], { account: w.stranger.account }), "NotOperator");
    await expectRevert(w.vault.write.withdrawBond([0n], { account: w.operator.account }), "Nothing");
    await expectRevert(w.vault.write.withdrawBond([2_000n * USD], { account: w.operator.account }), "NotEnough");

    // withdraw is refused while an epoch is open
    await deposit(w, w.alice, 1_000n * USD);
    await start(w, 100n * USD);
    await expectRevert(w.vault.write.withdrawBond([100n * USD], { account: w.operator.account }), "EpochOpen");
    await close(w, 100n * USD);
    const hw = await w.vault.write.withdrawBond([400n * USD], { account: w.operator.account });
    assert.deepEqual((await w.event(hw, "BondWithdrawn")), { amount: 400n * USD, bond: 600n * USD });
    assert.equal(await w.vault.read.bond(), 600n * USD);
  });
});

// 4 ------------------------------------------------------------------------
describe("4 the draw limit", () => {
  it("the bond binds, the part binds, zero and no-bond are refused", async () => {
    // bond 5,000, assets 100,000, halves 4 (byBond 10,000), part 5,000 bps (byVault 50,000): bond binds
    const a = await setup({ drawBondHalves: 4, drawVaultBps: 5000 });
    await deposit(a, a.alice, 100_000n * USD);
    await postBond(a, 5_000n * USD);
    assert.deepEqual(await a.vault.read.limits(), [10_000n * USD, 50_000n * USD, 10_000n * USD]);
    await expectRevert(start(a, 10_000n * USD + 1n), "OverLimit");
    await expectRevert(start(a, 0n), "Nothing");
    await start(a, 10_000n * USD); // exactly the bond limit passes
    assert.equal(await a.vault.read.open(), true);

    // assets 12,000: the part binds at 6,000
    const b = await setup({ drawBondHalves: 4, drawVaultBps: 5000 });
    await deposit(b, b.alice, 12_000n * USD);
    await postBond(b, 5_000n * USD);
    assert.deepEqual(await b.vault.read.limits(), [10_000n * USD, 6_000n * USD, 6_000n * USD]);
    await expectRevert(start(b, 6_000n * USD + 1n), "OverLimit");
    await start(b, 6_000n * USD);
    assert.equal(await b.vault.read.open(), true);

    // no bond: any draw is over the (zero) bond limit
    const c = await setup({ drawBondHalves: 4, drawVaultBps: 5000 });
    await deposit(c, c.alice, 100_000n * USD);
    await expectRevert(start(c, 1n), "OverLimit");
  });
});

// 5 ------------------------------------------------------------------------
describe("5 who may start and close", () => {
  it("only the operator; a second start reverts EpochOpen; a close with none open reverts NoEpoch", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await expectRevert(w.vault.write.startEpoch([PLAN, 100n * USD], { account: w.stranger.account }), "NotOperator");
    await expectRevert(w.vault.write.closeEpoch([0n], { account: w.operator.account }), "NoEpoch");
    await start(w, 100n * USD);
    await expectRevert(start(w, 100n * USD), "EpochOpen");
    await expectRevert(w.vault.write.closeEpoch([100n * USD], { account: w.stranger.account }), "NotOperator");
  });
});

// 6 ------------------------------------------------------------------------
describe("6 a gain", () => {
  it("the operator keeps its share, assets and the price rise, the bond is untouched, the fee rounds down", async () => {
    const w = await setup();
    await deposit(w, w.alice, 20_000n * USD);
    await postBond(w, 6_000n * USD);
    const assetsBefore = await w.vault.read.assets();
    const priceBefore = await w.vault.read.sharePrice();

    await start(w, 7_500n * USD);
    const opPreClose = await w.balance(w.addr(w.operator));
    const h = await close(w, 7_600n * USD); // gain 100, fee = 100*2000/10000 = 20, net +80
    const ev = await w.event(h, "EpochClosed");
    assert.equal(ev.fee, 20n * USD);
    assert.equal(ev.fromBond, 0n);
    assert.equal(ev.drawn, 7_500n * USD);
    assert.equal(ev.returned, 7_600n * USD);
    // across the close the operator paid back 7,600 and was sent the 20 fee
    assert.equal(await w.balance(w.addr(w.operator)), opPreClose - 7_600n * USD + 20n * USD);
    assert.equal(await w.vault.read.assets(), assetsBefore + 80n * USD);
    assert.equal(ev.assets, assetsBefore + 80n * USD);
    assert.equal(await w.vault.read.bond(), 6_000n * USD);
    assert.ok((await w.vault.read.sharePrice()) > priceBefore);

    // a fee that does not divide rounds down: gain 9 units -> fee = 9*2000/10000 = 1 unit
    await start(w, 7_500n * USD);
    const opPreClose2 = await w.balance(w.addr(w.operator));
    const h2 = await close(w, 7_500n * USD + 9n);
    assert.equal((await w.event(h2, "EpochClosed")).fee, 1n);
    assert.equal(await w.balance(w.addr(w.operator)), opPreClose2 - (7_500n * USD + 9n) + 1n);
  });
});

// 7 ------------------------------------------------------------------------
describe("7 a loss inside the bond", () => {
  it("the bond takes it; assets and the price are as before the epoch", async () => {
    const w = await setup();
    await deposit(w, w.alice, 20_000n * USD);
    await postBond(w, 6_000n * USD);
    const assetsBefore = await w.vault.read.assets();
    const priceBefore = await w.vault.read.sharePrice();
    await start(w, 7_500n * USD);
    const h = await close(w, 7_000n * USD); // loss 500 from the bond
    assert.equal((await w.event(h, "EpochClosed")).fromBond, 500n * USD);
    assert.equal(await w.vault.read.bond(), 5_500n * USD);
    assert.equal(await w.vault.read.assets(), assetsBefore);
    assert.equal(await w.vault.read.sharePrice(), priceBefore);
  });
});

// 8 ------------------------------------------------------------------------
describe("8 a loss past the bond", () => {
  it("the bond empties and the depositors take the rest", async () => {
    const w = await setup();
    await deposit(w, w.alice, 20_000n * USD);
    await postBond(w, 5_000n * USD);
    const assetsBefore = await w.vault.read.assets();
    await start(w, 7_500n * USD); // byBond = 5000*3/2 = 7500, exactly
    const h = await close(w, 1_000n * USD); // loss 6500, bond caps it at 5000
    assert.equal((await w.event(h, "EpochClosed")).fromBond, 5_000n * USD);
    assert.equal(await w.vault.read.bond(), 0n);
    assert.equal(await w.vault.read.assets(), assetsBefore - 1_500n * USD);
    // the epoch's recorded price is always positive, even when a loss empties the bond
    const [closeAssets, closeShares] = await w.vault.read.closes([1n]);
    assert.ok(closeAssets > 0n && closeShares > 0n, "closes[e].assets and shares are positive");
  });
});

// 9 ------------------------------------------------------------------------
describe("9 a flat epoch", () => {
  it("a return of exactly what was drawn changes nothing but the epoch's number", async () => {
    const w = await setup();
    await deposit(w, w.alice, 20_000n * USD);
    await postBond(w, 6_000n * USD);
    const before = {
      assets: await w.vault.read.assets(),
      shares: await w.vault.read.totalShares(),
      price: await w.vault.read.sharePrice(),
      bond: await w.vault.read.bond(),
    };
    await start(w, 7_500n * USD);
    await close(w, 7_500n * USD);
    assert.equal(await w.vault.read.assets(), before.assets);
    assert.equal(await w.vault.read.totalShares(), before.shares);
    assert.equal(await w.vault.read.sharePrice(), before.price);
    assert.equal(await w.vault.read.bond(), before.bond);
    assert.equal(await w.vault.read.epochId(), 1n);
  });
});

// 10 -----------------------------------------------------------------------
describe("10 an asked withdrawal", () => {
  it("is paid at the end price after a gain, cannot be claimed early, and is paid once", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await start(w, 400n * USD); // assets 600
    await w.vault.write.requestWithdraw([500n * USD * VS], { account: w.alice.account }); // asked (half the shares)
    await expectRevert(w.vault.write.claim({ account: w.alice.account }), "Nothing"); // too early
    await close(w, 500n * USD); // gain 100, fee 20, record assets 1080, shares 1e15
    const before = await w.balance(w.addr(w.alice));
    // toAssets(500e6*VS, 1080e6, 1e15) = 500e6*VS*(1080e6+1)/(1e15+1e6) = 539_999_999 (just under 540)
    const paid = toAssets(500n * USD * VS, 1_080n * USD, 1_000n * USD * VS);
    assert.equal(paid, 539_999_999n);
    await w.vault.write.claim({ account: w.alice.account });
    assert.equal(await w.balance(w.addr(w.alice)), before + 539_999_999n);
    await expectRevert(w.vault.write.claim({ account: w.alice.account }), "Nothing"); // once
  });

  it("is paid at the end price after a loss past the bond", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 300n * USD);
    await start(w, 400n * USD); // byBond 450, byVault 500; assets 600
    await w.vault.write.requestWithdraw([500n * USD * VS], { account: w.alice.account });
    await close(w, 0n); // loss 400, bond caps at 300, assets 900; record assets 900, shares 1e15
    const before = await w.balance(w.addr(w.alice));
    // toAssets(500e6*VS, 900e6, 1e15) = 500e6*VS*(900e6+1)/(1e15+1e6) = 450e6 (exact)
    assert.equal(toAssets(500n * USD * VS, 900n * USD, 1_000n * USD * VS), 450n * USD);
    await w.vault.write.claim({ account: w.alice.account });
    assert.equal(await w.balance(w.addr(w.alice)), before + 450n * USD);
  });
});

// F7 (fix brief): in a losing epoch the asker takes its part of the loss, a waiting deposit none --
describe("F7 a losing epoch: the asker loses, the waiting deposit does not", () => {
  it("a loss within the bond: nobody loses, the bond does", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD); // shares 1e15
    await postBond(w, 1_000n * USD);
    await start(w, 400n * USD); // assets 600
    await w.vault.write.requestWithdraw([400n * USD * VS], { account: w.alice.account }); // asked
    await deposit(w, w.bob, 500n * USD); // waiting
    await close(w, 300n * USD); // loss 100 within bond 1000; assets += 300+100 = 400 -> record assets 1000, shares 1e15
    assert.equal(await w.vault.read.bond(), 900n * USD);
    const [ca, cs] = await w.vault.read.closes([1n]);
    assert.equal(ca, 1_000n * USD); // price back at par: the bond absorbed the loss
    assert.equal(cs, 1_000n * USD * VS);
    // the asker is made whole: toAssets(400e6*VS, 1000e6, 1e15) = 400e6 (exactly the start value)
    assert.equal((await w.vault.read.owed([w.addr(w.alice)]))[1], 400n * USD);
    // the waiting deposit mints at par and is worth its 500 in full: toShares(500e6, 1000e6, 1e15) = 500e6*VS
    assert.equal((await w.vault.read.owed([w.addr(w.bob)]))[0], 500n * USD * VS);
  });

  it("a loss beyond the bond: the asker is paid less than the start price, the waiting deposit is whole", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD); // shares 1e15
    await postBond(w, 300n * USD); // byBond 450 >= draw 400
    await start(w, 400n * USD); // assets 600
    await w.vault.write.requestWithdraw([400n * USD * VS], { account: w.alice.account }); // asked
    await deposit(w, w.bob, 500n * USD); // waiting
    await close(w, 0n); // loss 400, bond 300 fully taken; assets += 0+300 = 300 -> record assets 900, shares 1e15
    assert.equal(await w.vault.read.bond(), 0n);
    const [ca] = await w.vault.read.closes([1n]);
    assert.equal(ca, 900n * USD);
    // the asker takes the loss: toAssets(400e6*VS, 900e6, 1e15) = 400e6*VS*900_000_001/(1e15+1e6) = 360e6 < 400e6
    assert.equal((await w.vault.read.owed([w.addr(w.alice)]))[1], 360n * USD);
    assert.ok(360n * USD < 400n * USD, "asker paid less than the 400 start value");
    // the waiting deposit took none of the loss: its shares are worth its 500 in full (to the unit)
    const bobShares = (await w.vault.read.owed([w.addr(w.bob)]))[0];
    assert.equal(bobShares, 555_555_555_493_827n); // toShares(500e6, 900e6, 1e15) = 500e6*(1e15+1e6)/(900e6+1)
    // after the epoch: assets 1040e6, totalShares 1_155_555_555_493_827; bob withdraws all his shares
    // toAssets(555_555_555_493_827, 1040e6, 1_155_555_555_493_827) = 500e6 — his 500 back in full
    const bobBefore = await w.balance(w.addr(w.bob));
    await w.vault.write.requestWithdraw([bobShares], { account: w.bob.account });
    assert.equal(await w.balance(w.addr(w.bob)), bobBefore + 500n * USD);
  });
});

// 11 -----------------------------------------------------------------------
describe("11 a withdrawal with no epoch open", () => {
  it("is paid at once; more shares than held reverts NotEnough", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    const before = await w.balance(w.addr(w.alice));
    // 600*VS of alice's 1000*VS shares; at par toAssets(600e6*VS, 1000e6, 1000e6*VS) = 600e6 exactly
    const h = await w.vault.write.requestWithdraw([600n * USD * VS], { account: w.alice.account });
    const ev = await w.event(h, "Withdrawn");
    assert.equal((ev.who as string).toLowerCase(), w.addr(w.alice).toLowerCase());
    assert.equal(ev.shares, 600n * USD * VS);
    assert.equal(ev.paid, 600n * USD);
    assert.equal(await w.balance(w.addr(w.alice)), before + 600n * USD);
    assert.equal(await w.vault.read.sharesOf([w.addr(w.alice)]), 400n * USD * VS);
    await expectRevert(w.vault.write.requestWithdraw([500n * USD * VS], { account: w.alice.account }), "NotEnough");
  });
});

// 12 -----------------------------------------------------------------------
describe("12 a deposit made during an epoch", () => {
  it("takes none of the gain: it mints at the end price", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await start(w, 400n * USD); // assets 600
    await deposit(w, w.bob, 500n * USD); // waiting
    await close(w, 600n * USD); // gain 200, fee 40; record assets 1160, shares 1e15
    // bob's shares when next settled: toShares(500e6, 1160e6, 1e15) = 500e6*(1e15+1e6)/(1160e6+1)
    //   = 431_034_482_818_073
    const expected = toShares(500n * USD, 1_160n * USD, 1_000n * USD * VS);
    assert.equal(expected, 431_034_482_818_073n);
    assert.equal((await w.vault.read.owed([w.addr(w.bob)]))[0], expected); // shares after settling
    // withdrawing all of them settles bob, then pays: his 500 back less rounding — none of the gain
    const before = await w.balance(w.addr(w.bob));
    await w.vault.write.requestWithdraw([expected], { account: w.bob.account });
    const got = (await w.balance(w.addr(w.bob))) - before;
    assert.ok(got <= 500n * USD && got >= 500n * USD - 2n, `bob got ${got}`); // 499_999_999
    assert.equal(await w.vault.read.sharesOf([w.addr(w.bob)]), 0n);
  });

  it("leaves an earlier depositor's dollars what they would have been without it", async () => {
    async function alicePayout(withBob: boolean): Promise<bigint> {
      const w = await setup();
      await deposit(w, w.alice, 1_000n * USD);
      await postBond(w, 1_000n * USD);
      await start(w, 400n * USD);
      if (withBob) await deposit(w, w.bob, 500n * USD);
      await close(w, 600n * USD);
      const before = await w.balance(w.addr(w.alice));
      await w.vault.write.requestWithdraw([1_000n * USD * VS], { account: w.alice.account });
      return (await w.balance(w.addr(w.alice))) - before;
    }
    assert.equal(await alicePayout(true), await alicePayout(false));
  });
});

// 13 -----------------------------------------------------------------------
describe("13 a waiting deposit after a default", () => {
  it("comes back whole through claim() and mints no shares", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 500n * USD);
    await start(w, 400n * USD);
    await deposit(w, w.bob, 500n * USD); // waiting
    await passDeadline(w);
    await w.vault.write.declareDefault({ account: w.stranger.account });
    const before = await w.balance(w.addr(w.bob));
    await w.vault.write.claim({ account: w.bob.account });
    assert.equal(await w.balance(w.addr(w.bob)), before + 500n * USD);
    assert.equal(await w.vault.read.sharesOf([w.addr(w.bob)]), 0n);
  });
});

// 14 -----------------------------------------------------------------------
describe("14 closing around the deadline", () => {
  it("a late close, before any default, still closes (ruling 1)", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await start(w, 400n * USD);
    await passDeadline(w);
    await close(w, 400n * USD); // late but allowed
    assert.equal(await w.vault.read.open(), false);
    assert.equal(await w.vault.read.epochId(), 1n);
  });

  it("a close after a default reverts NoEpoch", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await start(w, 400n * USD);
    await passDeadline(w);
    await w.vault.write.declareDefault({ account: w.stranger.account });
    await expectRevert(close(w, 400n * USD), "NoEpoch");
  });
});

// 15 -----------------------------------------------------------------------
describe("15 declaring a default", () => {
  it("is refused before and at the deadline, passes after, moves the whole bond, and happens once", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    const assetsBefore = await w.vault.read.assets();
    await start(w, 400n * USD); // assets 600, bond 1000
    const d = await w.vault.read.deadline();
    await w.time.increaseTo(Number(d) - 1); // a call now is simulated at block.timestamp == deadline
    await expectRevert(w.vault.write.declareDefault({ account: w.stranger.account }), "NotYet"); // at the deadline
    await w.time.increaseTo(Number(d)); // a mined tx now lands one second after the deadline
    const h = await w.vault.write.declareDefault({ account: w.stranger.account }); // one second after, by a stranger
    const ev = await w.event(h, "DefaultDeclared");
    assert.equal(ev.moved, 1_000n * USD);
    assert.equal(ev.drawn, 400n * USD); // drawn is reported, not returned
    assert.equal(await w.vault.read.bond(), 0n);
    assert.equal(await w.vault.read.assets(), assetsBefore - 400n * USD + 1_000n * USD); // -draw +bond
    assert.equal(await w.vault.read.defaulted(), true);
    await expectRevert(w.vault.write.declareDefault({ account: w.stranger.account }), "NoEpoch");
  });
});

// F8 (fix brief): a default cannot be declared at the deadline, only strictly after it ----------
describe("F8 the default deadline is exclusive", () => {
  it("reverts NotYet one second before and at the deadline; passes one second after", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await start(w, 400n * USD);
    const d = Number(await w.vault.read.deadline());
    // the next simulated call runs at (last block time + 1): set it to deadline-1, then deadline
    await w.time.increaseTo(d - 2); // a call now is simulated at block.timestamp == deadline - 1
    await expectRevert(w.vault.write.declareDefault({ account: w.stranger.account }), "NotYet"); // one second before
    await w.time.increaseTo(d - 1); // a call now is simulated at block.timestamp == deadline
    await expectRevert(w.vault.write.declareDefault({ account: w.stranger.account }), "NotYet"); // exactly at
    await w.time.increaseTo(d); // a mined tx now lands one second after the deadline
    await w.vault.write.declareDefault({ account: w.stranger.account }); // one second after: passes
    assert.equal(await w.vault.read.defaulted(), true);
  });
});

// 16 -----------------------------------------------------------------------
describe("16 after a default", () => {
  it("everything that would start or fund is refused; everyone withdraws to zero; an asked withdrawal is paid at the post-bond price", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await deposit(w, w.bob, 1_000n * USD); // assets 2000, shares 2e15
    await postBond(w, 1_000n * USD);
    await start(w, 500n * USD); // assets 1500, bond 1000
    await w.vault.write.requestWithdraw([500n * USD * VS], { account: w.alice.account }); // asked, in the epoch that defaults
    await passDeadline(w);
    await w.vault.write.declareDefault({ account: w.stranger.account });
    // record (assets 2500, shares 2e15); asked out = toAssets(500e6*VS, 2500e6, 2e15) = 624_999_999
    //   -> assets 1_875_000_001, totalShares 1.5e15

    await expectRevert(start(w, 1n), "Defaulted");
    await expectRevert(deposit(w, w.carol, 1n), "Defaulted");
    await expectRevert(postBond(w, 1n), "Defaulted");
    await expectRevert(w.vault.write.withdrawBond([1n], { account: w.operator.account }), "Defaulted");

    const aliceClaim0 = await w.balance(w.addr(w.alice));
    await w.vault.write.claim({ account: w.alice.account }); // asked at the post-bond price
    assert.equal(await w.balance(w.addr(w.alice)), aliceClaim0 + 624_999_999n);

    // everyone withdraws at once; assets ends at 1 unit of dust (nobody's) and totalShares at 0
    await w.vault.write.requestWithdraw([500n * USD * VS], { account: w.alice.account }); // toAssets(500e6*VS,1_875_000_001,1.5e15)=625e6
    await w.vault.write.requestWithdraw([1_000n * USD * VS], { account: w.bob.account }); // toAssets(1000e6*VS,1_250_000_001,1e15)=1250e6
    assert.equal(await w.vault.read.assets(), 1n); // one orphan unit left by the asked rounding
    assert.equal(await w.vault.read.totalShares(), 0n);
  });
});

// 17 -----------------------------------------------------------------------
describe("17 the stage vault's arithmetic", () => {
  it("bond 100, three of 100, draw 150, default: the depositors are left with 250 between them", async () => {
    const w = await setup({ capPerMarket: 1_000n * USD, depositCap: 1_000n * USD });
    await postBond(w, 100n * USD);
    await deposit(w, w.alice, 100n * USD);
    await deposit(w, w.bob, 100n * USD);
    await deposit(w, w.carol, 100n * USD); // assets 300, shares 300
    await start(w, 150n * USD); // byBond 150, byVault 150; exactly
    await passDeadline(w);
    await w.vault.write.declareDefault({ account: w.stranger.account }); // assets 250, bond 0
    assert.equal(await w.vault.read.assets(), 250n * USD);

    let total = 0n;
    for (const who of [w.alice, w.bob, w.carol]) {
      const before = await w.balance(w.addr(who));
      await w.vault.write.requestWithdraw([100n * USD * VS], { account: who.account }); // each holds 100*VS shares
      total += (await w.balance(w.addr(who))) - before;
    }
    assert.equal(total, 250n * USD); // a third short of the 300 put in; no dust left (assets 0)
    assert.equal(await w.vault.read.assets(), 0n);
  });
});

// 18 -----------------------------------------------------------------------
describe("18 commit", () => {
  it("is the operator's alone, stores and counts the hash, and carries the epoch's number", async () => {
    const w = await setup();
    await expectRevert(w.vault.write.commit([PLAN], { account: w.stranger.account }), "NotOperator");
    const h1 = await w.vault.write.commit([PLAN], { account: w.operator.account });
    assert.deepEqual(await w.event(h1, "Committed"), { epochId: 0n, hash: PLAN, commits: 1n });
    assert.equal(await w.vault.read.head(), PLAN);
    assert.equal(await w.vault.read.commits(), 1n);

    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    await start(w, 100n * USD);
    const h2 = await w.vault.write.commit([PLAN2], { account: w.operator.account });
    assert.deepEqual(await w.event(h2, "Committed"), { epochId: 1n, hash: PLAN2, commits: 2n });
    assert.equal(await w.vault.read.head(), PLAN2);
  });
});

// 19 -----------------------------------------------------------------------
describe("19 stray USDC", () => {
  it("sent straight to the contract changes no price, no limit and no payout", async () => {
    const w = await setup();
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);
    const price = await w.vault.read.sharePrice();
    const lim = await w.vault.read.limits();
    await w.usdc.write.mint([w.vault.address, 500n * USD]); // a mistake

    assert.equal(await w.vault.read.sharePrice(), price);
    assert.deepEqual(await w.vault.read.limits(), lim);
    const before = await w.balance(w.addr(w.alice));
    await w.vault.write.requestWithdraw([1_000n * USD * VS], { account: w.alice.account }); // all 1000*VS shares, at par -> 1000
    assert.equal(await w.balance(w.addr(w.alice)), before + 1_000n * USD); // from the books, not the balance
  });
});

// 20 -----------------------------------------------------------------------
describe("20 the views", () => {
  it("against hand-worked figures before, during and after an epoch", async () => {
    const w = await setup({ depositCap: 5_000n * USD });
    await deposit(w, w.alice, 1_000n * USD);
    await postBond(w, 1_000n * USD);

    // before: empty-of-epoch, at par — sharePrice 1e18, alice holds 1000*VS shares
    assert.equal(await w.vault.read.sharePrice(), 10n ** 18n);
    assert.deepEqual(await w.vault.read.limits(), [1_500n * USD, 500n * USD, 500n * USD]);
    assert.equal(await w.vault.read.room(), 4_000n * USD);
    assert.deepEqual(await w.vault.read.epoch(), [0n, false, false, `0x${"00".repeat(32)}`, 0n, 0n]);
    assert.deepEqual(await w.vault.read.owed([w.addr(w.alice)]), [1_000n * USD * VS, 0n, 0n]);

    // during
    await start(w, 400n * USD); // assets 600, drawn 400
    await deposit(w, w.bob, 300n * USD); // waiting
    await w.vault.write.requestWithdraw([200n * USD * VS], { account: w.alice.account }); // asked (200*VS of her 1000*VS)
    // sharePrice = ((assets+1)*1e18*VS)/(totalShares+VS), assets 600, totalShares still 1e15 (asked shares stay)
    assert.equal(await w.vault.read.sharePrice(), ((600n * USD + 1n) * 10n ** 18n * VS) / (1_000n * USD * VS + VS));
    assert.deepEqual(await w.vault.read.limits(), [1_500n * USD, 300n * USD, 300n * USD]);
    assert.equal(await w.vault.read.room(), 3_700n * USD); // cap - assets(600) - waiting(300) - drawn(400)
    const ep = await w.vault.read.epoch();
    assert.equal(ep[0], 1n);
    assert.equal(ep[1], true);
    assert.equal(ep[3], PLAN);
    assert.equal(ep[4], 400n * USD);
    assert.deepEqual(await w.vault.read.owed([w.addr(w.alice)]), [800n * USD * VS, 0n, 0n]);
    assert.deepEqual(await w.vault.read.owed([w.addr(w.bob)]), [0n, 0n, 300n * USD]);

    // after a gain close: record (assets 1080, shares 1e15).
    //   asked out  = toAssets(200e6*VS, 1080e6, 1e15) = 200e6*VS*(1080e6+1)/(1e15+1e6) = 215_999_999
    //   waiting mint = toShares(300e6, 1080e6, 1e15) = 300e6*(1e15+1e6)/(1080e6+1) = 277_777_777_798_353
    //   assets = (1080e6 - 215_999_999) + 300e6 = 1_164_000_001; totalShares = (1e15-200e6*VS)+mint
    await close(w, 500n * USD);
    assert.equal(await w.vault.read.assets(), 1_164_000_001n);
    assert.equal(await w.vault.read.totalShares(), 800n * USD * VS + 277_777_777_798_353n);
    assert.equal(await w.vault.read.setAside(), 215_999_999n);
    assert.equal(
      await w.vault.read.sharePrice(),
      ((1_164_000_001n + 1n) * 10n ** 18n * VS) / (800n * USD * VS + 277_777_777_798_353n + VS),
    );
    assert.deepEqual(await w.vault.read.limits(), [1_500n * USD, 582n * USD, 582n * USD]); // 1_164_000_001*5000/10000 = 582e6
    assert.equal(await w.vault.read.room(), 3_835_999_999n); // cap - assets(1_164_000_001)
    assert.deepEqual(await w.vault.read.owed([w.addr(w.alice)]), [800n * USD * VS, 215_999_999n, 0n]);
    assert.deepEqual(await w.vault.read.owed([w.addr(w.bob)]), [277_777_777_798_353n, 0n, 0n]);
  });
});

// 21 -----------------------------------------------------------------------
// NOTE (fix brief F9, resolved): this isolates the nonReentrant guard, not only the order of
// effects. The hostile token keeps the reason of the re-entered call (`lastReason`), and the test
// asserts it is OpenZeppelin's ReentrancyGuardReentrantCall() (selector 0x3ee5aeb5) — the guard's
// own error. CEI alone would make the inner call revert with the vault's Nothing() instead, so with
// `nonReentrant` removed this assertion fails (verified in a scratch copy; see the fix-1 report).
describe("21 reentrancy", () => {
  it("a token whose transfer calls back into claim cannot be paid twice", async () => {
    const { viem } = await setup();
    const token = await viem.deployContract("ReentrantUSDC");
    const wallets = await viem.getWalletClients();
    const [operator] = wallets;
    const vault = await viem.deployContract("BondedVault", [
      token.address,
      operator.account.address,
      3,
      5000,
      2000,
      60,
      1_000n * USD,
      1_000_000n * USD,
    ]);
    await token.write.setVault([vault.address]);

    // the operator funds the bond; the token itself is the depositor
    await token.write.mint([operator.account.address, 1_000n * USD]);
    await token.write.approve([vault.address, 1_000n * USD], { account: operator.account });
    await vault.write.postBond([1_000n * USD], { account: operator.account });

    await token.write.mint([token.address, 1_000n * USD]);
    await token.write.doDeposit([1_000n * USD]); // token holds 1000*VS shares, assets 1000
    await vault.write.startEpoch([PLAN, 400n * USD], { account: operator.account });
    await token.write.doRequest([500n * USD * VS]); // asked (half the shares)
    await token.write.mint([operator.account.address, 500n * USD]);
    await token.write.approve([vault.address, 500n * USD], { account: operator.account });
    await vault.write.closeEpoch([500n * USD], { account: operator.account }); // gain; record (1080, 1e15)

    await token.write.arm([true]);
    // toAssets(500e6*VS, 1080e6, 1e15) = 539_999_999; the re-entrant claim is refused, so paid once
    await token.write.doClaim();
    assert.equal(await token.read.balanceOf([token.address]), 539_999_999n);
    assert.ok((await token.read.reentries()) >= 1n, "the token did re-enter");
    // The guard itself refused the call back: the reason the token caught is OpenZeppelin's
    // ReentrancyGuardReentrantCall() (selector 0x3ee5aeb5). With the guard taken off `claim`, the
    // reason is the vault's own Nothing() instead, and this line fails.
    assert.equal(await token.read.lastReason(), "0x3ee5aeb5");
    await expectRevert(token.write.doClaim(), "Nothing"); // nothing left to pay
  });
});

// ===== fix brief 2: no conversion can overflow, and the price floor ==============================
// MAX_SHARES_PER_UNIT in the contract: the most share units one USDC unit may buy when an epoch
// starts. A start needs (totalShares + VS) <= RATIO_CAP * (assets + 1).
const RATIO_CAP = 10n ** 18n;

/** Why a write failed, as the custom-error name or panic code (for the tests that expect a revert). */
async function why(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "succeeded";
  } catch (e) {
    const s = e instanceof Error ? e.message : String(e);
    const m = s.match(/[A-Z][A-Za-z]+\(\)|panic code 0x[0-9a-f]+[^\n]*/);
    return m ? m[0] : s.slice(0, 160);
  }
}

// Drive the price down (share units per USDC unit up) with self-funded losing epochs. `holder` keeps
// the eroding shares; the operator funds the bond and returns nothing, so the loss beyond the bond
// falls on assets and the ratio r = (totalShares + VS)/(assets + 1) climbs. Assets are topped back
// up to `topupTo` (a mint to `holder` at the current low price — it does not change r) whenever they
// fall too low to draw. Stops once the model r first passes `targetR`, or after `maxEpochs`. The
// bond is the minimum the draw needs, so the loss hits assets. Returns the number of epochs run.
async function compound(
  w: World,
  holder: World["alice"],
  opts: { topupTo: bigint; drawBps: bigint; halves: bigint; targetR: bigint; maxEpochs: number },
): Promise<number> {
  const v = w.vault;
  const op = w.operator.account;
  let epochs = 0;
  for (; epochs < opts.maxEpochs; epochs++) {
    let a = await v.read.assets();
    if (a < opts.topupTo / 16n) {
      await v.write.deposit([opts.topupTo - a], { account: holder.account });
      a = await v.read.assets();
    }
    const s = await v.read.totalShares();
    if (s + VS > opts.targetR * (a + 1n)) break;
    const d = (a * opts.drawBps) / 10000n;
    if (d === 0n) break;
    const b = (2n * d + opts.halves - 1n) / opts.halves; // bond >= draw * 2 / halves (ceil)
    await v.write.postBond([b], { account: op });
    await v.write.startEpoch([PLAN, d], { account: op });
    await v.write.closeEpoch([0n], { account: op }); // return nothing: bond first, then assets
  }
  return epochs;
}

// G1 (fix brief 2): compounded losses cannot lock the vault — proof A, on the STAGE settings.
describe("G1 compounded losses cannot lock the vault", () => {
  it("STAGE: the self-loss loop is stopped by PriceTooLow, then a $100k round-trip is within 1 unit", async () => {
    const w = await setup(); // STAGE: halves 3, 5000 bps, cap 1,000,000 USD
    const v = w.vault;
    const op = w.operator.account;
    const TOP = 500_000n * USD; // top assets back up to this — leaves room under the 1,000,000 cap
    await v.write.deposit([TOP], { account: op }); // the operator is its own depositor, as in proof A
    let epochs = 0;
    let stop = "";
    for (let i = 0; i < 4000; i++) {
      const a = await v.read.assets();
      if (a < USD) await v.write.deposit([TOP - a], { account: op });
      const A = await v.read.assets();
      const d = (A * 5000n) / 10000n;
      const b = (2n * d + 2n) / 3n; // halves 3: bond >= 2d/3
      await v.write.postBond([b], { account: op });
      stop = await why(v.write.startEpoch([PLAN, d], { account: op }));
      if (stop !== "succeeded") break;
      await v.write.closeEpoch([0n], { account: op }); // lose all of it
      epochs++;
    }
    assert.ok(stop.includes("PriceTooLow"), `the loop must stop with PriceTooLow, got: ${stop}`);
    const [a, s] = await Promise.all([v.read.assets(), v.read.totalShares()]);
    // at the stop the close-time ratio bound still holds with room to spare
    assert.ok(s + VS <= 10n ** 22n * (a + 1n), `ratio ${s + VS} over 1e22*(a+1) ${10n ** 22n * (a + 1n)}`);
    assert.equal(await v.read.open(), false);

    // a real depositor puts in 100,000 dollars with no epoch open and takes it all back at once
    const bob0 = await w.balance(w.addr(w.bob));
    await v.write.deposit([100_000n * USD], { account: w.bob.account });
    const bobShares = await v.read.sharesOf([w.addr(w.bob)]);
    assert.ok(bobShares > 0n, "bob credited shares");
    await v.write.requestWithdraw([bobShares], { account: w.bob.account });
    const bobLoss = bob0 - (await w.balance(w.addr(w.bob)));
    assert.ok(bobLoss >= 0n && bobLoss <= 1n, `the round-trip loss ${bobLoss} must be within 1 unit`);
    // eslint-disable-next-line no-console
    console.log(`G1: stopped after ${epochs} epochs; assets ${a}, totalShares ${s}, bob round-trip loss ${bobLoss}`);
  });
});

// G2 (fix brief 2): the worst epoch inside the floor still closes.
describe("G2 the worst epoch inside the floor still closes", () => {
  it("at the last start that passes, a max waiting deposit and a full ask still close with nothing returned", async () => {
    const CAP = 2n ** 96n - 1n;
    const w = await setup({ depositCap: CAP, drawVaultBps: 9999, drawBondHalves: 4 });
    const v = w.vault;
    const op = w.operator.account;
    // fund the waiting depositor so it can deposit near the (2^96 - 1) cap
    const HUGE = 2n ** 96n;
    await w.usdc.write.mint([w.addr(w.bob), HUGE]);
    await w.usdc.write.approve([v.address, HUGE], { account: w.bob.account });

    // compound alice's shares down to a high price, stopping safely under the 1e18 floor
    const eps = await compound(w, w.alice, { topupTo: 1_000n * USD, drawBps: 9999n, halves: 4n, targetR: 4n * 10n ** 17n, maxEpochs: 400 });
    const a0 = await v.read.assets();
    const s0 = await v.read.totalShares();
    assert.ok(s0 + VS <= RATIO_CAP * (a0 + 1n), "still within the floor: a start passes");

    // the last start that passes: max draw, minimum bond so the eventual loss hits assets
    const draw = (a0 * 9999n) / 10000n;
    await v.write.postBond([(draw + 1n) / 2n], { account: op }); // halves 4: bond >= draw/2
    const [, , maxDraw] = await v.read.limits();
    await v.write.startEpoch([PLAN, maxDraw], { account: op });
    const eid = await v.read.epochId(); // the stress epoch's id

    // the largest deposit the cap allows waits
    const room = await v.read.room();
    assert.ok(room > 0n, "there is room to deposit");
    await v.write.deposit([room], { account: w.bob.account });
    // another holder (alice) asks all her shares out
    const aliceShares = await v.read.sharesOf([w.addr(w.alice)]);
    await v.write.requestWithdraw([aliceShares], { account: w.alice.account });

    // the operator returns nothing: closeEpoch(0) must still succeed
    const r = await why(v.write.closeEpoch([0n], { account: op }));
    assert.equal(r, "succeeded", `closeEpoch(0) must succeed, got: ${r}`);
    const [cA, cS] = await v.read.closes([eid]);

    // the waiting depositor is credited shares and can take their money back within the rounding
    const bobShares = (await v.read.owed([w.addr(w.bob)]))[0];
    assert.ok(bobShares > 0n, "the waiting depositor is credited shares");
    const bob0 = await w.balance(w.addr(w.bob));
    await v.write.requestWithdraw([bobShares], { account: w.bob.account });
    const bobLoss = room - ((await w.balance(w.addr(w.bob))) - bob0);
    // round-trip loss <= one share unit's price at the waiting mint (ceil) + one unit for the withdraw floor
    const bound = (cA + 1n + (cS + VS) - 1n) / (cS + VS) + 1n;
    assert.ok(bobLoss >= 0n && bobLoss <= bound, `bob loss ${bobLoss} over the stated bound ${bound}`);

    // the asker's claim pays
    const aOut = (await v.read.owed([w.addr(w.alice)]))[1];
    assert.ok(aOut > 0n, "the asker is owed a claim");
    const aBal0 = await w.balance(w.addr(w.alice));
    await v.write.claim({ account: w.alice.account });
    assert.equal(await w.balance(w.addr(w.alice)), aBal0 + aOut, "the asker's claim pays");
    // eslint-disable-next-line no-console
    console.log(`G2: ${eps} compound epochs; close assets ${cA}, shares ${cS}; room ${room}, bob loss ${bobLoss} (bound ${bound})`);
  });
});

// G3 (fix brief 2): the same, defaulted — the waiting deposit comes back whole.
describe("G3 the worst epoch inside the floor still defaults", () => {
  it("at the last start that passes, the deadline passes and a stranger defaults; the waiting deposit is whole", async () => {
    const CAP = 2n ** 96n - 1n;
    const w = await setup({ depositCap: CAP, drawVaultBps: 9999, drawBondHalves: 4 });
    const v = w.vault;
    const op = w.operator.account;
    const HUGE = 2n ** 96n;
    await w.usdc.write.mint([w.addr(w.bob), HUGE]);
    await w.usdc.write.approve([v.address, HUGE], { account: w.bob.account });

    const eps = await compound(w, w.alice, { topupTo: 1_000n * USD, drawBps: 9999n, halves: 4n, targetR: 4n * 10n ** 17n, maxEpochs: 400 });
    const a0 = await v.read.assets();
    const s0 = await v.read.totalShares();
    assert.ok(s0 + VS <= RATIO_CAP * (a0 + 1n), "still within the floor: a start passes");

    const draw = (a0 * 9999n) / 10000n;
    await v.write.postBond([(draw + 1n) / 2n], { account: op });
    const [, , maxDraw] = await v.read.limits();
    await v.write.startEpoch([PLAN, maxDraw], { account: op });

    const room = await v.read.room();
    await v.write.deposit([room], { account: w.bob.account });
    const aliceShares = await v.read.sharesOf([w.addr(w.alice)]);
    await v.write.requestWithdraw([aliceShares], { account: w.alice.account });

    // the deadline passes and a stranger declares the default: it must succeed
    await passDeadline(w);
    const r = await why(v.write.declareDefault({ account: w.stranger.account }));
    assert.equal(r, "succeeded", `declareDefault must succeed, got: ${r}`);

    // the waiting deposit comes back whole through claim()
    const bob0 = await w.balance(w.addr(w.bob));
    await v.write.claim({ account: w.bob.account });
    assert.equal(await w.balance(w.addr(w.bob)), bob0 + room, "the waiting deposit comes back whole");
    assert.equal(await v.read.sharesOf([w.addr(w.bob)]), 0n, "and mints no shares");

    // the asker's claim still pays
    const aOut = (await v.read.owed([w.addr(w.alice)]))[1];
    assert.ok(aOut > 0n, "the asker is owed a claim");
    const aBal0 = await w.balance(w.addr(w.alice));
    await v.write.claim({ account: w.alice.account });
    assert.equal(await w.balance(w.addr(w.alice)), aBal0 + aOut, "the asker's claim pays");
    // eslint-disable-next-line no-console
    console.log(`G3: ${eps} compound epochs; room ${room} returned whole to the waiting depositor`);
  });
});

// G4 (fix brief 2): the deposit cap setting is bounded by 2^96.
describe("G4 the deposit cap setting is bounded", () => {
  it("a depositCap of 2^96 reverts BadSetting; 2^96 - 1 deploys", async () => {
    const w = await setup();
    const base = (cap: bigint) =>
      [w.usdc.address, w.operator.account.address, 3, 5000, 2000, 60, STAGE.capPerMarket, cap] as const;
    await expectRevert(w.viem.deployContract("BondedVault", base(2n ** 96n) as never), "BadSetting");
    await w.viem.deployContract("BondedVault", base(2n ** 96n - 1n) as never); // one below deploys
  });
});

// G5 (fix brief 2): what a newcomer can lose is bounded by one share unit's price at its close.
describe("G5 a newcomer's loss is bounded", () => {
  it("a 1,000,000-dollar pumped gain before the victim settles costs the victim at most one share unit's price", async () => {
    const w = await setup();
    const v = w.vault;
    const op = w.operator.account;
    const victim0 = await w.balance(w.addr(w.bob));
    await v.write.postBond([1n * USD], { account: op });
    await v.write.deposit([2n], { account: w.alice.account }); // minted 2*VS, assets 2
    await start(w, 1n); // assets 1, totalShares 2*VS = 2_000_000
    await v.write.deposit([1_000n * USD], { account: w.bob.account }); // the victim waits (1e9 units)
    // 1 undrawn unit stays in assets; gain 1e12, fee = 1e12*2000/10000 = 2e11;
    // record assets = 1 + (drawn 1 + gain 1e12 - fee 2e11) = 800_000_000_002
    await close(w, 1n + 1_000_000n * USD);
    const [cA, cS] = await v.read.closes([1n]);
    assert.equal(cA, 800_000_000_002n);
    assert.equal(cS, 2n * VS);
    // the waiting mint: toShares(1e9, 8e11+2, 2e6) = 1e9*(2e6+1e6)/(8e11+3) = 3e15/800000000003 = 3749
    const bobShares = (await v.read.owed([w.addr(w.bob)]))[0];
    assert.equal(bobShares, 3749n);

    await v.write.requestWithdraw([bobShares], { account: w.bob.account }); // take it all back at once
    const victimLoss = victim0 - (await w.balance(w.addr(w.bob)));
    // the bound: one share unit's price at the close, (closeAssets + 1)/(closeShares + VS) rounded up
    //   = ceil((800_000_000_002 + 1)/(2_000_000 + 1_000_000)) = ceil(800_000_000_003/3_000_000) = 266_667
    const oneUnitPrice = (cA + 1n + (cS + VS) - 1n) / (cS + VS);
    assert.equal(oneUnitPrice, 266_667n);
    assert.ok(victimLoss <= oneUnitPrice, `victim loss ${victimLoss} exceeds one share unit price ${oneUnitPrice}`);
    // eslint-disable-next-line no-console
    console.log(`G5: victim put in ${1_000n * USD}, lost ${victimLoss}, bound ${oneUnitPrice}`);
  });
});

// G6 (audit round 3, R3-2): the floor is exact. G2 and G3 stop short of it, so a floor that was one
// off (`>=` for `>`), ten times looser, or written without the virtual terms passed every test.
// This one lands on the floor to the unit: totalShares + VS == 1e18 * (assets + 1).
describe("G6 the floor is exact", () => {
  it("a start at exactly the floor passes, the worst epoch from there closes, the next start is refused, and the emptied vault starts again", async () => {
    const CAP = 2n ** 96n - 1n;
    const w = await setup({ depositCap: CAP, drawVaultBps: 9999, drawBondHalves: 4 });
    const v = w.vault;
    const op = w.operator.account;
    const MAX = 2n ** 256n - 1n;
    for (const [who, amount] of [[w.alice, 10n ** 16n], [w.operator, 10n ** 16n], [w.bob, 2n ** 97n]] as const) {
      await w.usdc.write.mint([w.addr(who), amount]);
      await w.usdc.write.approve([v.address, MAX], { account: who.account });
    }

    // alice's deposit makes totalShares + VS = 1e21 = 1e18 * 1000: on the floor when assets are 999
    await v.write.deposit([10n ** 15n - 1n], { account: w.alice.account });
    // losing epochs (the most draw, the least bond) until assets are exactly 999; the last one
    // returns just enough to land there
    let epochs = 0;
    while ((await v.read.assets()) > 999n) {
      const A = await v.read.assets();
      const d = (A * 9999n) / 10000n;
      const need = (d + 1n) / 2n; // halves 4: the bond is at least half the draw
      const had = await v.read.bond();
      if (had < need) await v.write.postBond([need - had], { account: op });
      const b = await v.read.bond();
      await v.write.startEpoch([PLAN, d], { account: op });
      const left = A - d + (b < d ? b : d); // what a close with nothing back would leave
      await v.write.closeEpoch([left >= 999n ? 0n : 999n - left], { account: op });
      epochs++;
      assert.ok(epochs < 200, "the loop ends");
    }
    const a0 = await v.read.assets();
    const s0 = await v.read.totalShares();
    assert.equal(a0, 999n);
    assert.equal(s0 + VS, RATIO_CAP * (a0 + 1n), "exactly on the floor");

    // the worst epoch from the floor: the most draw, the least bond, all the room deposited and
    // waiting, every share asked out, nothing returned
    const draw = (a0 * 9999n) / 10000n;
    const had = await v.read.bond();
    if (had < (draw + 1n) / 2n) await v.write.postBond([(draw + 1n) / 2n - had], { account: op });
    assert.equal(await why(v.write.startEpoch([PLAN, draw], { account: op })), "succeeded", "a start at exactly the floor passes");
    const room = await v.read.room();
    await v.write.deposit([room], { account: w.bob.account });
    await v.write.requestWithdraw([await v.read.sharesOf([w.addr(w.alice)])], { account: w.alice.account });
    assert.equal(await why(v.write.closeEpoch([0n], { account: op })), "succeeded", "the worst epoch from the floor closes");
    const [ca, cs] = await v.read.closes([await v.read.epochId()]);
    // the bond is at least half of any draw, so a close leaves at least half the assets: a unit buys
    // at most twice what it bought at the start (the contract's own bound, 1e22, is far looser)
    assert.ok(cs + VS <= 2n * RATIO_CAP * (ca + 1n), `at the close a unit buys ${(cs + VS) / (ca + 1n)} share units`);

    // under the floor now: no start, whatever the bond
    await v.write.postBond([1_000n], { account: op });
    const refused = await why(v.write.startEpoch([PLAN, 1n], { account: op }));
    assert.ok(refused.includes("PriceTooLow"), `a start under the floor must be refused, got: ${refused}`);

    // everyone leaves in full: the waiting deposit (settled at the close), the ask, the bond
    const bob0 = await w.balance(w.addr(w.bob));
    await v.write.requestWithdraw([(await v.read.owed([w.addr(w.bob)]))[0]], { account: w.bob.account });
    const bobLoss = room - ((await w.balance(w.addr(w.bob))) - bob0);
    assert.ok(bobLoss >= 0n && bobLoss <= 2n, `the waiting deposit comes back within rounding, lost ${bobLoss}`);
    await v.write.claim({ account: w.alice.account });
    await v.write.withdrawBond([await v.read.bond()], { account: op });
    assert.equal(await v.read.setAside(), 0n);
    assert.ok((await v.read.assets()) <= 2n, "nothing but dust is left");

    // the refusal ends when the holders are out: a new deposit and a start pass
    await v.write.deposit([1_000n * USD], { account: w.carol.account });
    await v.write.postBond([100n * USD], { account: op });
    assert.equal(await why(v.write.startEpoch([PLAN, 10n * USD], { account: op })), "succeeded", "emptied, the vault takes an epoch again");
    // eslint-disable-next-line no-console
    console.log(`G6: ${epochs} losing epochs to the floor; close assets ${ca}, a unit bought ${(cs + VS) / (ca + 1n)} share units; room ${room}; waiting deposit lost ${bobLoss}`);
  });
});
