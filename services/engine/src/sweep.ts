// The sweep: at most `sweepsADay` times a day, and never before `noSizeBeforeMs`, the book of every
// contract that could hold a qualifying pair in each pool where a quote stands, read one at a time.
// Its figure for a pool is the most the others can be scoring across the pool's books (design 1.1
// section 4, item 4). A pool gets no figure where anything it needs was not read whole.
//
// Every book goes through the reader the caller hands in; nothing here asks anything of its own.

import type { Rule } from "@app/rule";
import { noneFromPrices, poolOthersMost, type Book, type Pair, type Settings } from "@app/score";
import { Stopped, type PoolRow } from "./gemini.ts";
import type { EngineState, Lists } from "./pass.ts";

export type SweepPlan = { symbols: string[]; byPool: Record<string, { symbols: string[]; complete: boolean }>; pairs?: Record<string, Pair> };

/** Due from the hub's instant on, and a day over `sweepsADay` after the last sweep. */
export function sweepDue(rule: Rule, sweptAtMs: number[], nowMs: number): boolean {
  if (!(nowMs >= rule.noSizeBeforeMs)) return false;
  const last = sweptAtMs.length > 0 ? Math.max(...sweptAtMs) : null;
  return last === null || nowMs - last >= 86_400_000 / rule.sweepsADay;
}

/**
 * The books to read: in each pool where a quote stands, every contract narrow enough on the list to
 * hold a qualifying pair, every contract of a live event (its list prices do not stand for its
 * book), and every contract the reader could not read but could name. A pool is complete only when
 * the list gave all the events it counts, each with a contract, and every unread contract has a name.
 */
export function sweepPlan(s: Settings, st: EngineState, lists: Lists): SweepPlan {
  const poolOf = new Map<string, PoolRow>(lists.pools.rows.map((r) => [r.ticker, r]));
  const wanted = new Set(Object.values(st.standing).map((q) => q.pool));
  const byPool: SweepPlan["byPool"] = {};
  const seen = new Map<string, number>();
  for (const key of [...wanted].sort()) {
    const events = lists.events.filter((e) => poolOf.get(e.ticker)?.poolKey === key);
    const count = events.length > 0 ? poolOf.get(events[0].ticker)!.poolEventCount : 0;
    const symbols: string[] = [];
    let complete = events.length > 0 && events.length === count;
    for (const e of events) {
      if (e.contracts.length === 0 && e.unread.length === 0) complete = false; // an event with no contract proves nothing (audit 2, finding 7)
      for (const c of e.contracts) if (e.live || !noneFromPrices(s, c.top)) symbols.push(c.symbol);
      for (const u of e.unread) {
        if (u === "") complete = false;
        else symbols.push(u);
      }
    }
    byPool[key] = { symbols, complete };
    for (const x of symbols) seen.set(x, 1);
  }
  const pairs: Record<string, Pair> = {};
  for (const q of Object.values(st.standing)) pairs[q.symbol] = q.pair;
  return { symbols: [...seen.keys()], byPool, pairs };
}

/** Each pool's figure from the books read: none where its plan was not complete or any of its books is missing or unread. A book where our pair stands is scored at the midpoint the pair gives it. */
export function sweepFigures(s: Settings, plan: SweepPlan, books: Map<string, Book | null>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [key, p] of Object.entries(plan.byPool)) {
    const got = p.symbols.map((x) => books.get(x));
    out[key] = !p.complete || got.some((b) => b === undefined || b === null) ? null : poolOthersMost(s, p.symbols.map((x, i) => ({ book: got[i] as Book, pair: plan.pairs?.[x] })));
  }
  return out;
}

/** Reads the plan's books one after another, `sweepApartMs` between the sends, keeping each raw through `onBook`. A 429 ends the sweep; the pools it did not finish get no figure. Any other error ends it the same way. */
export async function runSweep(
  r: { book(symbol: string, notBeforeMs: number): Promise<Book | null> },
  rule: Rule,
  s: Settings,
  plan: SweepPlan,
  d: { sleep(ms: number): Promise<void>; nowMs(): number },
  onBook: (symbol: string, book: Book | null) => void = () => {},
): Promise<{ atMs: number; figures: Record<string, number | null>; stopped: boolean }> {
  const atMs = d.nowMs();
  const books = new Map<string, Book | null>();
  let stopped = false;
  let lastSentMs: number | null = null;
  for (const symbol of plan.symbols) {
    if (lastSentMs !== null) {
      const gap = lastSentMs + rule.sweepApartMs - d.nowMs();
      if (gap > 0) await d.sleep(gap);
    }
    lastSentMs = d.nowMs();
    try {
      const b = await r.book(symbol, rule.noSizeBeforeMs);
      books.set(symbol, b);
      onBook(symbol, b);
    } catch (e) {
      stopped = true;
      if (!(e instanceof Stopped)) onBook(symbol, null);
      break;
    }
  }
  return { atMs, figures: sweepFigures(s, plan, books), stopped };
}

/** The state with a finished sweep added under each pool it gave a figure or none to. */
export function addSweep(before: EngineState, atMs: number, figures: Record<string, number | null>): EngineState {
  const st = structuredClone(before);
  for (const [key, othersMost] of Object.entries(figures)) (st.sweeps[key] ??= []).push({ atMs, othersMost });
  st.sweptAtMs.push(atMs);
  return st;
}
