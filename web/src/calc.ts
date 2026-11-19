// The calculator (T11): what a qualifying quote in a contract takes, and the least it would be
// credited, by the exchange's published score. Pure; every figure of the exchange's arrives in
// `Settings`. All the scoring is the score library's: nothing is worked out a second way here.
//
// Money tied up and the worst loss rest on one assumption, said on the page beside them: each
// order is paid for in full when it is placed (a bid costs its price a contract; an ask costs a
// dollar less its price a contract). The exchange's own margin rules were not read.
import { minuteShareMicros, ourScore, poolOthersMost, widestPair, type Book, type Pair, type Settings, type Top } from "@app/score";

const MICROS_A_CENT = 10_000;

export type Quote = {
  pair: Pair;
  tiedMicros: number; // both orders resting, under the assumption above
  worstLossMicros: number; // one side filled whole and the contract settling against it
  score: number; // the pair's score at a snapshot, at the midpoint the book would have with it in
};

/**
 * The pair a maker would rest in a contract: `qty` contracts a side, `spreadCents` apart at most,
 * centred on the midpoint of the best prices and kept on the price step. Null when the size is
 * under the least size or the spread over the widest (it would score nothing), or when the book
 * gives no midpoint to centre on.
 */
export function quoteFor(s: Settings, top: Top, stepCents: number, qty: number, spreadCents: number): Quote | null {
  if (!Number.isInteger(qty) || qty < s.minSize) return null;
  if (!Number.isInteger(spreadCents) || spreadCents < 1 || spreadCents > s.maxSpreadCents) return null;
  // Near one cent or ninety-nine the pair asked for would leave the range of prices: the widest
  // narrower one that stays in it is taken instead, down to joining the best prices.
  let widest: Pair | null = null;
  for (let w = spreadCents; w >= 1 && widest === null; w--) widest = widestPair({ ...s, maxSpreadCents: w }, top, stepCents);
  if (widest === null) return null;
  const pair: Pair = { bid: { cents: widest.bid.cents, qty }, ask: { cents: widest.ask.cents, qty } };
  const score = ourScore(s, pair, top);
  if (score === 0) return null;
  const bidCost = pair.bid.cents * qty * MICROS_A_CENT, askCost = (100 - pair.ask.cents) * qty * MICROS_A_CENT;
  return { pair, tiedMicros: bidCost + askCost, worstLossMicros: Math.max(bidCost, askCost), score };
}

export type CalcContract = { symbol: string; top: Top; stepCents: number; book?: Book };
export type CalcRow = { symbol: string; top: Top; quote: Quote | null; bookRead: boolean };

export type Calc = {
  rows: CalcRow[];
  quoted: number; // contracts a pair can rest in
  tiedMicros: number; // over every quoted contract
  worstLossMicros: number; // every quoted contract's worst loss at once
  aloneMicrosAMinute: number; // the pool's whole minute: the credit if no other account scored
  /** The least share of a snapshot the pairs together would take, and its credit a minute. Null
   * until every contract's book has been read whole: a book not read could hold any score. */
  least: { share: number; microsAMinute: number } | null;
};

/**
 * One pool's calculator over the contracts of all its events: the same size and spread in each
 * contract that can hold a pair. The share is ours together against the most the accounts already
 * in the pool's books can be scoring, so it is a floor, never an estimate of what would be paid.
 * It is a floor at the moment the books were read, and only if the prices listed and the books agree.
 */
export function calcPool(s: Settings, poolMicrosADay: number, contracts: CalcContract[], qty: number, spreadCents: number, whole = true): Calc {
  // Where a book was read its best prices are the contract's prices: the list was read first and
  // the book after it, and the two can disagree (audit of 2026-11-18, finding 1: a floor worked
  // from the list's prices beside a book that had moved came out far too high).
  contracts = contracts.map((c) => (c.book === undefined ? c : { ...c, top: { bidCents: c.book.bids[0]?.cents ?? null, askCents: c.book.asks[0]?.cents ?? null } }));
  const rows: CalcRow[] = contracts.map((c) => ({ symbol: c.symbol, top: c.top, quote: quoteFor(s, c.top, c.stepCents, qty, spreadCents), bookRead: c.book !== undefined }));
  const quotes = rows.flatMap((r) => (r.quote === null ? [] : [r.quote]));
  const alone = minuteShareMicros(poolMicrosADay);
  let least: Calc["least"] = null;
  // A contract whose best prices already hold no qualifying pair (a side missing, or wider than the
  // widest spread) adds nothing to the others' score, so its book is not needed. `whole` is false
  // when the caller knows of contracts of the pool it could not hand over (unread, or in play): a
  // maker may be scoring there, so no floor is claimed.
  // The exception: a contract we quote in always needs its book, since the floor rests on what is
  // resting beside our pair at the moment of the read.
  // (Audit round 2: the list's width is not trusted either. Only a side missing on the list spares the book.)
  const need = contracts.map((c, i) => ({ c, i })).filter(({ c, i }) => (c.top.bidCents !== null && c.top.askCents !== null) || rows[i].quote !== null);
  if (whole && quotes.length > 0 && need.every(({ c }) => c.book !== undefined)) {
    const others = poolOthersMost(s, need.map(({ c, i }) => ({ book: c.book!, ...(rows[i].quote !== null ? { pair: rows[i].quote!.pair } : {}) })));
    if (others !== null) {
      const ours = quotes.reduce((n, q) => n + q.score, 0);
      const share = ours / (ours + others);
      least = { share, microsAMinute: Math.floor(alone * share) };
    }
  }
  return {
    rows, quoted: quotes.length,
    tiedMicros: quotes.reduce((n, q) => n + q.tiedMicros, 0),
    worstLossMicros: quotes.reduce((n, q) => n + q.worstLossMicros, 0),
    aloneMicrosAMinute: alone, least,
  };
}
