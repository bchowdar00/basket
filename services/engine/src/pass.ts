// One read of the forward run: the lists in, the fills, the decisions, the minutes and the rows out.
//
// Nothing here asks anybody anything and nothing here places an order: `pass` is a function of the
// engine's state, the lists one pass read, and the time. Every figure comes from the three libraries.
// The engine's state is plain JSON, so a restart reads it back and carries on from the same chain.
//
// The co-lead's rulings (plan 1.3-E), each set against the quote where the reads leave a doubt:
// - a standing quote whose contract is gone from the list is counted filled on its worse side;
// - a filled position stays tied up for the rest of the run (the list gives no result to free it);
// - a contract's log starts at the engine's own first read, so nothing is quoted in the first hour;
// - a market's row is written once a pool list has scored its day, with that list's maker count for
//   the event; an event gone from the list is written with no count, so its reward stays waiting;
// - a row is one day of one quote, its pair and its pool included: a quote whose pair or pool moves starts a new row;
// - each minute mark keeps the score of every quote of ours standing in the pool over that interval
//   (kept, replaced or filled), and its share and its sweep are worked out when the row is written,
//   against every sweep known by then ("nearest, before or after", the ledger's rule).

import { decide, tiedUpMicros, type Decision, type Held, type Read, type Rule } from "@app/rule";
import { ourScore, sharesInPool, type Pair, type PoolEvent, type Settings, type Top } from "@app/score";
import { fillAt, geminiDay, minuteMarks, passRow, row, samePair, sweepFor, volumeSays, type Credit, type Fill, type PassRow, type Row, type Seen, type Standing, type Sweep } from "@app/ledger";
import { chain } from "@app/ledger/chain";
import { toEventIn, type ListedEvent, type PoolRow, type Pools } from "./gemini.ts";

export type Quote = Standing & { pool: string };
export type Position = { fill: Fill; pair: Pair; pool: string };
/** A market's row as it fills up during its day: one quote, one pair. Its minutes wait for the sweeps in `marks` until it is written. */
export type RowAcc = { day: string; event: string; symbol: string; pool: string; pair: Pair; tiedUpMicros: number; poolMicrosADay: number; minutes: number; fills: Fill[] };
/** One minute mark of one pool: the score of every quote of ours standing in it over that interval; `key` is the row a counted minute goes to, null for a quote that stood but does not count. */
export type Mark = { atMs: number; entries: { key: string | null; score: number }[] };
export type EngineState = {
  ruleHash: string;
  chainHex: string; // the head of the chain; it starts at the rule's hash
  lastPassMs: number | null;
  logs: Record<string, Read[]>; // each contract's best prices at each read, oldest first
  seen: Record<string, Seen>; // each contract's last read, with its event's volume
  standing: Record<string, Quote>; // by event: the quote written down at the last read
  positions: Position[];
  sweeps: Record<string, Sweep[]>; // by pool key
  sweptAtMs: number[];
  open: Record<string, RowAcc>; // by day, event, contract and pair
  marks: Record<string, Mark[]>; // by pool key, oldest first
};
export type Lists = { events: ListedEvent[]; pools: Pools; settings: Settings };
export type PassOut = { decisions: Decision[]; fills: Fill[]; rows: Row[]; passRow: PassRow; lines: string[]; state: EngineState };

export function initialState(ruleHash: string): EngineState {
  if (!/^[0-9a-f]{64}$/.test(ruleHash)) throw new Error("pass: the rule hash is not one");
  return { ruleHash, chainHex: ruleHash, lastPassMs: null, logs: {}, seen: {}, standing: {}, positions: [], sweeps: {}, sweptAtMs: [], open: {}, marks: {} };
}

const pairText = (p: Pair) => p.bid.cents + "x" + p.bid.qty + "/" + p.ask.cents + "x" + p.ask.qty;
const accKey = (day: string, event: string, symbol: string, pair: Pair, pool: string) => day + "|" + event + "|" + symbol + "|" + pairText(pair) + "|" + pool; // the pool too: the list can move an event between pools in a day (audit 2 round 2, X1)

export function pass(rule: Rule, before: EngineState, lists: Lists, nowMs: number): PassOut {
  const st: EngineState = structuredClone(before);
  const s = lists.settings;
  const today = geminiDay(nowMs);
  if (st.lastPassMs !== null && !(nowMs > st.lastPassMs)) throw new Error("pass: the time does not move forward");
  // The day-turn check (plan 1.2): the list's last scored day must be before the day the clock says it is.
  const lsd = lists.pools.lastScoreDate;
  if (lsd !== null && lsd >= today) throw new Error("pass: the list's last score date " + lsd + " is not before the exchange's day " + today);

  const poolOf = new Map<string, PoolRow>(lists.pools.rows.map((r) => [r.ticker, r]));
  const nowSeen = new Map<string, Seen>();
  for (const e of lists.events) for (const c of e.contracts) nowSeen.set(c.symbol, { atMs: nowMs, top: c.top, eventVolume: e.volume });

  const acc = (day: string, q: Quote, pool: PoolRow | undefined): [string, RowAcc] => {
    const k = accKey(day, q.event, q.symbol, q.pair, q.pool);
    st.open[k] ??= { day, event: q.event, symbol: q.symbol, pool: q.pool, pair: q.pair, tiedUpMicros: tiedUpMicros(q.pair), poolMicrosADay: pool?.poolMicrosADay ?? 0, minutes: 0, fills: [] };
    return [k, st.open[k]];
  };
  const was = st.standing; // the quotes that stood from the last read to this one

  // 1. Fills first, on the quotes written down at the last read.
  const fills: Fill[] = [];
  const volume = { rose: 0, level: 0, nothing: 0 };
  const filledNow = new Set<string>();
  for (const q of Object.values(was)) {
    const prior = st.seen[q.symbol], now = nowSeen.get(q.symbol);
    let fill: Fill | null;
    if (now === undefined || prior === undefined) {
      fill = { event: q.event, symbol: q.symbol, atMs: nowMs, by: "traded", side: "worse", qty: Math.max(q.pair.bid.qty, q.pair.ask.qty) };
      volume.nothing++;
    } else {
      volume[volumeSays(prior, now)]++;
      fill = fillAt(rule, q, prior, now);
    }
    if (fill === null) continue;
    fills.push(fill);
    filledNow.add(q.event);
    st.positions.push({ fill, pair: q.pair, pool: q.pool });
    acc(geminiDay(nowMs), q, poolOf.get(q.event))[1].fills.push(fill);
  }

  // 2. This read goes into the logs.
  const keepFrom = nowMs - rule.tendedWithinMs - 2 * rule.readEveryMs;
  for (const [symbol, seen] of nowSeen) {
    const log = (st.logs[symbol] ??= []);
    log.push({ atMs: nowMs, top: seen.top });
    while (log.length > 0 && log[0].atMs < keepFrom) log.shift();
  }
  for (const symbol of Object.keys(st.logs)) if (!nowSeen.has(symbol) && st.logs[symbol].every((r) => r.atMs < keepFrom)) delete st.logs[symbol];

  // 3. The decision. A fill ends the quoting of its whole event: every contract the list gives it now
  // is held as filled, as well as the filled one, which may have left the list (audit 2, finding 2).
  const filledEvents = new Set(st.positions.map((p) => p.fill.event));
  const filledSymbols = new Set(st.positions.map((p) => p.fill.symbol));
  for (const e of lists.events) if (filledEvents.has(e.ticker)) for (const c of [...e.contracts.map((x) => x.symbol), ...e.unread]) filledSymbols.add(c);
  const held: Held = {
    filled: filledSymbols,
    tiedUpMicros: st.positions.reduce((n, p) => n + tiedUpMicros(p.pair), 0),
    quoted: new Set(Object.keys(was).filter((e) => !filledNow.has(e))),
  };
  const ins = lists.events.map((e) => toEventIn(e, poolOf.get(e.ticker), (symbol) => st.logs[symbol] ?? []));
  const decisions = decide(rule, s, ins, held, nowMs);

  // 4. The minutes of quotes that stood from the last read to this one, the same pair at both. Each
  // mark keeps the score of every quote of ours that stood in the pool over the interval.
  const next: Record<string, Quote> = {};
  const keptEvents = new Set<string>();
  for (const d of decisions) {
    if (d.pair === null || d.symbol === null) continue;
    const prev = was[d.event];
    const pool = poolOf.get(d.event);
    const poolKey = pool ? pool.poolKey : "event:" + d.event;
    if (prev !== undefined && !filledNow.has(d.event) && prev.symbol === d.symbol && samePair(prev.pair, d.pair) && prev.pool === poolKey) {
      next[d.event] = prev;
      keptEvents.add(d.event);
    } else next[d.event] = { event: d.event, symbol: d.symbol, pair: d.pair, sinceMs: nowMs, pool: poolKey };
  }
  if (st.lastPassMs !== null) {
    const stood = Object.values(was);
    const marks = minuteMarks(rule, { atMs: st.lastPassMs, quoted: true, alone: true }, { atMs: nowMs, quoted: true, alone: true });
    const byPool = new Map<string, Quote[]>();
    for (const q of stood) byPool.set(q.pool, [...(byPool.get(q.pool) ?? []), q]);
    for (const [pool, qs] of byPool) {
      if (!qs.some((q) => keptEvents.has(q.event))) continue;
      // Our score at the worse of the two reads; a contract gone from the list is scored at its last read.
      const scores = qs.map((q) => {
        const a = st.seen[q.symbol]?.top, b = nowSeen.get(q.symbol)?.top;
        return Math.min(...[a, b].filter((x): x is Top => x !== undefined).map((x) => ourScore(s, q.pair, x)));
      });
      for (const atMs of marks) {
        const entries = qs.map((q, i) => {
          if (!keptEvents.has(q.event)) return { key: null, score: scores[i] };
          const [key, a] = acc(geminiDay(atMs), q, poolOf.get(q.event));
          a.minutes++;
          return { key, score: scores[i] };
        });
        (st.marks[pool] ??= []).push({ atMs, entries });
      }
    }
  }
  st.standing = next;
  for (const [symbol, seen] of nowSeen) st.seen[symbol] = seen;

  // 5. The program's record: one count for each pool of the events read.
  const groups = new Map<string, { eventCount: number; events: PoolEvent[] }>();
  for (const e of lists.events) {
    const p = poolOf.get(e.ticker);
    if (p === undefined) continue;
    const g = groups.get(p.poolKey) ?? { eventCount: p.poolEventCount, events: [] };
    g.events.push({ live: e.live, unread: e.unread.length, contracts: e.contracts.map((c) => ({ top: c.top })) });
    groups.set(p.poolKey, g);
  }
  const pr = passRow(s, { atMs: nowMs, ruleHash: st.ruleHash, pools: [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([pool, g]) => ({ pool, ...g })), volume });

  // 6. Rows of days the list has scored.
  const rows: Row[] = [];
  if (lsd !== null) {
    for (const [k, a] of Object.entries(st.open).sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (!(a.day <= lsd && a.day < today)) continue;
      const p = poolOf.get(a.event);
      const last = (nowSeen.get(a.symbol) ?? st.seen[a.symbol])?.top ?? { bidCents: null, askCents: null };
      const credits: Credit[] = [];
      let unsweptMinutes = 0;
      for (const m of st.marks[a.pool] ?? []) {
        const i = m.entries.findIndex((x) => x.key === k);
        if (i < 0) continue;
        const w = sweepFor(rule, st.sweeps[a.pool] ?? [], m.atMs);
        if (w === null) { unsweptMinutes++; continue; }
        const share = sharesInPool(m.entries.map((x) => x.score), w.othersMost)[i];
        const c = credits.find((x) => x.kind === w.kind && x.share === share);
        if (c) c.minutes++;
        else credits.push({ minutes: 1, share, kind: w.kind });
      }
      rows.push(row(s, {
        day: a.day, event: a.event, symbol: a.symbol, pair: a.pair, tiedUpMicros: a.tiedUpMicros, poolMicrosADay: a.poolMicrosADay,
        minutes: a.minutes, makersNextList: p ? p.makers : null, fills: a.fills, mark: a.fills.length > 0 ? { result: null, last } : null,
        credits, unsweptMinutes, ruleHash: st.ruleHash,
      }));
      delete st.open[k];
    }
    // A mark is kept while any row it counts for is still open.
    for (const pool of Object.keys(st.marks)) {
      st.marks[pool] = st.marks[pool].filter((m) => m.entries.some((x) => x.key !== null && st.open[x.key] !== undefined));
      if (st.marks[pool].length === 0) delete st.marks[pool];
    }
  }

  // 7. The chain: the pass row, then the market rows.
  const lines: string[] = [];
  for (const x of [pr, ...rows]) {
    const text = JSON.stringify(x);
    st.chainHex = chain(st.chainHex, text);
    lines.push(JSON.stringify({ row: x, head: st.chainHex }));
  }
  st.lastPassMs = nowMs;
  return { decisions, fills, rows, passRow: pr, lines, state: st };
}
