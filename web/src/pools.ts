// The screen at pool level (design 1.2, section 4): Gemini's program pool by pool, where nobody
// can be qualifying this minute, and each sport pool's week of passes. Pure: the same inputs the
// engine reads, so the operator's screen (from the engine's recorded answers) and the public page
// (from the visitor's own browser) work it out alike.
import { poolCount, type PassRow, type PoolCount } from "@app/ledger";
import { eventState, minuteShareMicros, type Settings, type State, type Top } from "@app/score";
import type { ListedEvent, PoolRow, Pools } from "../../services/engine/src/gemini.ts";

const HOUR = 3_600_000;
const WEEK_HOURS = 7 * 24;

/** `readAtMs`, by pool key: when a pool's events and books were read on their own (a pool opened, or the
 * read of every pool). Such a pool's prices are as old as that read, not as new as the lists. */
export type ScreenIn = { settings: Settings; pools: Pools; events: ListedEvent[]; eventsAtMs: number; passes: PassRow[]; readAtMs?: Record<string, number> };

export type EventView = {
  ticker: string; title: string; startMs: number;
  state: State | "in-play" | "unread";
  makers: number; // the list's count of qualifying makers on its last scored day
  contracts: { symbol: string; top: Top; none: boolean }[]; // none: this contract cannot hold a qualifying pair, from prices
};

/** One hour of a pool's record: how many passes read it, in how many nobody could be qualifying (from prices or sizes), in how many somebody may have been. */
export type StripCell = { startMs: number; endMs: number; passes: number; none: number; may: number };

export type PoolView = {
  key: string; name: string; categories: string[];
  microsADay: number; claimed: boolean; // claimed: the list counted a qualifying maker in some event of it on its last scored day
  makers: number; // the largest count of qualifying makers the list gives any event of it
  read: boolean; // some event of it has been read; false for a pool known from the reward list alone
  count: PoolCount; pricesAgeMs: number;
  events: EventView[]; strip: StripCell[];
};

export type Screen = {
  first: { noMaker: number; of: number; lastScoreDate: string | null };
  now: { none: number; of: number; live: number };
  program: { pools: number; microsADay: number };
  gap: { pools: number; microsAMinute: number; claimed: number };
  pricesAgeMs: number;
  sport: PoolView[];
};

const RANK: Record<State, number> = { "none-prices": 0, "none-sizes": 1, may: 2 };

export function screenOf(a: ScreenIn, nowMs: number): Screen {
  const s = a.settings;
  const rowOf = new Map<string, PoolRow>(a.pools.rows.map((r) => [r.ticker, r]));
  const byPool = new Map<string, PoolRow[]>();
  for (const r of a.pools.rows) byPool.set(r.poolKey, [...(byPool.get(r.poolKey) ?? []), r]);
  // A pool's amount, counted once: the smallest its rows give, so a disagreement never adds to it.
  const amount = (rows: PoolRow[]) => Math.min(...rows.map((r) => r.poolMicrosADay));

  const listedOf = new Map<string, ListedEvent[]>();
  for (const e of a.events) {
    const r = rowOf.get(e.ticker);
    if (r !== undefined) listedOf.set(r.poolKey, [...(listedOf.get(r.poolKey) ?? []), e]);
  }
  const pricesAgeMs = nowMs - a.eventsAtMs;

  // Every pool of the reward list is a row. Until 2026-11-18 only pools with an event on the active
  // Sports list were; that list then stopped giving the season-long markets the reward list names,
  // so a pool's events are read by ticker when it is opened and a pool not yet read is still shown.
  const sport: PoolView[] = [...byPool].map(([key, rows]) => {
    const events = listedOf.get(key) ?? [];
    const count = poolCount(s, key, rows[0].poolEventCount, events.map((e) => ({ live: e.live, unread: e.unread.length, contracts: e.contracts.map((c) => ({ top: c.top })) })));
    return {
      key, name: rows[0].poolName ?? rows[0].title, categories: [...new Set(rows.map((r) => r.category))],
      microsADay: amount(rows), claimed: rows.some((r) => r.makers > 0), makers: Math.max(...rows.map((r) => r.makers)), read: events.length > 0, count, pricesAgeMs: a.readAtMs?.[key] !== undefined ? nowMs - a.readAtMs[key] : pricesAgeMs,
      events: events.map((e) => eventView(s, e, rowOf.get(e.ticker)!)),
      strip: stripOf(key, a.passes, nowMs),
    };
  });
  sport.sort((x, y) => Number(y.read) - Number(x.read) || RANK[x.count.state] - RANK[y.count.state] || y.microsADay - x.microsADay || (x.key < y.key ? -1 : 1));

  const sportRows = a.pools.rows.filter((r) => listedOf.has(r.poolKey));
  const scored = a.events.filter((e) => rowOf.has(e.ticker));
  const notLive = scored.filter((e) => !e.live);
  const gapPools = sport.filter((p) => p.count.state === "none-prices");
  return {
    first: { noMaker: sportRows.filter((r) => r.makers === 0).length, of: sportRows.length, lastScoreDate: a.pools.lastScoreDate },
    now: { none: notLive.filter((e) => e.unread.length === 0 && eventState(s, e.contracts.map((c) => ({ top: c.top }))) === "none-prices").length, of: notLive.length, live: scored.length - notLive.length },
    program: { pools: byPool.size, microsADay: [...byPool.values()].reduce((n, rows) => n + amount(rows), 0) },
    gap: { pools: gapPools.length, microsAMinute: gapPools.reduce((n, p) => n + minuteShareMicros(p.microsADay), 0), claimed: gapPools.filter((p) => p.claimed).length },
    pricesAgeMs,
    sport,
  };
}

function eventView(s: Settings, e: ListedEvent, r: PoolRow): EventView {
  const contracts = e.contracts.map((c) => ({ symbol: c.symbol, top: c.top, none: eventState(s, [{ top: c.top }]) === "none-prices" }));
  const state: EventView["state"] = e.live ? "in-play" : e.unread.length > 0 || e.contracts.length === 0 ? "unread" : eventState(s, e.contracts.map((c) => ({ top: c.top })));
  return { ticker: e.ticker, title: e.title, startMs: e.startMs, state, makers: r.makers, contracts };
}

/** The week before `nowMs` in hourly cells, the last ending at the next whole hour. */
function stripOf(key: string, passes: PassRow[], nowMs: number): StripCell[] {
  const end = Math.ceil((nowMs + 1) / HOUR) * HOUR;
  const start = end - WEEK_HOURS * HOUR;
  const cells: StripCell[] = Array.from({ length: WEEK_HOURS }, (_, i) => ({ startMs: start + i * HOUR, endMs: start + (i + 1) * HOUR, passes: 0, none: 0, may: 0 }));
  for (const p of passes) {
    if (p.atMs < start || p.atMs >= end) continue;
    const c = p.pools.find((x) => x.pool === key);
    if (c === undefined) continue;
    const cell = cells[Math.floor((p.atMs - start) / HOUR)];
    cell.passes++;
    if (c.state === "may") cell.may++;
    else cell.none++;
  }
  return cells;
}
