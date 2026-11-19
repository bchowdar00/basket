// The reader of the exchange's public, read-only lists: the active events, the liquidity-reward
// rows, and the reward settings. It turns each answer into the engine's own shapes.
//
// Nothing here asks the exchange anything of its own accord and nothing here places anything: every
// request goes through a `fetcher` the caller hands in, so a test can answer without a network. No
// key is held, no header is signed. No figure the exchange publishes is written into this file: the
// listing's categories arrive as an argument, and every pool amount and price is read from the
// answer. Prices are whole cents, money is whole millionths of a dollar, times are milliseconds.
//
// The one error this reader must never cause is a false "nobody can qualify". What cannot be read is
// named in `unread`, never dropped and never read as an empty side; the only contract dropped is one
// the exchange has closed. Every rule below errs to the safe side.

import { readSettings, type Book, type Level, type Settings, type Top } from "@app/score";
import type { EventIn, Read } from "@app/rule";

/** A request did not answer in time, twice. */
export class NoAnswer extends Error {}
/** The exchange said 429: the pass is over and nothing is asked for a minute. */
export class Stopped extends Error {}
/** An answer that is not the shape expected, or a status that is not 200 or 429. */
export class BadAnswer extends Error {}
/** A book asked for before sizes may be read (the team's limit): nothing was asked. */
export class NotYet extends Error {}

export type Answer = { status: number; json: unknown; text?: string }; // `text`: the body of an answer that was not 200, kept as it came
export type Deps = {
  fetcher(url: string, timeoutMs: number): Promise<Answer>; // rejects with NoAnswer when the time runs out
  sleep(ms: number): Promise<void>;
  nowMs(): number;
};

export const PAGE = 100; // the page size asked for
export const APART_MS = 1_200; // the least time between two requests
export const TIMEOUT_MS = 60_000; // how long one request may take
export const AFTER_429_MS = 60_000; // how long nothing is asked after a 429

export type ListedContract = { symbol: string; stepCents: number; top: Top };
export type ListedEvent = {
  ticker: string; title: string; category: string; subcategory: string | null; startMs: number; live: boolean; volume: number | null;
  contracts: ListedContract[];
  /** Tradeable contracts whose step or best prices could not be read as whole cents, and anything
   * else that is not plainly closed and not plainly readable. Nothing is known of them, so an event
   * that has one is never one where nobody can be qualifying. */
  unread: string[];
};
export type PoolRow = {
  ticker: string; title: string; category: string;
  poolMicrosADay: number; source: string; endsAtMs: number | null; makers: number;
  poolId: number | null; poolEventCount: number; poolName: string | null;
  poolKey: string; // "id:<pool_id>" where the row has an id, else "event:<ticker>"
  raw: Record<string, unknown>; // the row as it came, every field kept
};
/** A read of the event list, and whether the list was seen to move while it was read. `moved`
 * false is "no sign of movement", not proof: a list read a page at a time cannot show an item
 * taken out and another put in ahead of the place being read, when the two leave every later place
 * where it was. One item can then be missing and one stale, for that read. The caller must not
 * rest a claim about a whole pool on one read: it checks each pool's events against the count the
 * reward rows give and against the other list. */
export type Events = { events: ListedEvent[]; total: number; twice: number; moved: boolean };
export type Pools = { lastScoreDate: string | null; total: number; rows: PoolRow[]; twice: number; moved: boolean };

const BASE = "https://api.gemini.com/v1";
const EVENTS = BASE + "/prediction-markets/events";
const REWARDS = BASE + "/prediction-markets/liquidity-rewards/events";
const CONFIG = BASE + "/prediction-markets/liquidity-rewards/config";
const BOOK = BASE + "/book/";
/** A side of this many levels or more may have been cut at the exchange's default length, so it is never taken as the whole side. */
export const BOOK_CUT = 50;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const lower = (v: unknown): string | null => (typeof v === "string" ? v.toLowerCase() : null);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
const PRICE_KEYS = new Set(["buy", "sell", "bestBid", "bestAsk", "lastTradePrice"]); // every key the exchange's `prices` has been seen to hold
const SIDE_KEYS = new Set(["yes", "no"]); // and every key its `buy` and `sell` have

/** The finite value a numeric text (or number) names, or null when it names none. */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A volume: a finite number of none or more, else null. */
function amount(v: unknown): number | null {
  const n = toNum(v);
  return n !== null && n >= 0 ? n : null;
}

/** A best price to a whole cent from 1 to 99. `null` is "no price there": the key absent, null, or
 * text empty after trimming (the exchange leaves the key out for a side with nobody on it).
 * "unread" is a price that is there and cannot be held as a whole cent from 1 to 99 — not a plain
 * decimal, a fraction of a cent, zero, or a whole dollar or more — and must never be read as empty. */
function priceCents(v: unknown): number | null | "unread" {
  if (v === undefined || v === null) return null;
  let n: number;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "unread";
    n = v;
  } else if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    if (!/^\d+(\.\d+)?$/.test(t)) return "unread"; // "4.7e-1", "0x28", "0,47", "-0.40", "abc": there, but not a plain decimal
    n = Number(t);
  } else return "unread";
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 0.001) return "unread"; // a fraction of a cent
  return cents >= 1 && cents <= 99 ? cents : "unread"; // zero, or a whole dollar or more: there and impossible
}

/** A twin of a best price inside `buy` or `sell`: null where the key is not there; the cent where
 * it is a whole cent from 1 to 99; "unread" for anything else, a null or an empty text among them
 * (the exchange leaves the key out where there is no price, so a key that is there must be one). */
function twinCents(side: Record<string, unknown>, key: string): number | null | "unread" {
  if (!Object.hasOwn(side, key)) return null;
  const cents = priceCents(side[key]);
  return cents === null ? "unread" : cents;
}

/** A price step in whole cents of 1 or more; null when the increment is absent, not a number, or
 * not a whole number of cents. A tradeable contract whose step is null is named, never dropped. */
function stepCents(v: unknown): number | null {
  const d = toNum(v);
  if (d === null) return null;
  const cents = Math.round(d * 100);
  if (Math.abs(d * 100 - cents) > 1e-9) return null;
  return cents >= 1 ? cents : null;
}

/** Dollars as text to whole millionths, read from the text itself (split at the point, no floating
 * multiply). Throws BadAnswer unless it is a figure of none or more with at most six decimals. */
function microsFromDollars(v: unknown): number {
  if (typeof v !== "string") throw new BadAnswer("a pool amount is not text");
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
  if (m === null) throw new BadAnswer("a pool amount is not a figure of none or more with at most six decimals");
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) throw new BadAnswer("a pool amount is too large to hold");
  return micros;
}

/** A whole count of none or more; throws BadAnswer otherwise. */
function wholeCount(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new BadAnswer("a count is not a whole number of none or more");
  return v;
}

/** A pool id: null where absent or null; otherwise a safe whole number of none or more, or a
 * BadAnswer. A misread id would split or join pools, so it is never guessed through. */
function poolIdOf(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new BadAnswer("a pool id is not a whole number of none or more");
  return v;
}

/** A pool's event count: 1 where absent or null; otherwise a whole number of 1 or more, or a BadAnswer. */
function eventCountOf(v: unknown): number {
  if (v === undefined || v === null) return 1;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new BadAnswer("a pool event count is not a whole number of one or more");
  return v;
}

/** Milliseconds from ISO text, or null where it is absent or does not parse. */
function parseMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const eventsUrl = (category: string, offset: number): string =>
  EVENTS + "?status=active&category=" + encodeURIComponent(category) + "&limit=" + PAGE + "&offset=" + offset;
const rewardsUrl = (offset: number): string => REWARDS + "?limit=" + PAGE + "&offset=" + offset;

/** One listed event in the engine's shape; an event with no ticker text has already been refused.
 * A `contracts` that is not a list is read as no contracts and one unread blank, never as empty. */
function mapEvent(raw: Record<string, unknown>): ListedEvent {
  const sub = isObject(raw.subcategory) && typeof raw.subcategory.name === "string" ? raw.subcategory.name : null;
  const read = Array.isArray(raw.contracts) ? raw.contracts.map(mapContract) : null;
  return {
    ticker: raw.ticker as string,
    title: str(raw.title),
    category: str(raw.category),
    subcategory: sub,
    startMs: parseMs(raw.startTime) ?? 0, // an absent or unparsed start is already-started, so never quoted
    live: raw.isLive !== false, // live unless the exchange says exactly that it is not: a live event is never quoted
    volume: amount(raw.volume),
    contracts: (read ?? []).flatMap((r) => (r !== null && typeof r !== "string" ? [r] : [])),
    unread: read === null ? [""] : read.flatMap((r) => (typeof r === "string" ? [r] : [])),
  };
}

/** A contract read into one of three fates:
 *  - a ListedContract, when it is tradeable and its step and both sides can be held;
 *  - a string, its name (or ""), when it is unread: not plainly tradeable, or tradeable but its
 *    symbol, step, prices shape or a present price could not be read;
 *  - null, dropped, only when the exchange has closed it. */
function mapContract(c: unknown): ListedContract | string | null {
  if (!isObject(c)) return ""; // not an object: unread under ""
  const name = typeof c.instrumentSymbol === "string" ? c.instrumentSymbol : "";
  const status = lower(c.status);
  const market = lower(c.marketState);
  if (market === "closed") return null; // the only drop: nobody can trade it
  if (!(status === "active" && (market === "open" || market === "post_only"))) return name; // not plainly tradeable: unread
  const step = stepCents(c.priceIncrement);
  if (name === "" || step === null) return name; // tradeable, but its symbol or step could not be read
  const p = c.prices;
  // The exchange's prices: `buy` and `sell` always, a best price where there is one, and no key
  // beyond these. A key it has never sent may be a best price under a new name, so it is not
  // guessed through.
  if (!isObject(p) || Object.keys(p).some((k) => !PRICE_KEYS.has(k)) || !isObject(p.buy) || !isObject(p.sell)) return name;
  const { buy, sell } = p;
  if (Object.keys(buy).some((k) => !SIDE_KEYS.has(k)) || Object.keys(sell).some((k) => !SIDE_KEYS.has(k))) return name;
  // Each best price is written three times: `bestBid` again as `sell.yes` and, taken from a dollar,
  // as `buy.no`; `bestAsk` again as `buy.yes` and, taken from a dollar, as `sell.no`. A side is
  // empty only when all three say so, and a price only when all three give the same cent.
  const bidCents = priceCents(own(p, "bestBid")), askCents = priceCents(own(p, "bestAsk"));
  if (bidCents === "unread" || askCents === "unread") return name; // a side that is there and could not be held
  const agrees = (best: number | null, same: number | null | "unread", other: number | null | "unread") =>
    best === null ? same === null && other === null : same === best && other === 100 - best;
  if (!agrees(bidCents, twinCents(sell, "yes"), twinCents(buy, "no")) || !agrees(askCents, twinCents(buy, "yes"), twinCents(sell, "no"))) return name; // the witnesses disagree
  return { symbol: name, stepCents: step, top: { bidCents, askCents } };
}

/** One reward row in the engine's shape, every field kept in `raw`. */
function mapPool(raw: Record<string, unknown>): PoolRow {
  const poolId = poolIdOf(raw.pool_id);
  return {
    ticker: raw.event_ticker as string,
    title: str(raw.title),
    category: str(raw.category),
    poolMicrosADay: microsFromDollars(raw.daily_pool_usd),
    source: str(raw.pool_source),
    endsAtMs: parseMs(raw.ends_at),
    makers: wholeCount(raw.qualifying_maker_count),
    poolId,
    poolEventCount: eventCountOf(raw.pool_event_count),
    poolName: typeof raw.pool_category_name === "string" ? raw.pool_category_name : null,
    poolKey: poolId !== null ? "id:" + poolId : "event:" + (raw.event_ticker as string),
    raw,
  };
}

/** The ticker of a listed event, or BadAnswer when there is none. */
function eventKey(item: unknown): string {
  if (!isObject(item) || typeof item.ticker !== "string" || item.ticker === "") throw new BadAnswer("an event has no ticker");
  return item.ticker;
}

/** The ticker of a reward row, or BadAnswer when there is none. */
function poolKey(item: unknown): string {
  if (!isObject(item) || typeof item.event_ticker !== "string" || item.event_ticker === "") throw new BadAnswer("a reward row has no event ticker");
  return item.event_ticker;
}

export function reader(d: Deps): {
  listEvents(category: string): Promise<Events>;
  listPools(): Promise<Pools>;
  settings(): Promise<Settings>;
  book(symbol: string, notBeforeMs: number): Promise<Book | null>;
  event(ticker: string): Promise<ListedEvent>;
} {
  // One clock for the whole reader: the moment the last request was sent, and the moment a 429 was
  // seen. Both outlive a single call, so pacing and the after-429 wait hold across the functions.
  let lastSentMs: number | null = null;
  let stopAtMs: number | null = null;
  // One queue for the whole reader: every send waits for the last send's turn, so however the
  // callers race, the sends happen one after another.
  let turn: Promise<void> = Promise.resolve();

  /** Wait until it is both APART_MS after the last request and AFTER_429_MS after any 429. A loop,
   * so one sleep that returns early never lets a send through: after each sleep it looks at the
   * clock again. Each send works this out at its own turn, so a send that was waiting when another
   * got a 429 waits the minute too. */
  async function waitBefore(): Promise<void> {
    for (;;) {
      let until = 0;
      if (lastSentMs !== null) until = Math.max(until, lastSentMs + APART_MS);
      if (stopAtMs !== null) until = Math.max(until, stopAtMs + AFTER_429_MS);
      const gap = until - d.nowMs();
      if (gap <= 0) return;
      await d.sleep(gap);
    }
  }

  /** One send: it takes the queue's turn, does the pacing wait, records the time, then calls the
   * fetcher. A 429 is recorded here, while the turn is still held: recorded any later, a send that
   * was waiting would work out its wait before the pause existed, and after a slow answer it would
   * go out at once. The next turn starts whether this send resolved or rejected, so a failure or a
   * timeout does not block the queue. */
  async function send(url: string): Promise<Answer> {
    const prev = turn;
    let release!: () => void;
    turn = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      await waitBefore();
      lastSentMs = d.nowMs();
      const answer = await d.fetcher(url, TIMEOUT_MS);
      if (answer.status === 429) stopAtMs = d.nowMs();
      return answer;
    } finally {
      release();
    }
  }

  /** One request: a NoAnswer is tried once more, through the same queue and the same wait, and a
   * second is thrown on; 200 goes on; 429 ends the pass as Stopped; any other status is a BadAnswer
   * naming it. */
  async function request(url: string): Promise<Answer> {
    let answer: Answer;
    try {
      answer = await send(url);
    } catch (e) {
      if (!(e instanceof NoAnswer)) throw e;
      answer = await send(url); // a second NoAnswer propagates and the pass is given up, never guessed
    }
    if (answer.status === 429) throw new Stopped("the exchange asked for a pause"); // the pause itself is recorded in send
    if (answer.status !== 200) throw new BadAnswer("the status is " + answer.status);
    return answer;
  }

  /** Read every page of one list. Each page after the first is asked from one item back, so its
   * first item should be the last one already read: where it is not, the list slid between the two
   * requests and something may have been skipped. The later copy of a ticker seen earlier in the
   * pass takes the first's place (it is the fresher one) and is counted in `twice`. `moved` is true
   * when the list slid, a ticker came back, a page's total differs from the first page's, or the
   * count read is not the total. */
  async function collect(urlAt: (offset: number) => string, listKey: string, keyOf: (item: unknown) => string) {
    const pos = new Map<string, number>();
    const rows: Record<string, unknown>[] = [];
    let twice = 0;
    let first: Record<string, unknown> | null = null;
    let firstTotal = 0;
    let moved = false;
    let lastKey: string | null = null;
    for (let page = 0, offset = 0; ; page++) {
      if (page >= 100) throw new BadAnswer("the list did not end within a hundred pages");
      const { json } = await request(urlAt(offset));
      if (!isObject(json)) throw new BadAnswer("the answer is not an object");
      const list = json[listKey];
      if (!Array.isArray(list)) throw new BadAnswer("the " + listKey + " field is not a list");
      const pag = json.pagination;
      if (!isObject(pag) || typeof pag.total !== "number" || !Number.isInteger(pag.total) || pag.total < 0) throw new BadAnswer("the pagination total is not a whole number of none or more");
      if (page === 0) { first = json; firstTotal = pag.total; }
      else if (pag.total !== firstTotal) moved = true;
      let fresh = list;
      if (page > 0) {
        if (list.length > 0 && keyOf(list[0]) === lastKey) fresh = list.slice(1); // the item already read, as expected
        else moved = true; // the list slid, or shrank to nothing here
      }
      for (const item of fresh) {
        const key = keyOf(item);
        const at = pos.get(key);
        if (at !== undefined) { rows[at] = item as Record<string, unknown>; twice++; continue; } // the later copy wins
        pos.set(key, rows.length);
        rows.push(item as Record<string, unknown>);
      }
      if (list.length < PAGE || offset + list.length >= pag.total) break;
      lastKey = keyOf(list[list.length - 1]);
      offset += list.length - 1;
    }
    return { rows, first: first as Record<string, unknown>, twice, moved: moved || twice > 0 || rows.length !== firstTotal };
  }

  async function listEvents(category: string): Promise<Events> {
    const { rows, first, twice, moved } = await collect((offset) => eventsUrl(category, offset), "data", eventKey);
    return { events: rows.map(mapEvent), total: (first.pagination as Record<string, unknown>).total as number, twice, moved };
  }

  /** One event by its ticker, read through the same `mapEvent` as a listed one. The category list
   * stopped giving the season-long markets on 2026-11-18 while the events themselves stayed active,
   * so an event the reward list names is asked for by name. An answer that is no event, or is
   * another event, is a BadAnswer. */
  async function event(ticker: string): Promise<ListedEvent> {
    const { json } = await request(EVENTS + "/" + encodeURIComponent(ticker));
    if (eventKey(json) !== ticker) throw new BadAnswer("the event answered is not " + ticker);
    return mapEvent(json as Record<string, unknown>);
  }

  async function listPools(): Promise<Pools> {
    const { rows, first, twice, moved } = await collect(rewardsUrl, "events", poolKey);
    const pag = first.pagination as Record<string, unknown>;
    return {
      lastScoreDate: typeof first.last_score_date === "string" ? first.last_score_date : null,
      total: pag.total as number,
      rows: rows.map(mapPool),
      twice,
      moved,
    };
  }

  async function settings(): Promise<Settings> {
    const { json } = await request(CONFIG);
    try {
      return readSettings(json); // throws on a non-object or a bad figure
    } catch (e) {
      throw new BadAnswer(e instanceof Error ? e.message : String(e));
    }
  }

  /** One contract's book, both sides asked whole. Refused before `notBeforeMs` with nothing asked.
   * Null, a book not read (never an empty one), where any level is not a whole cent from 1 to 99
   * with a positive amount, or a side is not a list. A side of BOOK_CUT levels or more sets
   * `depth`, so the score library takes it as not read whole. */
  async function book(symbol: string, notBeforeMs: number): Promise<Book | null> {
    if (!(d.nowMs() >= notBeforeMs)) throw new NotYet("no book is read before " + new Date(notBeforeMs).toISOString());
    const { json } = await request(BOOK + encodeURIComponent(symbol) + "?limit_bids=0&limit_asks=0");
    if (!isObject(json)) throw new BadAnswer("the book is not an object");
    const bids = bookSide(json.bids), asks = bookSide(json.asks);
    if (bids === null || asks === null) return null;
    bids.sort((a, b) => b.cents - a.cents);
    asks.sort((a, b) => a.cents - b.cents);
    return bids.length >= BOOK_CUT || asks.length >= BOOK_CUT ? { bids, asks, depth: BOOK_CUT } : { bids, asks };
  }

  return { listEvents, listPools, settings, book, event };
}

/** One side of a book, or null where any level cannot be held exactly. */
function bookSide(v: unknown): Level[] | null {
  if (!Array.isArray(v)) return null;
  const out: Level[] = [];
  for (const l of v) {
    if (!isObject(l)) return null;
    const cents = priceCents(l.price);
    const qty = toNum(l.amount);
    // The amount: any positive figure. The exchange's quantity step is a hundredth of a contract and
    // its books hold such amounts (seen 2026-11-18), and the score takes size as it is.
    if (typeof cents !== "number" || qty === null || !Number.isFinite(qty) || qty <= 0) return null;
    out.push({ cents, qty });
  }
  return out;
}

/** The engine's event input from a listed event, its pool (where there is one) and the log for each
 * of its contracts. No book is attached here. Each unread contract goes in with an empty log: the
 * rule takes a contract with no read as one where somebody may be qualifying, so the event is never
 * quoted in and never counted as one where nobody can qualify. */
export function toEventIn(e: ListedEvent, pool: PoolRow | undefined, logOf: (symbol: string) => Read[]): EventIn {
  return {
    ticker: e.ticker,
    startMs: e.startMs,
    live: e.live,
    poolMicrosADay: pool ? pool.poolMicrosADay : null,
    makersLastDay: pool ? pool.makers : null,
    volume: e.volume,
    contracts: [
      ...e.contracts.map((c) => ({ symbol: c.symbol, stepCents: c.stepCents, log: logOf(c.symbol) })),
      ...e.unread.map((symbol) => ({ symbol, stepCents: 1, log: [] })),
    ],
  };
}

/** The real dependencies: global fetch (aborted at the timeout, a timeout read as NoAnswer),
 * setTimeout, and the wall clock held so it cannot go backwards. No test reaches this, because no test reaches
 * the network. */
export function nodeDeps(): Deps {
  return {
    async fetcher(url, timeoutMs) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), timeoutMs); // covers the body as well as the headers
      try {
        const r = await fetch(url, { headers: { accept: "application/json" }, signal: stop.signal });
        if (r.status === 200) {
          const text = await r.text();
          try {
            return { status: 200, json: JSON.parse(text) };
          } catch {
            throw new BadAnswer("the answer is not JSON: " + text.slice(0, 2_000)); // the body kept in the error, and so in the reads
          }
        }
        let text: string | undefined;
        try {
          text = typeof (r as { text?: unknown }).text === "function" ? (await r.text()).slice(0, 20_000) : undefined; // a refusal's body, kept
        } catch {
          // a body that cannot be read changes nothing about the status, which is what matters
        }
        if (text === undefined) {
          try {
            await r.body?.cancel(); // let the connection go rather than hold an unread body
          } catch {
            // as above
          }
        }
        return text === undefined ? { status: r.status, json: null } : { status: r.status, json: null, text };
      } catch (e) {
        if (e instanceof BadAnswer) throw e;
        throw new NoAnswer(String(e)); // the time ran out, or the request could not be made
      } finally {
        clearTimeout(timer);
      }
    },
    sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    nowMs: (() => {
      // The wall clock, which keeps counting while the Mac sleeps (audit 2, finding 8), held so it never goes backwards.
      let last = 0;
      return () => (last = Math.max(last, Date.now()));
    })(),
  };
}
