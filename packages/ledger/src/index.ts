// The ledger's rules: when a quote that was only written down counts as filled, what a filled
// position is worth, which minutes earn a share of a pool, and a row's figures.
//
// Nothing here asks anybody anything. No order exists: a "fill" is a rule applied to two reads.
// Every rule is set against the quote where the reads leave a doubt. The reward is by the text
// of the exchange's rules and is observed in no account; `row` always gives the net at half of
// it beside the net at all of it.
//
// A "pool" here is whatever the caller says shares one day's dollars (design 1.2: one of the list's
// pool ids, or an event with its own amount). The reward column is design 1.1's: each counted minute
// takes our share of the pool's minute against the most the others can be scoring in every book of
// the pool, at the least share found by the nearest sweep of whole books ("least" within one read of
// it, "estimate" further off); a minute with no swept figure counts nothing. Design 1.0's reading,
// every counted minute at the whole pool, is kept beside it as `readingOne` and is in no net.
//
// Prices are whole cents, money whole millionths of a dollar, times milliseconds.

import { worstLossMicros, type Rule } from "@app/rule";
import { eventState, poolState, type Level, type Pair, type PoolEvent, type Settings, type State, type Top } from "@app/score";

const MINUTE = 60_000;
const SNAPSHOTS_A_DAY = 24 * 60; // the most a day can hold, one a minute
const CENT = 10_000; // in millionths of a dollar

/** A quote written down at one read; it stands until the next. */
export type Standing = { event: string; symbol: string; pair: Pair; sinceMs: number };
/** What a read saw: the contract's best prices from every account, and the event's volume. */
export type Seen = { atMs: number; top: Top; eventVolume: number | null };
/** A fill and the rule that counted it. The price is the pair's; `worse` is whichever side is worse at the marking. */
export type Fill = { event: string; symbol: string; atMs: number; by: "reached" | "traded"; side: "bid" | "ask" | "worse"; qty: number };

/** What the event's volume says between two reads. A fall or a missing figure says nothing: it is not proof that nothing traded. */
export function volumeSays(before: Seen, now: Seen): "rose" | "level" | "nothing" {
  if (before.eventVolume === null || now.eventVolume === null || now.eventVolume < before.eventVolume) return "nothing";
  return now.eventVolume > before.eventVolume ? "rose" : "level";
}

/**
 * The fill, if any, of a quote that stood from one read to the next, however far apart they are.
 * Traded: a rise in the event's volume fills one side, the worse one, whether or not a price was
 * also reached (the worse side is never better than the reached one). Reached: other people's
 * best ask within the margin of the bid, or lower, fills the bid; the same for the ask against
 * their best bid; both at once, which only a crossed answer gives, is the worse of the two.
 */
export function fillAt(rule: Rule, q: Standing, before: Seen, now: Seen): Fill | null {
  const { bid, ask } = q.pair;
  const bidReached = now.top.askCents !== null && now.top.askCents <= bid.cents + rule.reachedMarginCents;
  const askReached = now.top.bidCents !== null && now.top.bidCents >= ask.cents - rule.reachedMarginCents;
  const made = (by: Fill["by"], side: Fill["side"]): Fill => ({ event: q.event, symbol: q.symbol, atMs: now.atMs, by, side, qty: side === "bid" ? bid.qty : side === "ask" ? ask.qty : Math.max(bid.qty, ask.qty) });
  if (volumeSays(before, now) === "rose") return made("traded", "worse");
  if (bidReached || askReached) return made("reached", bidReached && askReached ? "worse" : bidReached ? "bid" : "ask");
  return null;
}

/** A contract's result where the list gives one (1 when it paid, 0 when it did not), and other people's best prices at the last read. */
export type Mark = { result: 0 | 1 | null; last: Top };

/**
 * What a fill has made or lost. Held to the result where there is one. Otherwise at the other
 * side's price at the last read, never the midpoint: what a long could be sold for, what a short
 * could be bought back for; with no price there, nothing for a long and the whole dollar for a
 * short. A last read whose ask is at or below its bid is a bad answer and is no price on either side.
 */
export function markMicros(fill: Fill, pair: Pair, m: Mark): number {
  const bad = m.last.bidCents !== null && m.last.askCents !== null && m.last.askCents <= m.last.bidCents;
  const sellAt = bad ? 0 : (m.last.bidCents ?? 0), buyBackAt = bad ? 100 : (m.last.askCents ?? 100);
  const long = (b: Level) => ((m.result !== null ? m.result * 100 : sellAt) - b.cents) * b.qty * CENT;
  const short = (a: Level) => (a.cents - (m.result !== null ? m.result * 100 : buyBackAt)) * a.qty * CENT;
  if (fill.side === "bid") return long(pair.bid);
  if (fill.side === "ask") return short(pair.ask);
  return Math.min(long(pair.bid), short(pair.ask));
}

/** The same quote: the same two prices and sizes. No quote is never the same quote. */
export function samePair(a: Pair | null, b: Pair | null): boolean {
  return a !== null && b !== null && a.bid.cents === b.bid.cents && a.bid.qty === b.bid.qty && a.ask.cents === b.ask.cents && a.ask.qty === b.ask.qty;
}

/**
 * The minutes that count between two reads: the minute marks after the first and up to the
 * second, when the same quote stood and was accepted at both (`quoted`), nobody else could be
 * qualifying in its pool at both (`alone`), and the reads are no more than one read and a minute
 * apart. Never more than one read's worth. A longer gap counts nothing.
 */
export function minutesCounted(rule: Rule, before: { atMs: number; quoted: boolean; alone: boolean }, now: { atMs: number; quoted: boolean; alone: boolean }): number {
  return minuteMarks(rule, before, now).length;
}

/** The minute marks `minutesCounted` counts, oldest first: the last ones when one read's worth caps them. */
export function minuteMarks(rule: Rule, before: { atMs: number; quoted: boolean; alone: boolean }, now: { atMs: number; quoted: boolean; alone: boolean }): number[] {
  if (!before.quoted || !now.quoted || !before.alone || !now.alone) return [];
  const gap = now.atMs - before.atMs;
  if (!(gap > 0) || gap > rule.readEveryMs + MINUTE) return []; // also a time that is not a number
  const last = Math.floor(now.atMs / MINUTE);
  const n = Math.min(last - Math.floor(before.atMs / MINUTE), Math.floor(rule.readEveryMs / MINUTE));
  return Array.from({ length: n }, (_, i) => (last - n + 1 + i) * MINUTE);
}

/** One pool's figure at one sweep: the most the others can be scoring across its books, or no figure where a book was not read whole. */
export type Sweep = { atMs: number; othersMost: number | null };

/**
 * The sweep a minute mark is counted at: the nearest one, before or after, that has a figure for
 * the pool, the earlier on a tie. "least" within one read of it, "estimate" further off. Null when
 * no sweep has a figure: the minute is unswept and counts nothing.
 */
export function sweepFor(rule: Rule, sweeps: Sweep[], markMs: number): { othersMost: number; kind: "least" | "estimate" } | null {
  let best: Sweep | null = null;
  for (const w of sweeps) {
    if (!Number.isFinite(w.atMs)) throw new Error("ledger: a sweep's time is not a number");
    if (w.othersMost === null) continue;
    const d = Math.abs(w.atMs - markMs);
    if (best === null || d < Math.abs(best.atMs - markMs) || (d === Math.abs(best.atMs - markMs) && w.atMs < best.atMs)) best = w;
  }
  if (best === null) return null;
  return { othersMost: best.othersMost!, kind: Math.abs(best.atMs - markMs) <= rule.readEveryMs ? "least" : "estimate" };
}

/** Minutes counted at one share of the pool's minute, and whether that share was found at a sweep or is an estimate between sweeps. */
export type Credit = { minutes: number; share: number; kind: "least" | "estimate" };

/**
 * A pool-day's reward by share, by the text of the exchange's rules: the pool over the most
 * snapshots a day can hold, times the sum of each credit's minutes times its share, the sum
 * rounded down to the cent once, and nothing under the least payout. With every share whole it is
 * `rewardByTextMicros`. Observed in no account.
 */
export function rewardByShareMicros(s: Settings, poolMicrosADay: number, credits: Credit[]): number {
  if (!Number.isFinite(poolMicrosADay) || poolMicrosADay < 0) throw new Error("ledger: the pool is not a plain figure of none or more");
  let weighted = 0;
  for (const c of credits) {
    if (!Number.isInteger(c.minutes) || c.minutes < 0) throw new Error("ledger: the minutes are not a whole number of none or more");
    if (!Number.isFinite(c.share) || c.share < 0 || c.share > 1) throw new Error("ledger: a share is not a figure from none to one");
    if (c.kind !== "least" && c.kind !== "estimate") throw new Error("ledger: a credit's kind is neither least nor estimate");
    weighted += c.minutes * c.share;
  }
  const micros = Math.floor((poolMicrosADay * Math.min(weighted, SNAPSHOTS_A_DAY)) / (SNAPSHOTS_A_DAY * CENT)) * CENT;
  return micros < s.minPayoutMicros ? 0 : micros;
}

/**
 * A pool-day's reward by the text of the exchange's rules, for a quote that stood alone for
 * `minutes` of it: the pool over the most snapshots a day can hold, times the minutes, the sum
 * rounded down to the cent, and nothing under the least payout. Observed in no account.
 */
export function rewardByTextMicros(s: Settings, poolMicrosADay: number, minutes: number): number {
  if (!Number.isFinite(poolMicrosADay) || poolMicrosADay < 0) throw new Error("ledger: the pool is not a plain figure of none or more");
  if (!Number.isInteger(minutes) || minutes < 0) throw new Error("ledger: the minutes are not a whole number of none or more");
  const micros = Math.floor((poolMicrosADay * Math.min(minutes, SNAPSHOTS_A_DAY)) / (SNAPSHOTS_A_DAY * CENT)) * CENT;
  return micros < s.minPayoutMicros ? 0 : micros;
}

/**
 * What a pool-day's reward is counted as: the figure by the text only once the next day's list
 * has shown that no maker qualified in the pool. A maker shown there makes it nothing, and so
 * does a list not yet seen (`null`): until then the figure waits and is in no net.
 */
export function dayRewardMicros(s: Settings, poolMicrosADay: number, minutes: number, makersNextList: number | null): number {
  if (makersNextList !== null && (!Number.isInteger(makersNextList) || makersNextList < 0)) throw new Error("ledger: the maker count is not a whole number of none or more");
  const byText = rewardByTextMicros(s, poolMicrosADay, minutes);
  return makersNextList === 0 ? byText : 0;
}

/** `minutes` is every counted minute: those in `credits` and the `unsweptMinutes` that had no swept figure. */
export type RowIn = {
  day: string; event: string; symbol: string; pair: Pair; tiedUpMicros: number; poolMicrosADay: number; minutes: number; makersNextList: number | null; fills: Fill[]; mark: Mark | null;
  credits: Credit[]; unsweptMinutes: number; ruleHash: string;
};
export type Row = {
  kind: "market"; ruleHash: string;
  day: string; event: string; symbol: string; tiedUpMicros: number; minutes: number;
  leastMinutes: number; estimateMinutes: number; unsweptMinutes: number;
  rewardMicros: number; halfRewardMicros: number; fills: Fill[]; markMicros: number;
  netMicros: number; netAtHalfMicros: number; losingFillsCovered: number;
  /** The next day's list has not shown a count yet: the reward is counted as nothing and `rewardWaitingMicros` is what it would be by the text. */
  rewardProvisional: boolean;
  rewardWaitingMicros: number;
  /** A fill is marked at the last read because the list gives no result yet. */
  markAtLastRead: boolean;
  /** Design 1.0's reading: every counted minute at the whole pool, as if each event were a pool of its own, behind the same wait for the next list. Shown smaller; in no net; never summed across the rows of a shared pool as pay (two rows of one pool would each claim it all). */
  readingOne: { micros: number; waitingMicros: number };
};

const HEX64 = /^[0-9a-f]{64}$/;

/** One market's row for one of the exchange's days. The net is the reward and the mark together, at all of the reward and at half of it. */
export function row(s: Settings, r: RowIn): Row {
  if (r.fills.length > 0 && r.mark === null) throw new Error("ledger: a fill with no mark");
  if (!HEX64.test(r.ruleHash)) throw new Error("ledger: the rule hash is not one");
  if (!Number.isInteger(r.unsweptMinutes) || r.unsweptMinutes < 0) throw new Error("ledger: the unswept minutes are not a whole number of none or more");
  for (const c of r.credits) if (c.kind !== "least" && c.kind !== "estimate") throw new Error("ledger: a credit's kind is neither least nor estimate");
  const sum = (kind: Credit["kind"]) => r.credits.reduce((n, c) => (c.kind === kind ? n + c.minutes : n), 0);
  const leastMinutes = sum("least"), estimateMinutes = sum("estimate");
  if (leastMinutes + estimateMinutes + r.unsweptMinutes !== r.minutes) throw new Error("ledger: the minutes are not the credited and the unswept minutes together");
  if (r.makersNextList !== null && (!Number.isInteger(r.makersNextList) || r.makersNextList < 0)) throw new Error("ledger: the maker count is not a whole number of none or more");
  const byShare = rewardByShareMicros(s, r.poolMicrosADay, r.credits);
  const rewardMicros = r.makersNextList === 0 ? byShare : 0;
  const mark = r.fills.reduce((n, f) => n + markMicros(f, r.pair, r.mark!), 0);
  const worst = worstLossMicros(r.pair);
  return {
    kind: "market", ruleHash: r.ruleHash,
    day: r.day, event: r.event, symbol: r.symbol, tiedUpMicros: r.tiedUpMicros, minutes: r.minutes,
    leastMinutes, estimateMinutes, unsweptMinutes: r.unsweptMinutes,
    rewardMicros, halfRewardMicros: rewardMicros / 2, fills: r.fills, markMicros: mark,
    netMicros: rewardMicros + mark, netAtHalfMicros: rewardMicros / 2 + mark,
    losingFillsCovered: worst > 0 ? Math.floor(rewardMicros / worst) : 0,
    rewardProvisional: r.makersNextList === null,
    rewardWaitingMicros: r.makersNextList === null ? byShare : 0,
    markAtLastRead: r.fills.length > 0 && r.mark!.result === null,
    readingOne: {
      micros: dayRewardMicros(s, r.poolMicrosADay, r.minutes, r.makersNextList),
      waitingMicros: r.makersNextList === null ? rewardByTextMicros(s, r.poolMicrosADay, r.minutes) : 0,
    },
  };
}

/** One pool's count at one pass: the program's record (design 1.2 section 4, item 3). Each event is counted once. */
export type PoolCount = { pool: string; eventCount: number; listed: number; live: number; unread: number; nonePrices: number; noneSizes: number; may: number; state: State };

/**
 * A pool's count from the events the list gave it: each event in the first of live (its list
 * prices do not stand for its book), unread (a contract the reader could not read, or no contract
 * at all), none from prices, none from sizes, may. The pool's state is the whole-pool test.
 */
export function poolCount(s: Settings, pool: string, eventCount: number, events: PoolEvent[]): PoolCount {
  const c = { live: 0, unread: 0, nonePrices: 0, noneSizes: 0, may: 0 };
  for (const e of events) {
    if (e.live) c.live++;
    else if (e.unread !== 0 || e.contracts.length === 0) c.unread++; // a count that is not plainly none is counted unread
    else {
      const st = eventState(s, e.contracts);
      if (st === "none-prices") c.nonePrices++;
      else if (st === "none-sizes") c.noneSizes++;
      else c.may++;
    }
  }
  return { pool, eventCount, listed: events.length, ...c, state: poolState(s, eventCount, events) };
}

/** One pass's row: the time, the exchange's day, the rule's hash, each pool's count, and what the events' volumes said since the last pass. It is chained like a market row. */
export type PassRow = { kind: "pass"; atMs: number; day: string; ruleHash: string; pools: PoolCount[]; volume: { rose: number; level: number; nothing: number } };

export function passRow(s: Settings, a: { atMs: number; ruleHash: string; pools: { pool: string; eventCount: number; events: PoolEvent[] }[]; volume: PassRow["volume"] }): PassRow {
  if (!Number.isFinite(a.atMs)) throw new Error("ledger: the time of the pass is not a number");
  if (!HEX64.test(a.ruleHash)) throw new Error("ledger: the rule hash is not one");
  for (const n of [a.volume.rose, a.volume.level, a.volume.nothing]) if (!Number.isInteger(n) || n < 0) throw new Error("ledger: a volume count is not a whole number of none or more");
  return {
    kind: "pass", atMs: a.atMs, day: geminiDay(a.atMs), ruleHash: a.ruleHash,
    pools: a.pools.map((p) => poolCount(s, p.pool, p.eventCount, p.events)),
    volume: { rose: a.volume.rose, level: a.volume.level, nothing: a.volume.nothing },
  };
}

const EASTERN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The exchange's day an instant falls in, named for the Eastern date it ends on: the day runs
 * from 5:00:00 pm to 4:59:59 pm Eastern. Seven hours on from 5 pm is midnight, and the clocks
 * change at 2 am, so the date seven hours on is the date the day ends on.
 */
export function geminiDay(atMs: number): string {
  const parts = Object.fromEntries(EASTERN.formatToParts(new Date(atMs + 7 * 60 * MINUTE)).map((p) => [p.type, p.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}
