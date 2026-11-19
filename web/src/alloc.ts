// The allocator: for a budget, the quotes across pools that the exchange's published score would
// credit most, at the least. Pure; every figure of the exchange's arrives in `Settings`, and all
// scoring is the score library's.
//
// What it maximises is a floor, not a forecast: each pool's dollars a day times our score over
// ours plus the most the orders already resting in that pool's books can be scoring. It says
// nothing of fills, of what other makers do next, or of what the exchange pays.
//
// A quote in a contract is a bid and an ask, each of the least size or more, no further apart than
// the widest spread. The sizes need not be equal: the score counts each order by its size over the
// square of its distance from the midpoint, and a bid at one cent costs a cent a contract while
// the ask beside it costs nearly a dollar, so the cheap side is the one worth growing.
//
// The method is greedy: at each step, of every way to spend the next piece (enter a contract at
// the least size on both sides, or add a block to one side of one already entered) it takes the
// one that adds the most floor a dollar. Entering is a lump, so this is a good allocation, not a
// proven best one.
import { ourScore, poolOthersMost, type Book, type Pair, type Settings, type Top } from "@app/score";
import { quoteFor } from "./calc.ts";

const MICROS_A_CENT = 10_000;

/** Where a pair rests: "widest" as far apart as still qualifies (least likely to fill, least score); "join" at the best prices where the book is no wider than the widest spread, otherwise as "widest". */
export type Stance = "widest" | "join";
/** `noBook`: the list's prices already held no qualifying pair, so no book was asked for and `book` is empty. The others score nothing there, and nothing of ours is placed there either: a quote's floor rests on a book that was read. */
export type AllocContract = { symbol: string; top: Top; stepCents: number; book: Book; noBook?: true };
export type AllocPool = { key: string; name: string; microsADay: number; contracts: AllocContract[] };

export type AllocQuote = { pool: string; symbol: string; pair: Pair; tiedMicros: number; worstLossMicros: number; score: number };
export type AllocPoolOut = { key: string; name: string; microsADay: number; ours: number; othersMost: number; share: number; leastMicrosADay: number; tiedMicros: number };
export type Alloc = {
  quotes: AllocQuote[];
  pools: AllocPoolOut[]; // only pools something was placed in
  leftOut: { key: string; name: string; why: string }[]; // pools no floor can be worked out for
  tiedMicros: number; worstLossMicros: number; leastMicrosADay: number; budgetMicros: number;
};

function restingPair(s: Settings, c: AllocContract, stance: Stance): Pair | null {
  const { bidCents: b, askCents: a } = c.top;
  if (stance === "join" && b !== null && a !== null && a > b && a - b <= s.maxSpreadCents) {
    return { bid: { cents: b, qty: s.minSize }, ask: { cents: a, qty: s.minSize } };
  }
  return quoteFor(s, c.top, c.stepCents, s.minSize, s.maxSpreadCents)?.pair ?? null;
}

type Slot = {
  pool: number; symbol: string; top: Top; pair: Pair;
  bidUnit: number; askUnit: number; // score a contract added to each side
  bidCents: number; askCostCents: number; // cost a contract on each side
  entered: boolean;
};

export function allocate(s: Settings, pools: AllocPool[], budgetMicros: number, stance: Stance): Alloc {
  const leftOut: Alloc["leftOut"] = [];
  const kept: { p: AllocPool; others: number; ours: number }[] = [];
  const slots: Slot[] = [];
  for (const p of pools) {
    const others = poolOthersMost(s, p.contracts.map((c) => ({ book: c.book })));
    if (others === null) { leftOut.push({ key: p.key, name: p.name, why: "a book of it was not read whole" }); continue; }
    const at = kept.length;
    let any = false;
    for (const c of p.contracts) {
      if (c.noBook) continue; // audit of 2026-11-18, finding 2
      const pair = restingPair(s, c, stance);
      if (pair === null) continue;
      const base = ourScore(s, pair, c.top);
      if (base === 0) continue;
      // A side's score a contract, from the library itself: what doubling that side adds, over its size.
      const m = s.minSize;
      const bidUnit = (ourScore(s, { bid: { cents: pair.bid.cents, qty: 2 * m }, ask: pair.ask }, c.top) - base) / m;
      const askUnit = (ourScore(s, { bid: pair.bid, ask: { cents: pair.ask.cents, qty: 2 * m } }, c.top) - base) / m;
      slots.push({ pool: at, symbol: c.symbol, top: c.top, pair, bidUnit, askUnit, bidCents: pair.bid.cents, askCostCents: 100 - pair.ask.cents, entered: false });
      any = true;
    }
    if (!any) { leftOut.push({ key: p.key, name: p.name, why: "no pair can rest in any contract of it" }); continue; }
    kept.push({ p, others, ours: 0 });
  }

  const floorOf = (k: { p: AllocPool; others: number }, ours: number) => (ours === 0 ? 0 : (k.p.microsADay * ours) / (ours + k.others));
  let leftCents = Math.floor(budgetMicros / MICROS_A_CENT);
  // A large budget is spent in larger blocks first, then in smaller ones down to the least size, so
  // the number of steps stays bounded whatever the budget (with every pool read, a million dollars a
  // least-size block at a time held the page for seconds). Up to $20,000 the block is the least size.
  let times = Math.max(1, Math.floor(leftCents / 2_000_000));
  for (;;) {
    const block = s.minSize * times;
    let best: { slot: Slot; side: "enter" | "bid" | "ask"; cost: number; add: number; rate: number } | null = null;
    for (const slot of slots) {
      const k = kept[slot.pool];
      const options: { side: "enter" | "bid" | "ask"; cost: number; add: number }[] = slot.entered
        ? [{ side: "bid", cost: block * slot.bidCents, add: block * slot.bidUnit }, { side: "ask", cost: block * slot.askCostCents, add: block * slot.askUnit }]
        : [{ side: "enter", cost: s.minSize * (slot.bidCents + slot.askCostCents), add: s.minSize * (slot.bidUnit + slot.askUnit) }];
      for (const o of options) {
        if (o.cost > leftCents || o.cost <= 0) continue;
        const gain = floorOf(k, k.ours + o.add) - floorOf(k, k.ours);
        const rate = gain / o.cost;
        if (rate > 0 && (best === null || rate > best.rate)) best = { slot, ...o, rate };
      }
    }
    if (best === null) {
      if (times === 1) break;
      times = Math.max(1, Math.floor(times / 10));
      continue;
    }
    const { slot } = best;
    if (best.side === "enter") slot.entered = true;
    else if (best.side === "bid") slot.pair = { bid: { cents: slot.pair.bid.cents, qty: slot.pair.bid.qty + block }, ask: slot.pair.ask };
    else slot.pair = { bid: slot.pair.bid, ask: { cents: slot.pair.ask.cents, qty: slot.pair.ask.qty + block } };
    kept[slot.pool].ours += best.add;
    leftCents -= best.cost;
  }

  const quotes: AllocQuote[] = slots.filter((x) => x.entered).map((x) => {
    const bidCost = x.pair.bid.cents * x.pair.bid.qty * MICROS_A_CENT, askCost = (100 - x.pair.ask.cents) * x.pair.ask.qty * MICROS_A_CENT;
    return { pool: kept[x.pool].p.key, symbol: x.symbol, pair: x.pair, tiedMicros: bidCost + askCost, worstLossMicros: Math.max(bidCost, askCost), score: ourScore(s, x.pair, x.top) };
  });
  // The others are scored again with our pairs in their books: a pair resting inside a book's best
  // prices moves that book's midpoint, and with it every resting order's distance. The steps above
  // chose by the midpoint as read; the figures shown are at the midpoint as it would stand
  // (audit of 2026-11-18, the screen, finding 3).
  kept.forEach((k, at) => {
    if (k.ours === 0) return;
    const mine = new Map(slots.filter((x) => x.pool === at && x.entered).map((x) => [x.symbol, x.pair]));
    const again = poolOthersMost(s, k.p.contracts.map((c) => { const pair = mine.get(c.symbol); return pair === undefined ? { book: c.book } : { book: c.book, pair }; }));
    if (again !== null) k.others = again;
  });
  const outPools: AllocPoolOut[] = kept.filter((k) => k.ours > 0).map((k) => {
    const mine = quotes.filter((q) => q.pool === k.p.key);
    const ours = mine.reduce((n, q) => n + q.score, 0); // summed again from the library's score of each final pair, not from the running total
    return { key: k.p.key, name: k.p.name, microsADay: k.p.microsADay, ours, othersMost: k.others, share: ours / (ours + k.others), leastMicrosADay: Math.floor(floorOf(k, ours)), tiedMicros: mine.reduce((n, q) => n + q.tiedMicros, 0) };
  });
  return {
    quotes, pools: outPools, leftOut,
    tiedMicros: quotes.reduce((n, q) => n + q.tiedMicros, 0),
    worstLossMicros: quotes.reduce((n, q) => n + q.worstLossMicros, 0),
    leastMicrosADay: outPools.reduce((n, p) => n + p.leastMicrosADay, 0),
    budgetMicros,
  };
}

/** One event of a pool as it was read: its priced contracts, the symbols the list could not price, and whether it is in play. */
export type ReadEvent = { live: boolean; contracts: { symbol: string; stepCents: number; top: Top }[]; unread: string[] };

/**
 * A pool as the allocator takes it, from what was read of it, or the reason no floor can be worked
 * out for it. Every contract a maker could be scoring in must have its book: one the list priced
 * no wider than the widest spread, and one the list could not price at all. A contract whose
 * listed prices already hold no qualifying pair (a side missing, or wider) needs none: the others
 * score nothing there, which an empty book says exactly. An unpriced contract's best prices are
 * its book's, and its step is taken as one cent (the list did not give it).
 */
export function toAllocPool(
  s: Settings, pool: { key: string; name: string; microsADay: number; eventCount: number },
  events: ReadEvent[], books: ReadonlyMap<string, Book>,
): AllocPool | { key: string; name: string; why: string } {
  const no = (why: string) => ({ key: pool.key, name: pool.name, why });
  if (events.length === 0) return no("not read");
  if (events.length !== pool.eventCount) return no("only " + events.length + " of its " + pool.eventCount + " events were read");
  if (events.some((e) => e.live)) return no("an event of it is in play");
  if (events.some((e) => e.contracts.length === 0 && e.unread.length === 0)) return no("an event of it lists no contract"); // the score library reads such an event as one a maker may be in (audit, finding 6)
  const contracts: AllocContract[] = [];
  for (const e of events) {
    for (const c of e.contracts) {
      const book = books.get(c.symbol);
      // With a book, the contract's best prices are the book's, never the list's read before it (audit, finding 1).
      if (book !== undefined) contracts.push({ ...c, top: { bidCents: book.bids[0]?.cents ?? null, askCents: book.asks[0]?.cents ?? null }, book });
      // No book is asked for only where the list shows a side missing: no pair can be qualifying
      // there. A contract with both prices listed always has its book asked for, so one without it
      // is a read that failed, and the list's width is not taken in its place (audit round 2).
      else if (c.top.bidCents === null || c.top.askCents === null) contracts.push({ ...c, book: { bids: [], asks: [] }, noBook: true });
      else return no("the book of " + c.symbol + " was not read");
    }
    for (const symbol of e.unread) {
      const book = books.get(symbol);
      if (symbol === "" || book === undefined) return no("a contract the list could not price has no book read");
      contracts.push({ symbol, stepCents: 1, top: { bidCents: book.bids[0]?.cents ?? null, askCents: book.asks[0]?.cents ?? null }, book });
    }
  }
  return { key: pool.key, name: pool.name, microsADay: pool.microsADay, contracts };
}
