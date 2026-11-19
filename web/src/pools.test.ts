// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { poolCount } from "@app/ledger";
import { S, T0, ev, passAt, pools, row } from "./fixtures.ts";
import { screenOf, type ScreenIn } from "./pools.ts";

const HOUR = 3_600_000;

// Pool 1: two events, both 20 wide: nobody can be qualifying. Pool 2: one narrow event (may).
// Pool 3: one event in play. Pool 9: a crypto pool with no event on the Sports list.
function input(over: Partial<ScreenIn> = {}): ScreenIn {
  return {
    settings: S,
    pools: pools([
      row("A", 1, 2), row("B", 1, 2, { makers: 2 }),
      row("C", 2, 1, { poolMicrosADay: 100_000_000 }),
      row("D", 3, 1, { poolMicrosADay: 50_000_000 }),
      row("X", 9, 1, { category: "Bitcoin", poolMicrosADay: 1_000_000_000 }),
    ]),
    events: [ev("A", [[40, 60]]), ev("B", [[30, 50], [10, 90]]), ev("C", [[48, 52]]), ev("D", [[40, 60]], { live: true }), ev("Z", [[40, 60]])],
    eventsAtMs: T0 - 90_000,
    passes: [],
    ...over,
  };
}

test("each sport pool's state is the whole-pool test over its listed events, the same count the ledger keeps", () => {
  const sc = screenOf(input(), T0);
  const by = Object.fromEntries(sc.sport.map((p) => [p.key, p]));
  expect(Object.keys(by).sort()).toEqual(["id:1", "id:2", "id:3", "id:9"]) // id:9 has no event read: known from the reward list alone, shown last; // the crypto pool has no listed event, so it is not a sport pool
  expect(by["id:1"].count.state).toBe("none-prices");
  expect(by["id:2"].count.state).toBe("may");
  const ins = input();
  expect(by["id:1"].count).toEqual(poolCount(S, "id:1", 2, ins.events.filter((e) => e.ticker === "A" || e.ticker === "B").map((e) => ({ live: e.live, unread: e.unread.length, contracts: e.contracts.map((c) => ({ top: c.top })) }))));
});

test("a pool missing one of the events it counts is never none", () => {
  const sc = screenOf(input({ events: input().events.filter((e) => e.ticker !== "B") }), T0);
  expect(sc.sport.find((p) => p.key === "id:1")!.count.state).toBe("may");
});

test("a game in play is shown in play and not scored from the list", () => {
  const sc = screenOf(input(), T0);
  const p3 = sc.sport.find((p) => p.key === "id:3")!;
  expect(p3.count.live).toBe(1);
  expect(p3.count.state).toBe("may");
  expect(p3.events[0].state).toBe("in-play");
  expect(sc.now.live).toBe(1);
});

test("the first figure counts sport events with no qualifying maker on the list, of the reward rows in sport pools", () => {
  const sc = screenOf(input(), T0);
  expect(sc.first).toEqual({ noMaker: 3, of: 4, lastScoreDate: "2026-11-16" }); // A, C, D of A, B, C, D; X is not in a sport pool
});

test("beside it, the listed events with a reward row, not in play, where no book can hold a qualifying quote", () => {
  const sc = screenOf(input(), T0);
  expect(sc.now).toEqual({ none: 2, of: 3, live: 1 }); // A and B of A, B, C; D in play; Z has no reward row
});

test("the program is counted by pool, each pool once, over the whole list", () => {
  const sc = screenOf(input(), T0);
  expect(sc.program).toEqual({ pools: 4, microsADay: 300_000_000 + 100_000_000 + 50_000_000 + 1_000_000_000 });
});

test("a pool whose rows disagree on its amount is counted at the smallest, never more", () => {
  const sc = screenOf(input({ pools: pools([row("A", 1, 2), row("B", 1, 2, { poolMicrosADay: 900_000_000 })]) }), T0);
  expect(sc.program.microsADay).toBe(300_000_000);
});

test("the pools where nobody can be qualifying from prices: how many, their dollars a minute, how many the list counted as claimed", () => {
  const sc = screenOf(input(), T0);
  expect(sc.gap).toEqual({ pools: 1, microsAMinute: Math.floor(300_000_000 / 1440), claimed: 1 });
});

test("each pool shows the age of its prices", () => {
  const sc = screenOf(input(), T0);
  expect(sc.pricesAgeMs).toBe(90_000);
  expect(sc.sport.every((p) => p.pricesAgeMs === 90_000)).toBe(true);
});

test("the record strip bins a week of pass rows by the hour, per pool", () => {
  const passes = [
    passAt(T0 - 2 * HOUR, [{ pool: "id:1", state: "none-prices" }]),
    passAt(T0 - 2 * HOUR + 300_000, [{ pool: "id:1", state: "may" }]),
    passAt(T0 - 10 * 60_000, [{ pool: "id:1", state: "none-sizes" }, { pool: "id:2", state: "may" }]),
    passAt(T0 - 8 * 24 * HOUR, [{ pool: "id:1", state: "none-prices" }]), // more than a week ago: left out
  ];
  const sc = screenOf(input({ passes }), T0);
  const strip = sc.sport.find((p) => p.key === "id:1")!.strip;
  expect(strip).toHaveLength(7 * 24);
  const now = strip[strip.length - 1], hourBefore = strip[strip.length - 2], twoAgo = strip[strip.length - 3];
  expect(now).toMatchObject({ passes: 0 }); // the hour the clock is in, not yet read
  expect(hourBefore).toMatchObject({ passes: 1, none: 1, may: 0 });
  expect(twoAgo).toMatchObject({ passes: 2, none: 1, may: 1 });
  expect(strip.reduce((n, c) => n + c.passes, 0)).toBe(3);
  expect(strip[strip.length - 1].endMs).toBeGreaterThanOrEqual(T0);
});

test("pools are listed with the ones nobody can be qualifying in first, then by dollars a day", () => {
  const sc = screenOf(input(), T0);
  expect(sc.sport.map((p) => p.key)).toEqual(["id:1", "id:2", "id:3", "id:9"]) // id:9 has no event read: known from the reward list alone, shown last;
});
