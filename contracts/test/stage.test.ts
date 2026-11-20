// Every value in this file is invented. None is a reading of any market.
// The operator tool, run against the local Hardhat chain with the shared helpers. It posts a bond,
// opens a round with a draw, and closes it or lets it pass its deadline — the demo round, end to end.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type Hex } from "viem";

import { setup, USD, type World } from "./helpers.ts";
import { parseSteps, runSteps, resolveVault } from "../scripts/stage.ts";

/** Runs a step text with a given key, collecting the one-line objects the tool logs. */
async function drive(w: World, wallet: World["operator"], text: string, sleep?: (s: number) => Promise<void>) {
  const lines: Record<string, unknown>[] = [];
  await runSteps({
    reader: w.publicClient,
    wallet,
    vault: w.vault,
    usdc: w.usdc,
    steps: parseSteps(text),
    sleep: sleep ?? (async () => {}),
    log: (o) => lines.push(o as Record<string, unknown>),
  });
  return lines;
}

describe("parseSteps", () => {
  it("accepts the example text", () => {
    const steps = parseSteps("bond:3000000;open:1000000;wait:40;close:1050000;unbond:500000");
    assert.deepEqual(steps.map((s) => s.kind), ["bond", "open", "wait", "close", "unbond"]);
    assert.deepEqual(
      steps.map((s) => ("units" in s ? s.units : "draw" in s ? s.draw : "seconds" in s ? s.seconds : "value" in s ? s.value : null)),
      [3_000_000n, 1_000_000n, 40, 1_050_000n, 500_000n],
    );
  });

  it("accepts open:max and close:+bps / close:-bps", () => {
    const steps = parseSteps("open:max;close:+500;close:-250");
    assert.equal(steps[0].kind === "open" && steps[0].draw, "max");
    assert.equal(steps[1].kind === "close" && steps[1].mode, "plus");
    assert.equal(steps[2].kind === "close" && steps[2].mode, "minus");
  });

  it("rejects each kind of bad input, naming the bad step", () => {
    const bad: [string, RegExp][] = [
      ["jump:5", /jump:5/], // unknown kind
      ["bond:", /bond:/], // no amount
      ["bond:3.5", /bond:3\.5/], // not whole
      ["bond:0", /bond:0/], // not above zero
      ["bond:-5", /bond:-5/], // negative
      ["wait:0", /wait:0/], // below 1
      ["wait:601", /wait:601/], // above 600
      ["wait:x", /wait:x/], // not a number
      ["open:maxx", /open:maxx/], // not a draw nor max
      ["open:0", /open:0/], // not above zero
      ["close:+", /close:\+/], // no bps
      ["close:-20000", /close:-20000/], // would return below zero
      ["bond:3000000;;open:1000000", /empty/i], // an empty step
    ];
    for (const [text, re] of bad) assert.throws(() => parseSteps(text), re);
    assert.throws(() => parseSteps(Array(13).fill("wait:1").join(";")), /12|too many/i);
  });
});

describe("runSteps on the local chain", () => {
  it("bond, a depositor's deposit, open:max, close:+500 closes the epoch, pays the fee and lifts assets", async () => {
    const w = await setup();
    await w.vault.write.deposit([100n * USD], { account: w.alice.account }); // assets 100_000_000
    const before = await w.vault.read.assets();
    const lines = await drive(w, w.operator, "bond:3000000;open:max;close:+500");

    const ep = await w.vault.read.epoch();
    assert.equal(ep[1], false, "epoch is closed");
    assert.equal(ep[2], false, "not defaulted");
    const after = await w.vault.read.assets();
    assert.ok(after > before, "assets up");
    assert.equal(after, 100_180_000n); // 100e6 - 4.5e6 draw + (4.5e6 + 225_000 gain - 45_000 fee)

    const closeLine = lines.find((l) => String(l.step).startsWith("close"));
    assert.ok(closeLine?.tx, "the close step logged its tx");
    const closed = await w.event(closeLine.tx as Hex, "EpochClosed");
    assert.equal(closed.drawn, 4_500_000n); // maxDraw = min(bond*3/2 = 4.5e6, assets*5000/10000 = 50e6)
    assert.equal(closed.fee, 45_000n); // gain 225_000 * 2000bps
  });

  it("bond, deposit, open and no close, then a default by a stranger after the deadline moves the whole bond", async () => {
    const w = await setup();
    await w.vault.write.deposit([100n * USD], { account: w.alice.account });
    await drive(w, w.operator, "bond:3000000;open:4000000");
    assert.equal(await w.vault.read.assets(), 96_000_000n); // 100e6 - 4e6 drawn
    assert.equal(await w.vault.read.bond(), 3_000_000n);

    const deadline = await w.vault.read.deadline();
    await w.time.increaseTo(Number(deadline) + 1);
    const tx = await w.vault.write.declareDefault({ account: w.stranger.account });
    const ev = await w.event(tx, "DefaultDeclared");
    assert.equal(ev.moved, 3_000_000n); // the whole bond
    assert.equal(await w.vault.read.bond(), 0n);
    assert.equal(await w.vault.read.assets(), 99_000_000n); // 96e6 + the 3e6 bond
    assert.equal(await w.vault.read.defaulted(), true);
  });

  it("open over the limit stops the run with OverLimit and sends nothing after it", async () => {
    const w = await setup();
    await w.vault.write.deposit([100n * USD], { account: w.alice.account });
    // maxDraw = min(3e6*3/2 = 4.5e6, 100e6*5000/10000 = 50e6) = 4.5e6; 5e6 is over the bond limit
    await assert.rejects(drive(w, w.operator, "bond:3000000;open:5000000;unbond:1000000"), /OverLimit/);
    assert.equal(await w.vault.read.bond(), 3_000_000n, "bond posted, but the unbond after the failed open did not run");
    assert.equal((await w.vault.read.epoch())[1], false, "no epoch ever opened");
  });

  it("with a floor, no round opens while the operator holds less than it, and one opens when it holds more", async () => {
    const w = await setup();
    await w.vault.write.deposit([100n * USD], { account: w.alice.account });
    await drive(w, w.operator, "bond:3000000");
    const held = (await w.usdc.read.balanceOf([w.operator.account.address])) as bigint;
    const run = (floor: bigint) =>
      runSteps({ reader: w.publicClient, wallet: w.operator, vault: w.vault, usdc: w.usdc, steps: parseSteps("open:1000000"), floor, sleep: async () => {}, log: () => {} });
    await assert.rejects(run(held + 1n), /open refused/);
    assert.equal((await w.vault.read.epoch())[1], false, "nothing was opened under the floor");
    await run(held);
    assert.equal((await w.vault.read.epoch())[1], true);
  });
});

describe("resolveVault refusals (before anything is sent)", () => {
  it("refuses a key that is not the vault's operator", async () => {
    const w = await setup();
    const chainId = await w.publicClient.getChainId();
    const record = { "k": { name: "stage", chainId, vault: w.vault.address, usdc: w.usdc.address } };
    await assert.rejects(
      resolveVault({ reader: w.publicClient, record, chainId, name: "stage", usdc: w.usdc.address, keyAddress: w.stranger.account.address }),
      /operator/,
    );
    const got = await resolveVault({ reader: w.publicClient, record, chainId, name: "stage", usdc: w.usdc.address, keyAddress: w.operator.account.address });
    assert.equal(got.vault.toLowerCase(), w.vault.address.toLowerCase());
  });

  it("refuses a name that does not start with stage, a missing entry, and a usdc mismatch", async () => {
    const w = await setup();
    const chainId = await w.publicClient.getChainId();
    const record = { "k": { name: "stage", chainId, vault: w.vault.address, usdc: w.usdc.address } };
    await assert.rejects(resolveVault({ reader: w.publicClient, record, chainId, name: "vault", usdc: w.usdc.address, keyAddress: w.operator.account.address }), /stage/);
    await assert.rejects(resolveVault({ reader: w.publicClient, record, chainId, name: "stage2", usdc: w.usdc.address, keyAddress: w.operator.account.address }), /no vault/);
    await assert.rejects(resolveVault({ reader: w.publicClient, record, chainId, name: "stage", usdc: "0x00000000000000000000000000000000000000aa", keyAddress: w.operator.account.address }), /usdc/i);
  });
});
