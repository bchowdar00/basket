// Every value in this file is invented. None is a reading of any market.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readRule } from "@app/rule";
import { mostOthersScore, readSettings, type Book } from "@app/score";
import { Stopped, type ListedEvent, type PoolRow, type Pools } from "../src/gemini.ts";
import { initialState, type EngineState, type Lists } from "../src/pass.ts";
import { addSweep, runSweep, sweepDue, sweepFigures, sweepPlan } from "../src/sweep.ts";

const rule = readRule(JSON.parse(readFileSync(new URL("../../../settings/rule.json", import.meta.url), "utf8")));
const s = readSettings({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 });
const HOUR = 3_600_000;
const T = rule.noSizeBeforeMs;
const HASH = "cd".repeat(32);

const ev = (ticker: string, contracts: [string, number | null, number | null][], over: Partial<ListedEvent> = {}): ListedEvent => ({
  ticker, title: "made up", category: "Made Up", subcategory: null, startMs: T + 30 * HOUR, live: false, volume: 0,
  contracts: contracts.map(([symbol, b, a]) => ({ symbol, stepCents: 1, top: { bidCents: b, askCents: a } })), unread: [], ...over,
});
const pool = (ticker: string, id: number, count: number): PoolRow => ({
  ticker, title: "made up", category: "Made Up", poolMicrosADay: 250_000_000, source: "category_default", endsAtMs: null, makers: 0,
  poolId: id, poolEventCount: count, poolName: "Made Up", poolKey: "id:" + id, raw: {},
});
const pools = (rows: PoolRow[]): Pools => ({ lastScoreDate: null, total: rows.length, rows, twice: 0, moved: false });
const withQuote = (event: string, symbol: string, poolKey: string): EngineState => {
  const st = initialState(HASH);
  st.standing[event] = { event, symbol, pair: { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 100 } }, sinceMs: T, pool: poolKey };
  return st;
};

test("S1 a sweep is due only from the hub's instant on, and at most sweepsADay a day", () => {
  assert.equal(sweepDue(rule, [], T - 1), false);
  assert.equal(sweepDue(rule, [], T), true);
  assert.equal(sweepDue(rule, [T], T + 6 * HOUR - 1), false);
  assert.equal(sweepDue(rule, [T], T + 6 * HOUR), true);
});

test("S2 the plan reads, in each pool where a quote stands, every contract narrow on the list, every contract of a live event, every unread one", () => {
  const lists: Lists = {
    settings: s,
    pools: pools([pool("E1", 7, 3), pool("E2", 7, 3), pool("E3", 7, 3), pool("F1", 8, 1)]),
    events: [
      ev("E1", [["E1-A", 45, 55], ["E1-B", 30, 60]]),
      ev("E2", [["E2-A", 20, 50]], { live: true }),
      ev("E3", [["E3-A", 48, 52]], { unread: ["E3-X"] }),
      ev("F1", [["F1-A", 49, 51]]), // another pool, where nothing of ours stands
    ],
  };
  const plan = sweepPlan(s, withQuote("E1", "E1-A", "id:7"), lists);
  assert.deepEqual(plan.byPool, { "id:7": { symbols: ["E1-A", "E2-A", "E3-A", "E3-X"], complete: true } });
  assert.deepEqual(plan.symbols, ["E1-A", "E2-A", "E3-A", "E3-X"]);
  assert.deepEqual(plan.pairs, { "E1-A": { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 100 } } }); // audit 1 round 2, finding A
});

test("S8 an event listed with no contract leaves its pool with no figure (audit 2, finding 7)", () => {
  const lists: Lists = { settings: s, pools: pools([pool("E1", 7, 2), pool("E2", 7, 2)]), events: [ev("E1", [["E1-A", 45, 55]]), ev("E2", [])] };
  assert.equal(sweepPlan(s, withQuote("E1", "E1-A", "id:7"), lists).byPool["id:7"].complete, false);
});

test("S3 a pool with an event missing from the list, or a contract unread with no name, has no figure", () => {
  const lists: Lists = { settings: s, pools: pools([pool("E1", 7, 3), pool("E2", 7, 3)]), events: [ev("E1", [["E1-A", 45, 55]]), ev("E2", [["E2-A", 45, 55]])] };
  assert.equal(sweepPlan(s, withQuote("E1", "E1-A", "id:7"), lists).byPool["id:7"].complete, false);
  const two: Lists = { ...lists, pools: pools([pool("E1", 7, 2), pool("E2", 7, 2)]), events: [ev("E1", [["E1-A", 45, 55]]), ev("E2", [], { unread: [""] })] };
  assert.equal(sweepPlan(s, withQuote("E1", "E1-A", "id:7"), two).byPool["id:7"].complete, false);
});

const lv = (cents: number, qty: number) => ({ cents, qty });

test("S4 the figures: the others across the pool's books; none where the plan was not complete or a book is missing or unread", () => {
  const plan = { symbols: ["A", "B"], byPool: { "id:7": { symbols: ["A", "B"], complete: true }, "id:8": { symbols: [], complete: false } } };
  const a: Book = { bids: [lv(48, 100)], asks: [lv(52, 100)] }, b: Book = { bids: [lv(45, 100)], asks: [lv(55, 100)] };
  assert.deepEqual(sweepFigures(s, plan, new Map([["A", a], ["B", b]])), { "id:7": 58, "id:8": null });
  assert.deepEqual(sweepFigures(s, plan, new Map([["A", a], ["B", null]])), { "id:7": null, "id:8": null });
  assert.deepEqual(sweepFigures(s, plan, new Map([["A", a]])), { "id:7": null, "id:8": null });
  // where our pair stands in a book, the others there are scored at the midpoint the pair gives it (audit 1 round 2, finding A)
  const moved: Book = { bids: [lv(40, 100)], asks: [lv(48, 1000)] };
  const withPair = { symbols: ["M"], byPool: { "id:9": { symbols: ["M"], complete: true } }, pairs: { M: { bid: lv(43, 100), ask: lv(50, 100) } } };
  assert.equal(sweepFigures(s, withPair, new Map([["M", moved]]))["id:9"], mostOthersScore(s, moved, 43 + 48));
  assert.notEqual(sweepFigures(s, { ...withPair, pairs: {} }, new Map([["M", moved]]))["id:9"], mostOthersScore(s, moved, 43 + 48));
});

function world() {
  let now = T;
  const asked: string[] = [];
  let inFlight = 0, most = 0;
  const d = { nowMs: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve(); } };
  return { d, asked, most: () => most, at: () => now, r: (answer: (symbol: string) => Book | null | "429") => ({
    async book(symbol: string, notBefore: number) {
      assert.ok(now >= notBefore);
      asked.push(symbol);
      inFlight++; most = Math.max(most, inFlight);
      await Promise.resolve();
      now += 100;
      inFlight--;
      const x = answer(symbol);
      if (x === "429") throw new Stopped("made up");
      return x;
    },
  }) };
}

test("S5 a sweep reads its books one at a time, sweepApartMs apart, and keeps each raw", async () => {
  const w = world();
  const got: string[] = [];
  const book: Book = { bids: [lv(45, 100)], asks: [lv(55, 100)] };
  const plan = { symbols: ["A", "B", "C"], byPool: { "id:7": { symbols: ["A", "B", "C"], complete: true } } };
  const out = await runSweep(w.r(() => book), rule, s, plan, w.d, (symbol) => got.push(symbol));
  assert.deepEqual(w.asked, ["A", "B", "C"]);
  assert.equal(w.most(), 1);
  assert.deepEqual(got, ["A", "B", "C"]);
  assert.equal(out.atMs, T);
  assert.equal(out.stopped, false);
  assert.deepEqual(out.figures, { "id:7": 24 });
  assert.ok(w.at() >= T + 2 * rule.sweepApartMs);
});

test("S6 a sweep stopped by a 429 gives no figure to the pools it did not finish", async () => {
  const w = world();
  const book: Book = { bids: [lv(45, 100)], asks: [lv(55, 100)] };
  const plan = { symbols: ["A", "B", "C"], byPool: { "id:7": { symbols: ["A"], complete: true }, "id:8": { symbols: ["B", "C"], complete: true } } };
  const out = await runSweep(w.r((sym) => (sym === "B" ? "429" : book)), rule, s, plan, w.d);
  assert.equal(out.stopped, true);
  assert.deepEqual(w.asked, ["A", "B"]);
  assert.deepEqual(out.figures, { "id:7": 8, "id:8": null });
});

test("S7 a finished sweep is added to the state under each pool, and to the sweeps made", () => {
  const st = addSweep(initialState(HASH), T, { "id:7": 58, "id:8": null });
  assert.deepEqual(st.sweeps, { "id:7": [{ atMs: T, othersMost: 58 }], "id:8": [{ atMs: T, othersMost: null }] });
  assert.deepEqual(st.sweptAtMs, [T]);
});
