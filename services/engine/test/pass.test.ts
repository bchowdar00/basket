// Every value in this file is invented. None is a reading of any market.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { decide, readRule } from "@app/rule";
import { readSettings } from "@app/score";
import { chain } from "@app/ledger/chain";
import { geminiDay, samePair } from "@app/ledger";
import { toEventIn, type ListedEvent, type PoolRow, type Pools } from "../src/gemini.ts";
import { initialState, pass, type EngineState, type Lists } from "../src/pass.ts";
import { addSweep } from "../src/sweep.ts";

const rule = readRule(JSON.parse(readFileSync(new URL("../../../settings/rule.json", import.meta.url), "utf8")));
const s = readSettings({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 });
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0); // 7 am Eastern, inside the exchange's day 2026-11-17
const HASH = "ef".repeat(32);

const ev = (ticker: string, contracts: [string, number | null, number | null][], over: Partial<ListedEvent> = {}): ListedEvent => ({
  ticker, title: "made up", category: "Made Up", subcategory: null, startMs: T0 + 40 * HOUR, live: false, volume: 10,
  contracts: contracts.map(([symbol, b, a]) => ({ symbol, stepCents: 1, top: { bidCents: b, askCents: a } })), unread: [], ...over,
});
const pool = (ticker: string, id: number | null, count: number, makers = 0): PoolRow => ({
  ticker, title: "made up", category: "Made Up", poolMicrosADay: 250_000_000, source: "category_default", endsAtMs: null, makers,
  poolId: id, poolEventCount: count, poolName: "Made Up", poolKey: id === null ? "event:" + ticker : "id:" + id, raw: {},
});
const pools = (rows: PoolRow[], lastScoreDate: string | null = "2026-11-16"): Pools => ({ lastScoreDate, total: rows.length, rows, twice: 0, moved: false });

/** Others quote 44 to 56 on E1-A and E2-A and step a cent now and then, so both are tended; the pool is id 7 of two events. */
type Over = { e1pool?: number; e1?: [number | null, number | null]; e1b?: [number | null, number | null] | null; e1a?: boolean; e2p?: [number, number]; vol?: number | null; lsd?: string | null; makers?: number; e2?: boolean };
function listsAt(atMs: number, over: Over = {}): Lists {
  const stepped = Math.floor((atMs - T0) / (3 * HOUR)) % 2 === 0;
  const e1 = over.e1 ?? [stepped ? 44 : 45, 56];
  const e1b = over.e1b === undefined ? [20, 80] : over.e1b;
  const e1contracts: [string, number | null, number | null][] = [];
  if (over.e1a !== false) e1contracts.push(["E1-A", e1[0], e1[1]]);
  if (e1b !== null) e1contracts.push(["E1-B", e1b[0], e1b[1]]);
  const events = [ev("E1", e1contracts, { volume: over.vol === undefined ? 10 : over.vol })];
  if (over.e2 !== false) events.push(ev("E2", [["E2-A", over.e2p?.[0] ?? (stepped ? 44 : 45), over.e2p?.[1] ?? 56]]));
  return { settings: s, events, pools: pools([pool("E1", over.e1pool ?? 7, over.e1pool === undefined ? 2 : 1, over.makers ?? 0), pool("E2", 7, 2, 0)], over.lsd === undefined ? geminiDay(atMs - 24 * HOUR) : over.lsd) };
}

/** Runs the engine every five minutes from `fromMs` for `n` passes. */
function run(st: EngineState, fromMs: number, n: number, at = (t: number) => listsAt(t)) {
  let out = null as ReturnType<typeof pass> | null;
  for (let i = 0; i < n; i++) {
    out = pass(rule, st, at(fromMs + i * 5 * MIN), fromMs + i * 5 * MIN);
    st = out.state;
  }
  return { st, out: out! };
}
// 26 hours of reads before T0, so the logs cover the hour and the day.
const warm = (over: Over = {}) => run(initialState(HASH), T0 - 26 * HOUR, 26 * 12, (t) => listsAt(t, over));
const keyOf = (day: string, event: string, symbol: string, b: number, a: number, pool = "id:7") => day + "|" + event + "|" + symbol + "|" + b + "x100/" + a + "x100|" + pool;

test("P1 a pass gives the decisions the rule gives on the same lists and logs", () => {
  const { st } = warm();
  const lists = listsAt(T0);
  const out = pass(rule, st, lists, T0);
  const poolOf = new Map(lists.pools.rows.map((r) => [r.ticker, r]));
  const logs = out.state.logs;
  const held = { filled: new Set<string>(), tiedUpMicros: 0, quoted: new Set(Object.keys(st.standing)) };
  assert.deepEqual(out.decisions, decide(rule, s, lists.events.map((e) => toEventIn(e, poolOf.get(e.ticker), (x) => logs[x] ?? [])), held, T0));
  assert.ok(out.decisions.some((d) => d.pair !== null));
});

test("P2 fills are counted before new quotes are written, and a fill ends the quoting of its event", () => {
  const { st } = warm();
  const q = pass(rule, st, listsAt(T0), T0).state;
  assert.equal(q.standing.E1.symbol, "E1-A");
  const out = pass(rule, q, listsAt(T0 + 5 * MIN, { e1: [40, 45] }), T0 + 5 * MIN); // their ask at our bid
  assert.equal(out.fills.length, 1);
  assert.deepEqual([out.fills[0].event, out.fills[0].by, out.fills[0].side], ["E1", "reached", "bid"]);
  assert.equal(out.state.standing.E1, undefined);
  assert.ok(out.decisions.some((d) => d.event === "E1" && d.reason === "filled"));
  assert.equal(out.state.positions.length, 1);
});

test("P3 a rise in the event's volume fills the worse side; a quote whose contract is gone is filled on the worse side too", () => {
  const { st } = warm();
  const q = pass(rule, st, listsAt(T0), T0).state;
  const rose = pass(rule, q, listsAt(T0 + 5 * MIN, { vol: 11 }), T0 + 5 * MIN);
  assert.deepEqual([rose.fills[0].by, rose.fills[0].side], ["traded", "worse"]);
  assert.equal(rose.passRow.volume.rose, 1);
  const gone = pass(rule, q, { ...listsAt(T0 + 5 * MIN), events: listsAt(T0 + 5 * MIN).events.filter((e) => e.ticker !== "E1") }, T0 + 5 * MIN);
  assert.ok(gone.fills.some((f) => f.event === "E1" && f.side === "worse"));
});

test("P4 a volume that falls or is missing says nothing, and the pass row counts it", () => {
  const { st } = warm();
  const q = pass(rule, st, listsAt(T0), T0).state;
  assert.equal(pass(rule, q, listsAt(T0 + 5 * MIN, { vol: null }), T0 + 5 * MIN).passRow.volume.nothing, 1);
  assert.equal(pass(rule, q, listsAt(T0 + 5 * MIN, { vol: 3 }), T0 + 5 * MIN).passRow.volume.nothing, 1);
  assert.equal(pass(rule, q, listsAt(T0 + 5 * MIN), T0 + 5 * MIN).passRow.volume.level, 2);
});

test("P5 minutes count only for a quote that stood with the same pair at both reads; with no sweep they are unswept", () => {
  const { st } = warm();
  const a = pass(rule, st, listsAt(T0), T0).state;
  const b = pass(rule, a, listsAt(T0 + 5 * MIN), T0 + 5 * MIN).state;
  const k = keyOf(geminiDay(T0 + 5 * MIN), "E1", "E1-A", 45, 55);
  const m0 = a.open[k]?.minutes ?? 0, u0 = m0;
  assert.equal(b.open[k].minutes - m0, 5);
  assert.equal(b.open[k].minutes - u0, 5); // minutes wait for the sweeps until the row is written
  // their bid steps up a cent: the midpoint moves half a cent, the pair changes, and the interval counts nothing
  assert.deepEqual([b.standing.E1.pair.bid.cents, b.standing.E1.pair.ask.cents], [45, 55]);
  const c = pass(rule, b, listsAt(T0 + 10 * MIN, { e1: [45, 56] }), T0 + 10 * MIN).state;
  assert.deepEqual([c.standing.E1.pair.bid.cents, c.standing.E1.pair.ask.cents], [46, 55]);
  assert.equal(c.open[k].minutes, b.open[k].minutes);
  assert.equal(c.standing.E1.sinceMs, T0 + 10 * MIN);
});

test("P6 two quotes in one pool share each swept minute together against the others", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state;
  assert.deepEqual(Object.keys(a.standing).sort(), ["E1", "E2"]);
  a = addSweep(a, T0 + 2 * MIN, { "id:7": 84 });
  const b = pass(rule, a, listsAt(T0 + 5 * MIN), T0 + 5 * MIN).state;
  const day = geminiDay(T0 + 5 * MIN), next = Date.UTC(2026, 10, 18, 12, 0, 0);
  const out = pass(rule, b, listsAt(next, { lsd: day }), next);
  for (const e of ["E1", "E2"]) {
    const r = out.rows.find((x) => x.event === e && x.day === day)!;
    assert.equal(r.unsweptMinutes, 0);
    assert.ok(r.leastMinutes >= 5);
    // every quote of ours in the pool was scored 8 at each of these marks: 8 / (8 + 8 + 84) each, never 8 / (8 + 84)
    assert.ok(r.rewardMicros > 0);
  }
  const scores = (b.marks["id:7"] ?? []).filter((m) => m.atMs > T0 && m.atMs <= T0 + 5 * MIN).map((m) => m.entries.map((x) => x.score));
  assert.deepEqual(scores, [[8, 8], [8, 8], [8, 8], [8, 8], [8, 8]]);
});

test("P7 a pass row counts each pool of the events read", () => {
  const { st } = warm();
  const out = pass(rule, st, listsAt(T0), T0);
  assert.deepEqual(out.passRow.pools.map((p) => [p.pool, p.listed, p.eventCount, p.nonePrices, p.state]), [["id:7", 2, 2, 2, "none-prices"]]); // both wider than the widest spread
  const one = pass(rule, st, listsAt(T0, { e2: false }), T0);
  assert.equal(one.passRow.pools[0].state, "may"); // one of its two events is not on the list
});

test("P8 the list's last scored day must be before today's exchange day, or the pass stops", () => {
  const { st } = warm();
  assert.throws(() => pass(rule, st, listsAt(T0, { lsd: geminiDay(T0) }), T0), /last score date/);
  assert.throws(() => pass(rule, st, listsAt(T0), st.lastPassMs!), /forward/);
});

test("P9 a day's rows are written once a list has scored it, with that list's maker count; the chain runs through every line", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state;
  a = pass(rule, a, listsAt(T0 + 5 * MIN), T0 + 5 * MIN).state;
  const day = geminiDay(T0);
  const next = Date.UTC(2026, 10, 18, 12, 0, 0);
  const waiting = pass(rule, a, listsAt(next, { lsd: "2026-11-16" }), next);
  assert.equal(waiting.rows.length, 0);
  const out = pass(rule, a, listsAt(next, { lsd: day, makers: 0 }), next);
  const e1 = out.rows.filter((r) => r.event === "E1" && r.day === day);
  const accs = Object.entries(a.open).filter(([k]) => k.startsWith(day + "|E1|E1-A|")).map(([, v]) => v);
  assert.ok(accs.length > 0 && e1.length === accs.length);
  assert.equal(e1.reduce((n, r) => n + r.minutes, 0), accs.reduce((n, x) => n + x.minutes, 0));
  assert.ok(e1.every((r) => r.unsweptMinutes === r.minutes && !r.rewardProvisional && r.ruleHash === HASH)); // no sweep anywhere: every minute unswept
  let head = a.chainHex;
  for (const line of out.lines) {
    const { row, head: h } = JSON.parse(line);
    head = chain(head, JSON.stringify(row));
    assert.equal(h, head);
  }
  assert.equal(out.state.chainHex, head);
  assert.equal(JSON.parse(out.lines[0]).row.kind, "pass");
  assert.deepEqual(Object.keys(out.state.open).filter((k) => k.startsWith(day)), []);
});

test("P10 the chain starts at the rule's hash, and a state read back from JSON carries on with the same chain", () => {
  const first = pass(rule, initialState(HASH), listsAt(T0), T0);
  assert.equal(first.state.chainHex, chain(HASH, JSON.stringify(first.passRow)));
  const { st } = warm();
  const back = JSON.parse(JSON.stringify(st)) as EngineState;
  const x = pass(rule, st, listsAt(T0), T0), y = pass(rule, back, listsAt(T0), T0);
  assert.deepEqual(y.lines, x.lines);
  assert.equal(y.state.chainHex, x.state.chainHex);
  assert.notEqual(createHash("sha256").update(x.state.chainHex).digest("hex"), "");
});

test("P11 an event with no pool row is never quoted, and the logs keep only what the tests need", () => {
  const { st } = warm();
  const lists = listsAt(T0);
  const out = pass(rule, st, { ...lists, pools: pools(lists.pools.rows.filter((r) => r.ticker !== "E2")) }, T0);
  assert.ok(out.decisions.some((d) => d.event === "E2" && d.reason === "no-pool"));
  const oldest = Math.min(...Object.values(out.state.logs).map((l) => l[0].atMs));
  assert.ok(oldest >= T0 - rule.tendedWithinMs - 2 * rule.readEveryMs);
});

// --- audit 2, round 1: the fixes. Every value invented. ---

test("P12 a fill on a contract that left the list ends the quoting of its whole event (audit 2, finding 2)", () => {
  const { st } = warm({ e1b: [44, 56] });
  const a = pass(rule, st, listsAt(T0, { e1b: [44, 56] }), T0).state;
  assert.equal(a.standing.E1.symbol, "E1-A");
  const out = pass(rule, a, listsAt(T0 + 5 * MIN, { e1b: [44, 56], e1a: false }), T0 + 5 * MIN);
  assert.ok(out.fills.some((f) => f.symbol === "E1-A" && f.side === "worse"));
  assert.ok(out.decisions.some((d) => d.event === "E1" && d.reason === "filled"));
  assert.equal(out.state.standing.E1, undefined);
  assert.ok(out.decisions.filter((d) => d.event === "E1").every((d) => d.pair === null));
});

test("P13 a fill is marked at the pair it was filled on, and its row ties up that pair's money (audit 2, finding 3)", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state; // 45 / 55
  a = pass(rule, a, listsAt(T0 + 5 * MIN, { e1: [45, 56] }), T0 + 5 * MIN).state; // 46 / 55
  assert.deepEqual([a.standing.E1.pair.bid.cents, a.standing.E1.pair.ask.cents], [46, 55]);
  const f = pass(rule, a, listsAt(T0 + 10 * MIN, { e1: [40, 46] }), T0 + 10 * MIN); // their ask at our bid of 46
  assert.equal(f.fills.length, 1);
  const day = geminiDay(T0), next = Date.UTC(2026, 10, 18, 12, 0, 0);
  const out = pass(rule, f.state, listsAt(next, { lsd: day, e1: [44, 56] }), next);
  const filled = out.rows.filter((r) => r.event === "E1" && r.fills.length > 0);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].tiedUpMicros, (46 * 100 + 45 * 100) * 10_000);
  assert.equal(filled[0].markMicros, (44 - 46) * 100 * 10_000); // sold at their bid of 44, bought at 46
  assert.ok(out.rows.some((r) => r.event === "E1" && r.fills.length === 0 && r.tiedUpMicros === (45 * 100 + 45 * 100) * 10_000));
});

test("P14 the sweep a minute counts at is the nearest known when its row is written, a later one included (audit 2, finding 4)", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state;
  a = pass(rule, a, listsAt(T0 + 5 * MIN), T0 + 5 * MIN).state;
  a = addSweep(a, T0 + 7 * MIN, { "id:7": 84 }); // after the marks it is nearest to
  const day = geminiDay(T0), next = Date.UTC(2026, 10, 18, 12, 0, 0);
  const out = pass(rule, a, listsAt(next, { lsd: day }), next);
  const r = out.rows.find((x) => x.event === "E1" && x.day === day)!;
  assert.equal(r.unsweptMinutes, 0);
  assert.equal(r.leastMinutes, 4); // T0+2 to T0+5 are within five minutes of the sweep at T0+7
  assert.equal(r.estimateMinutes, r.minutes - 4);
});

test("P15 a quote of ours that stood the interval and was then replaced still counts in ours for the pool (audit 2, finding 6)", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state;
  a = addSweep(a, T0 + 3 * MIN, { "id:7": 84 });
  const b = pass(rule, a, listsAt(T0 + 5 * MIN, { e2p: [45, 56] }), T0 + 5 * MIN).state; // E2's pair moves to 46 / 55
  const marks = b.marks["id:7"].filter((m) => m.atMs > T0 && m.atMs <= T0 + 5 * MIN);
  assert.equal(marks.length, 5);
  for (const m of marks) assert.deepEqual(m.entries.map((e) => [e.key === null, e.score]).sort(), [[false, 8], [true, 8]]);
});

test("P16 an event the list moves to another pool in the day, whose pair moves and comes back, keeps each row to one pool (audit 2 round 2, X1)", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state; // E1 at 45 / 55 in id 7
  a = pass(rule, a, listsAt(T0 + 5 * MIN, { e1pool: 9, e1: [45, 56] }), T0 + 5 * MIN).state; // moved to id 9, at 46 / 55
  a = pass(rule, a, listsAt(T0 + 10 * MIN, { e1pool: 9, e1: [44, 56] }), T0 + 10 * MIN).state; // back to 45 / 55, in id 9
  a = pass(rule, a, listsAt(T0 + 15 * MIN, { e1pool: 9, e1: [44, 56] }), T0 + 15 * MIN).state; // stood: five minutes in id 9
  const day = geminiDay(T0), next = Date.UTC(2026, 10, 18, 12, 0, 0);
  const out = pass(rule, a, listsAt(next, { lsd: day, e1pool: 9 }), next);
  const e1 = out.rows.filter((r) => r.event === "E1" && r.day === day);
  for (const r of e1) assert.equal(r.unsweptMinutes + r.leastMinutes + r.estimateMinutes, r.minutes);
  assert.ok(e1.some((r) => r.minutes === 5)); // the row in id 9 holds only its own five minutes
});

test("P17 an event the list moves to another pool with its pair unchanged is quoted in the new pool from then on (audit 2 round 3)", () => {
  const { st } = warm();
  let a = pass(rule, st, listsAt(T0), T0).state; // E1 in id 7
  const pair = a.standing.E1.pair;
  a = pass(rule, a, listsAt(T0 + 5 * MIN, { e1pool: 9 }), T0 + 5 * MIN).state; // moved to id 9, the same book
  assert.ok(samePair(a.standing.E1.pair, pair)); // the pair did not move
  assert.equal(a.standing.E1.pool, "id:9");
  a = pass(rule, a, listsAt(T0 + 10 * MIN, { e1pool: 9 }), T0 + 10 * MIN).state;
  const after = (p: string) => (a.marks[p] ?? []).filter((m) => m.atMs > T0 + 5 * MIN);
  assert.ok(after("id:9").length > 0); // the minutes after the move are marked in id 9
  assert.ok(after("id:7").every((m) => m.entries.every((e) => e.key === null || !e.key.includes("|E1|")))); // and not in id 7
});
