// The one decision function: which pools to quote, at what prices, and why not the rest.
//
// Nothing here asks anybody anything and nothing here places an order. The figures that are ours
// arrive in `Rule`, read from `settings/rule.json`; the exchange's arrive in `Settings`.
//
// Prices are whole cents, midpoints doubled, money in whole millionths of a dollar, times in
// milliseconds. A contract's log is its best prices at each read, oldest first.

import { eventState, widestPair, type Book, type Pair, type Settings, type Top } from "@app/score";

export type Rule = {
  maxOthersSpreadCents: number; // other people's spread, at most
  tendedWithinMs: number; // one of their best prices changed within this long
  stillCents: number; // their midpoint moved less than this ...
  stillOverMs: number; // ... over this long, with both sides there at every read
  pullBeforeStartMs: number; // no quote this close to the start
  capPerMarketMicros: number; // the most one market may lose
  drawMicros: number; // the money the rule may tie up
  bondMicros: number; // the operator's bond behind it
  reachedMarginCents: number; // the fill rule's margin (used by the ledger)
  readEveryMs: number; // how far apart the reads are
  sweepsADay: number; // the most sweeps of whole books in a day (the hub's limit: four)
  sweepApartMs: number; // the least time between two book requests of a sweep (the hub's limit: 1.2 seconds)
  noSizeBeforeMs: number; // no book is read before this instant (the hub's limit: 2026-11-17T06:00:00Z)
};

const FIGURES = ["maxOthersSpreadCents", "tendedWithinMs", "stillCents", "stillOverMs", "pullBeforeStartMs", "capPerMarketMicros", "drawMicros", "bondMicros", "reachedMarginCents", "readEveryMs", "sweepsADay", "sweepApartMs", "noSizeBeforeMs"] as const;

/** The settings file as the rule uses it. Throws unless it holds exactly the rule's figures, each a whole positive number, a draw of at most twice the bond, and the hub's limits on the sweep. */
export function readRule(json: unknown): Rule {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("rule: the settings are not an object");
  const given = json as Record<string, unknown>;
  for (const name of Object.keys(given)) if (!(FIGURES as readonly string[]).includes(name)) throw new Error("rule: " + name + " is not a figure of the rule");
  const rule = {} as Rule;
  for (const name of FIGURES) {
    const v = given[name];
    if (v === undefined) throw new Error("rule: " + name + " is missing");
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("rule: " + name + " is not a whole positive figure");
    rule[name] = v;
  }
  if (rule.drawMicros > 2 * rule.bondMicros) throw new Error("rule: the draw is more than twice the bond");
  if (rule.sweepsADay > 4) throw new Error("rule: sweepsADay is more than four");
  if (rule.sweepApartMs < 1_200) throw new Error("rule: sweepApartMs is less than 1.2 seconds");
  if (rule.noSizeBeforeMs < Date.UTC(2026, 10, 17, 6, 0, 0)) throw new Error("rule: noSizeBeforeMs is before the hub's instant, 2026-11-17T06:00:00Z");
  return rule;
}

export type Read = { atMs: number; top: Top };
export type ContractIn = { symbol: string; stepCents: number; log: Read[]; book?: Book };
export type EventIn = { ticker: string; startMs: number; live: boolean; poolMicrosADay: number | null; makersLastDay: number | null; volume: number | null; contracts: ContractIn[] };
export type Reason = "quote" | "no-pool" | "makers-last-day" | "others-may-qualify" | "live-or-pulled" | "one-sided" | "short-log" | "untended" | "moving" | "too-wide" | "outside-cap" | "not-nearest" | "filled" | "no-money";
export type Decision = { event: string; symbol: string | null; pair: Pair | null; reason: Reason };
export type Held = { filled: Set<string>; tiedUpMicros: number; quoted: Set<string> };

const twoSided = (t: Top) => t.bidCents !== null && t.askCents !== null && t.askCents > t.bidCents;
const same = (a: Top, b: Top) => a.bidCents === b.bidCents && a.askCents === b.askCents;

/** The contract's best prices at this read, or null when its last read is more than two reads old. */
function topNow(rule: Rule, c: ContractIn, nowMs: number): Top | null {
  const last = c.log[c.log.length - 1];
  return last === undefined || nowMs - last.atMs > 2 * rule.readEveryMs ? null : last.top;
}

/**
 * The four tests on other people's prices in one contract, in this order: two sides at every read
 * of the last hour, a log that covers that hour, a spread narrow enough now, a midpoint that kept
 * still over the hour, and a quote somebody changed within the day. "quote" when all pass.
 */
export function priceTests(rule: Rule, c: ContractIn, nowMs: number): Reason {
  const now = topNow(rule, c, nowMs);
  if (now === null) return "short-log";
  const from = nowMs - rule.stillOverMs;
  const first = c.log.findIndex((r) => r.atMs >= from); // the hour's first read; there is one, the last read
  const hour = c.log.slice(first);
  if (hour.some((r) => !twoSided(r.top))) return "one-sided";
  // The log covers the hour when it starts at or before it and no two reads from there on are more than two reads apart.
  if (c.log[0].atMs > from) return "short-log";
  for (let i = Math.max(first, 1); i < c.log.length; i++) if (c.log[i].atMs - c.log[i - 1].atMs > 2 * rule.readEveryMs) return "short-log";
  if (now.askCents! - now.bidCents! > rule.maxOthersSpreadCents) return "too-wide";
  const mids = hour.map((r) => r.top.bidCents! + r.top.askCents!);
  if (Math.max(...mids) - Math.min(...mids) >= 2 * rule.stillCents) return "moving";
  const since = nowMs - rule.tendedWithinMs;
  for (let i = c.log.length - 1; i >= 1 && c.log[i].atMs >= since; i--) if (!same(c.log[i].top, c.log[i - 1].top)) return "quote";
  return "untended";
}

/** What a pair ties up: the bid's cost and the other side of the ask. */
export function tiedUpMicros(pair: Pair): number {
  return (pair.bid.cents * pair.bid.qty + (100 - pair.ask.cents) * pair.ask.qty) * 10_000;
}

/** The most a pair can lose when one side is filled and the result goes against it. */
export function worstLossMicros(pair: Pair): number {
  return Math.max(pair.bid.cents * pair.bid.qty, (100 - pair.ask.cents) * pair.ask.qty) * 10_000;
}

/**
 * One decision for every event with no contract to name, and one for each contract otherwise, in
 * the order given. An event is quoted in one contract, the passing one nearest fifty cents, and
 * only where no maker can be qualifying in any of its contracts at this read. The money goes to
 * events quoted at the last read first, then to the larger pool, then to the later start.
 */
export function decide(rule: Rule, s: Settings, events: EventIn[], held: Held, nowMs: number): Decision[] {
  const out: Decision[] = [];
  const wanting: { at: number; e: EventIn; pair: Pair }[] = [];
  for (const e of events) {
    const whole = (reason: Reason) => void out.push({ event: e.ticker, symbol: null, pair: null, reason });
    if (e.contracts.some((c) => held.filled.has(c.symbol))) { whole("filled"); continue; }
    if (e.poolMicrosADay === null || e.poolMicrosADay <= 0) { whole("no-pool"); continue; }
    if ((e.makersLastDay ?? 0) > 0) { whole("makers-last-day"); continue; }
    if (e.live || e.startMs - nowMs <= rule.pullBeforeStartMs) { whole("live-or-pulled"); continue; }
    const tops = e.contracts.map((c) => topNow(rule, c, nowMs));
    // A contract with no read at this pass proves nothing, so somebody may be qualifying in it.
    if (tops.some((t) => t === null) || eventState(s, e.contracts.map((c, i) => ({ top: tops[i]!, book: c.book }))) === "may") { whole("others-may-qualify"); continue; }
    let nearest: { at: number; pair: Pair; off: number } | null = null;
    e.contracts.forEach((c, i) => {
      let reason = priceTests(rule, c, nowMs);
      const pair = reason === "quote" ? widestPair(s, tops[i]!, c.stepCents) : null;
      if (reason === "quote" && (pair === null || worstLossMicros(pair) > rule.capPerMarketMicros)) reason = "outside-cap";
      const at = out.push({ event: e.ticker, symbol: c.symbol, pair: null, reason }) - 1;
      if (reason !== "quote") return;
      const off = Math.abs(tops[i]!.bidCents! + tops[i]!.askCents! - 100);
      if (nearest === null || off < nearest.off) {
        if (nearest !== null) out[nearest.at].reason = "not-nearest";
        nearest = { at, pair: pair!, off };
      } else out[at].reason = "not-nearest";
    });
    if (nearest !== null) wanting.push({ at: (nearest as { at: number }).at, e, pair: (nearest as { pair: Pair }).pair });
  }
  const kept = (w: { e: EventIn }) => Number(held.quoted.has(w.e.ticker));
  wanting.sort((a, b) => kept(b) - kept(a) || b.e.poolMicrosADay! - a.e.poolMicrosADay! || b.e.startMs - a.e.startMs || (a.e.ticker < b.e.ticker ? -1 : 1));
  let left = rule.drawMicros - held.tiedUpMicros;
  for (const w of wanting) {
    const need = tiedUpMicros(w.pair);
    if (need > left) { out[w.at].reason = "no-money"; continue; }
    left -= need;
    out[w.at].pair = w.pair;
  }
  return out;
}
