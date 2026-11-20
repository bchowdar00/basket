// Every value in this file is invented. None is a reading of any market or of any chain.
import { expect, test } from "vitest";

import { depositorsResult, joinRounds, pctOf, type RoundLog } from "./rounds.ts";

const TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const started = (id: bigint, draw: bigint, deadline: bigint, assetsLeft: bigint): RoundLog => ({ eventName: "EpochStarted", args: { epochId: id, plan: "0x" + "11".repeat(32), draw, deadline, bond: 3_000_000n, assets: assetsLeft }, transactionHash: TX });
const closed = (id: bigint, returned: bigint, fee: bigint, fromBond: bigint): RoundLog => ({ eventName: "EpochClosed", args: { epochId: id, drawn: 0n, returned, fee, fromBond, assets: 0n, totalShares: 0n }, transactionHash: TX });

test("rounds come newest first, with the start time worked back from the deadline and the assets from before the draw", () => {
  const r = joinRounds([started(4n, 500_000n, 1_300n, 500_000n), closed(4n, 510_000n, 2_000n, 0n), started(5n, 600_000n, 1_900n, 608_000n)], 300n);
  expect(r.map((x) => x.id)).toEqual([5n, 4n]);
  expect(r[1].startedAt).toBe(1_000n);
  expect(r[1].assetsAtStart).toBe(1_000_000n);
  expect(r[0].end).toBe(null);
});

test("the round length may come as a number, as the chain reader hands a uint32 back", () => {
  expect(joinRounds([started(4n, 500_000n, 1_300n, 500_000n)], 300)[0].startedAt).toBe(1_000n);
});

test("a gain reaches depositors less the operator's fee; a loss reaches them only past the bond", () => {
  const [gain] = joinRounds([started(1n, 500_000n, 300n, 500_000n), closed(1n, 510_000n, 2_000n, 0n)], 300n);
  expect(depositorsResult(gain)).toBe(8_000n);
  expect(pctOf(8_000n, gain.assetsAtStart)).toBe("+0.80%");
  const [covered] = joinRounds([started(1n, 500_000n, 300n, 500_000n), closed(1n, 400_000n, 0n, 100_000n)], 300n);
  expect(depositorsResult(covered)).toBe(0n);
  const [past] = joinRounds([started(1n, 500_000n, 300n, 500_000n), closed(1n, 100_000n, 0n, 300_000n)], 300n);
  expect(depositorsResult(past)).toBe(-100_000n);
  expect(pctOf(-100_000n, past.assetsAtStart)).toBe("−10.00%");
});

test("a default ends its round; an end whose start was not read is left out", () => {
  const def: RoundLog = { eventName: "DefaultDeclared", args: { epochId: 2n, by: "0x0", drawn: 500_000n, moved: 3_000_000n, assets: 0n, totalShares: 0n }, transactionHash: TX };
  const r = joinRounds([closed(1n, 1n, 0n, 0n), started(2n, 500_000n, 300n, 500_000n), def], 300n);
  expect(r.length).toBe(1);
  expect(r[0].end).toEqual({ kind: "default", moved: 3_000_000n, tx: TX });
  expect(depositorsResult(r[0])).toBe(null);
});
