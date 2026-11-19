// The exchange's published reward score, and what follows from it: whether any maker can be
// qualifying in a book, the widest pair that qualifies, and the least share a pair would take.
//
// Nothing here asks anybody anything, and no figure the exchange publishes is written in this
// file: the least size, the widest spread, the exponent, the floor and the least payout all
// arrive in `Settings`, read from the exchange's own settings answer.
//
// Prices are whole cents. A midpoint is carried doubled ("half cents"), so the middle of 48 and
// 53 is the whole number 101. Money is whole millionths of a dollar.

export type Settings = { minSize: number; maxSpreadCents: number; exponent: number; floorCents: number; minPayoutMicros: number };
export type Level = { cents: number; qty: number };
/** A contract's best prices, from every account together. */
export type Top = { bidCents: number | null; askCents: number | null };
/** Bids dearest first, asks cheapest first. `depth` is how many levels a side were asked for; absent means the whole book. */
export type Book = { bids: Level[]; asks: Level[]; depth?: number };
export type Pair = { bid: Level; ask: Level };
/** Nobody can be qualifying, known from prices alone; nobody can, known from sizes; or somebody may be. */
export type State = "none-prices" | "none-sizes" | "may";

const SNAPSHOTS_A_DAY = 24 * 60; // one a minute: the clock's own figure, not the exchange's setting

function figure(config: Record<string, unknown>, name: string): number {
  const v = config[name];
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error("settings: " + name + " is not a plain positive figure");
  return n;
}

/** The exchange's settings answer as this library uses it. Throws unless every figure is a plain positive number. */
export function readSettings(config: unknown): Settings {
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("settings: the answer is not an object");
  const c = config as Record<string, unknown>;
  return {
    minSize: figure(c, "min_size_threshold"),
    maxSpreadCents: figure(c, "max_spread_cents"),
    exponent: figure(c, "spread_penalty_exponent"),
    floorCents: figure(c, "min_spread_floor") * 100,
    minPayoutMicros: Math.round(figure(c, "min_payout_threshold_usd") * 1_000_000),
  };
}

/** Bid plus ask: the midpoint, doubled. Null when a side is missing. */
export function midHalfCents(top: Top): number | null {
  return top.bidCents === null || top.askCents === null ? null : top.bidCents + top.askCents;
}

/** One order's score at a snapshot: size over its distance from the midpoint, raised to the exponent; nothing under the least size. */
export function orderScore(s: Settings, cents: number, qty: number, midHalf: number): number {
  return qty < s.minSize ? 0 : sizeOverDistance(s, cents, qty, midHalf);
}

function sizeOverDistance(s: Settings, cents: number, qty: number, midHalf: number): number {
  const d = Math.max(Math.abs(2 * cents - midHalf) / 2, s.floorCents);
  return qty / d ** s.exponent;
}

/** A maker's own bid and ask qualify together: both of the least size, and no further apart than the widest spread. */
export function pairQualifies(s: Settings, pair: Pair): boolean {
  return pair.bid.qty >= s.minSize && pair.ask.qty >= s.minSize && pair.ask.cents > pair.bid.cents && pair.ask.cents - pair.bid.cents <= s.maxSpreadCents;
}

/** A maker's score at a snapshot: its two orders' scores when the pair qualifies, otherwise nothing. */
export function makerScore(s: Settings, maker: { bid: Level | null; ask: Level | null }, midHalf: number): number {
  if (maker.bid === null || maker.ask === null || !pairQualifies(s, { bid: maker.bid, ask: maker.ask })) return 0;
  return orderScore(s, maker.bid.cents, maker.bid.qty, midHalf) + orderScore(s, maker.ask.cents, maker.ask.qty, midHalf);
}

const crossed = (top: Top) => top.bidCents !== null && top.askCents !== null && top.askCents <= top.bidCents;

/**
 * True when no maker can have a qualifying pair in this contract, from the best prices alone. A
 * maker's own bid is at or below the best bid and its own ask at or above the best ask, so a book
 * wider than the widest spread, or with a side missing, holds no qualifying pair. A crossed or
 * locked answer proves nothing and is false.
 */
export function noneFromPrices(s: Settings, top: Top): boolean {
  if (top.bidCents === null || top.askCents === null) return true;
  return top.askCents - top.bidCents > s.maxSpreadCents; // a crossed or locked answer is never wider, so it is false
}

/**
 * For a book no wider than the widest spread: true when no window of that width holds the least
 * size on both sides, so no maker can have a qualifying pair; false when some window does. Null
 * when the prices already decide (a wider book, a missing side), when the answer is crossed, or
 * when only the top levels were read and a level not read could still change the answer.
 */
export function noneFromSizes(s: Settings, book: Book): boolean | null {
  const bestBid = book.bids[0]?.cents, bestAsk = book.asks[0]?.cents;
  if (bestBid === undefined || bestAsk === undefined) return null;
  if (bestAsk <= bestBid || bestAsk - bestBid > s.maxSpreadCents) return null;
  const lowest = bestAsk - s.maxSpreadCents; // the lowest bid any qualifying pair could hold
  for (let low = lowest; low <= bestBid; low++) {
    const bids = book.bids.reduce((n, l) => (l.cents >= low ? n + l.qty : n), 0);
    const asks = book.asks.reduce((n, l) => (l.cents <= low + s.maxSpreadCents ? n + l.qty : n), 0);
    if (bids >= s.minSize && asks >= s.minSize) return false;
  }
  if (book.depth !== undefined) {
    const lastBid = book.bids[book.bids.length - 1], lastAsk = book.asks[book.asks.length - 1];
    if (book.bids.length >= book.depth && lastBid.cents >= lowest) return null;
    if (book.asks.length >= book.depth && lastAsk.cents <= bestBid + s.maxSpreadCents) return null;
  }
  return true;
}

/**
 * An event's state from its contracts. A maker qualifies for an event's pool through any one of
 * its contracts, so nobody can be qualifying only when that is so in every contract. An event
 * with no contract listed proves nothing.
 */
export function eventState(s: Settings, contracts: { top: Top; book?: Book }[]): State {
  if (contracts.length === 0) return "may";
  if (contracts.every((c) => noneFromPrices(s, c.top))) return "none-prices";
  const none = (c: { top: Top; book?: Book }) => noneFromPrices(s, c.top) || (c.book !== undefined && noneFromSizes(s, c.book) === true);
  return contracts.every(none) ? "none-sizes" : "may";
}

/**
 * The widest pair of the least size that qualifies, centred on the midpoint of the best prices
 * and kept on the contract's price step: half the widest spread each side of a midpoint on the
 * step, and one step narrower where the midpoint falls between steps. Null when there is no
 * midpoint (a side missing, a crossed answer) or the pair would leave the range of 1 to 99 cents.
 */
export function widestPair(s: Settings, top: Top, stepCents: number): Pair | null {
  if (!Number.isInteger(stepCents) || stepCents < 1) throw new Error("the price step is not a whole number of cents");
  const mid = midHalfCents(top);
  if (mid === null || crossed(top)) return null;
  const bid = Math.ceil((mid - s.maxSpreadCents) / (2 * stepCents)) * stepCents;
  const ask = Math.floor((mid + s.maxSpreadCents) / (2 * stepCents)) * stepCents;
  if (bid < 1 || ask > 99 || ask <= bid) return null;
  return { bid: { cents: bid, qty: s.minSize }, ask: { cents: ask, qty: s.minSize } };
}

/**
 * The most the accounts already in a book can be scoring at a snapshot: every resting contract
 * at its distance, whatever the size of its level, since an account that qualifies with one
 * order may hold smaller ones and the book adds accounts together. An upper bound; who scores
 * cannot be seen. Nothing where nobody can be qualifying. Null, no bound at all, where a side
 * was not read whole: a level not read could be scoring.
 */
export function mostOthersScore(s: Settings, book: Book, midHalf: number): number | null {
  const top: Top = { bidCents: book.bids[0]?.cents ?? null, askCents: book.asks[0]?.cents ?? null };
  if (noneFromPrices(s, top) || noneFromSizes(s, book) === true) return 0;
  if (book.depth !== undefined && (book.bids.length >= book.depth || book.asks.length >= book.depth)) return null;
  return [...book.bids, ...book.asks].reduce((n, l) => n + sizeOverDistance(s, l.cents, l.qty, midHalf), 0);
}

/**
 * The least share of a snapshot a qualifying pair would take in this book: its score against the
 * most the others can be scoring. Null where the book gives no bound on the others.
 */
export function leastShare(s: Settings, pair: Pair, book: Book): number | null {
  const top: Top = { bidCents: book.bids[0]?.cents ?? null, askCents: book.asks[0]?.cents ?? null };
  const mine = ourScore(s, pair, top);
  if (mine === 0) return 0;
  const others = mostOthersScore(s, book, midWith(pair, top));
  return others === null ? null : mine / (mine + others);
}

/** The midpoint, doubled, a book would have with the pair resting in it: the dearer bid and the cheaper ask. A missing side takes the pair's own price. */
function midWith(pair: Pair, top: Top): number {
  return Math.max(pair.bid.cents, top.bidCents ?? pair.bid.cents) + Math.min(pair.ask.cents, top.askCents ?? pair.ask.cents);
}

/** Our pair's score at a snapshot, at the midpoint the book would have with the pair in it. Nothing where the others' best prices touch or cross the pair (it would be filled, not resting), or are themselves locked or crossed (a bad answer). */
export function ourScore(s: Settings, pair: Pair, top: Top): number {
  if (crossed(top) || (top.bidCents !== null && top.bidCents >= pair.ask.cents) || (top.askCents !== null && top.askCents <= pair.bid.cents)) return 0; // also a locked or crossed answer
  return makerScore(s, pair, midWith(pair, top));
}

/**
 * The most the accounts already in a pool's books can be scoring at a snapshot: each book at its
 * own midpoint, or, where our pair stands in it, at the midpoint the pair gives it. A book with a
 * side missing and no pair of ours holds no qualifying pair and adds nothing. No figure when any
 * book gives none: a level not read could be scoring.
 */
export function poolOthersMost(s: Settings, books: { book: Book; pair?: Pair }[]): number | null {
  let sum = 0;
  for (const { book: b, pair } of books) {
    const top: Top = { bidCents: b.bids[0]?.cents ?? null, askCents: b.asks[0]?.cents ?? null };
    const mid = pair !== undefined ? midWith(pair, top) : midHalfCents(top);
    const most = mid === null ? 0 : mostOthersScore(s, b, mid);
    if (most === null) return null;
    sum += most;
  }
  return sum;
}

/** Each of our scores' share of a snapshot in one pool: ours together against the others, never each alone. All nothing when ours sum to nothing. */
export function sharesInPool(mine: number[], othersMost: number): number[] {
  const ours = mine.reduce((a, b) => a + b, 0);
  return mine.map((m) => (ours === 0 ? 0 : m / (ours + othersMost)));
}

/** One event of a pool as the whole-pool test reads it: whether it is in play, how many of its contracts the reader could not read, and the rest. */
export type PoolEvent = { live: boolean; unread: number; contracts: { top: Top; book?: Book }[] };

/**
 * A pool's state: nobody can be qualifying in any book of any of its events. That is claimed only
 * when the list gave every event the pool counts, none of them in play (a live game's list prices
 * do not stand for its book), none with a contract the reader could not read and none with no
 * contract; otherwise somebody may be.
 */
export function poolState(s: Settings, eventCount: number, events: PoolEvent[]): State {
  if (events.length === 0 || events.length !== eventCount) return "may";
  if (events.some((e) => e.live || e.unread !== 0 || e.contracts.length === 0)) return "may"; // an unread count that is not plainly none is never read as none
  const states = events.map((e) => eventState(s, e.contracts));
  if (states.every((x) => x === "none-prices")) return "none-prices";
  return states.every((x) => x !== "may") ? "none-sizes" : "may";
}

/** A pool's share of one snapshot, in millionths of a dollar, rounded down: its day over the day's minutes. */
export function minuteShareMicros(poolMicrosADay: number): number {
  return Math.floor(poolMicrosADay / SNAPSHOTS_A_DAY);
}
