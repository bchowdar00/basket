// The operator's screen reading Gemini itself, from this Mac only (his word, 2026-11-18: "Yes,
// read live"). The limits he approved, and where each is held:
//   - the lists (settings and the reward list: three requests) no more often than every five
//     minutes, and only when the page asks: `LISTS_EVERY_MS`, and nothing here runs on a timer;
//   - when a pool is opened: each of its events by its ticker, then one book for each contract
//     that has both prices, once an opening: an event or a book read is kept `BOOK_KEEP_MS`, so
//     opening a pool again inside that time asks nothing. (The Sports list is no longer read: on
//     2026-11-18 it stopped giving the season-long markets the reward list names, so an event is
//     asked for by name. Fewer requests a refresh than he approved; the events of an opened pool
//     are the new kind of request, his word asked for before the first.)
//   - 1.2 seconds apart and a minute's stop after a 429: the engine's own `reader`, one for the
//     whole server, so the lists and the books share one queue and one clock;
//   - every answer kept raw outside the build folder, as the engine keeps its own.
// Nothing here places an order or sends anything but a public GET.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Book, Settings } from "@app/score";
import { NoAnswer, nodeDeps, reader, type Deps, type ListedEvent, type Pools } from "../../services/engine/src/gemini.ts";

export const LISTS_EVERY_MS = 5 * 60_000;
export const BOOK_KEEP_MS = 5 * 60_000;

export type Lists = { settings: Settings; pools: Pools; events: ListedEvent[]; eventsAtMs: number };
export type BookAnswer = { atMs: number; book: Book | null; error?: string };
export type PoolAnswer = { events: ListedEvent[]; books: Record<string, BookAnswer>; errors: string[] };

/** The contracts of a pool a book is asked for: those of its listed events not in play that show both prices. */
export function symbolsToRead(events: ListedEvent[], unreadToo = false): string[] {
  // With `unreadToo`, also the contracts the list's prices could not be read for (the exchange's
  // three copies of a best price disagreeing, as seen 2026-11-18): only their book says whether a
  // maker can be qualifying there. Off unless BASKET_READ_UNREAD=1: more requests an opening than
  // the "one book for each contract that has both prices" he approved.
  const unread = unreadToo ? events.filter((e) => !e.live).flatMap((e) => e.unread.filter((s) => s !== "")) : [];
  return [...unread, ...events
    .filter((e) => !e.live)
    .flatMap((e) => e.contracts.filter((c) => c.top.bidCents !== null && c.top.askCents !== null).map((c) => c.symbol))];
}

/**
 * The answers already kept in `dir`, served again with nothing asked of anybody: the last answer
 * kept for each address, through the same reader. `servedAtMs` is when the answer last served was
 * first given, so the screen shows the age of what it draws. An address never asked is NoAnswer.
 * The list pages of whole categories are left out (large, and not used by the feed).
 */
export function keptDeps(dir: string): Deps & { servedAtMs(): number } {
  const last = new Map<string, { atMs: number; status?: number; json?: unknown; text?: string }>();
  let names: string[] = [];
  try { names = readdirSync(join(dir, "reads")).filter((f) => f.endsWith(".jsonl.gz")).sort(); } catch { /* nothing kept */ }
  for (const name of names) {
    for (const line of gunzipSync(readFileSync(join(dir, "reads", name))).toString("utf8").split("\n")) {
      if (line === "" || line.includes("/prediction-markets/events?")) continue;
      const o = JSON.parse(line) as { atMs: number; url: string; status?: number; json?: unknown; text?: string };
      if (o.status === 200) last.set(o.url, o);
    }
  }
  let served = 0, clock = 0;
  return {
    async fetcher(url) {
      const o = last.get(url);
      if (o === undefined) throw new NoAnswer("no answer was kept for " + url);
      served = o.atMs;
      return { status: 200, json: o.json };
    },
    async sleep(ms) { clock += ms; }, // the reader's pacing waits pass at once: nothing is sent
    nowMs: () => clock,
    servedAtMs: () => served,
  };
}

export function liveFeed(a: { dir: string; deps?: Deps; unreadToo?: boolean; kept?: boolean }) {
  // `kept`: serve the answers already kept, asking nothing. No time limit applies (nothing is sent)
  // and nothing is written; every time shown is the kept answer's own.
  const keptD = a.kept === true ? keptDeps(a.dir) : null;
  const base = keptD ?? a.deps ?? nodeDeps();
  const stamp = () => (keptD !== null ? keptD.servedAtMs() : base.nowMs());
  const KEEP = keptD !== null ? Infinity : BOOK_KEEP_MS;
  const keep = (atMs: number, line: Record<string, unknown>) => {
    if (keptD !== null) return;
    mkdirSync(join(a.dir, "reads"), { recursive: true });
    appendFileSync(join(a.dir, "reads", new Date(atMs).toISOString().slice(0, 10) + ".jsonl.gz"), gzipSync(JSON.stringify(line) + "\n"));
  };
  const r = reader({
    ...base,
    async fetcher(url, timeoutMs) {
      // A 429 seen by a server since restarted still holds: its minute is waited out here, since the new reader does not know of it.
      while (pausedAtMs !== null && base.nowMs() - pausedAtMs < 60_000) await base.sleep(pausedAtMs + 60_000 - base.nowMs());
      const atMs = base.nowMs();
      try {
        const ans = await base.fetcher(url, timeoutMs);
        if (ans.status === 429) { pausedAtMs = base.nowMs(); saveTimes(); }
        keep(atMs, { atMs, url, status: ans.status, json: ans.json, ...(ans.text !== undefined ? { text: ans.text } : {}) });
        return ans;
      } catch (e) {
        keep(atMs, { atMs, url, error: String(e) });
        throw e;
      }
    },
  });

  const saveTimes = () => {
    if (keptD !== null) return;
    mkdirSync(a.dir, { recursive: true });
    writeFileSync(askedFile, JSON.stringify({ atMs: listsAskedMs, pausedAtMs }));
  };
  let lists: Lists | null = null;
  // When the last read of the lists began, whether or not it came back whole. Kept in a file too:
  // on 2026-11-18 a restart of the dev server forgot it and the lists were read 4 min 14 s after
  // the read before, inside the five minutes. A new server now starts from the file's time.
  const askedFile = join(a.dir, "lists-asked.json");
  let listsAskedMs: number | null = null;
  let pausedAtMs: number | null = null; // the last 429 seen from this folder, kept across a restart too (audit, finding 5)
  if (keptD === null) try {
    const f = JSON.parse(readFileSync(askedFile, "utf8")) as { atMs?: unknown; pausedAtMs?: unknown };
    if (typeof f.atMs === "number" && Number.isFinite(f.atMs)) listsAskedMs = f.atMs;
    if (typeof f.pausedAtMs === "number" && Number.isFinite(f.pausedAtMs) && f.pausedAtMs <= base.nowMs()) pausedAtMs = f.pausedAtMs; // a time ahead of the clock is not a 429 that happened (audit round 2)
  } catch {
    // no file yet: nothing was asked from this folder
  }
  let reading: Promise<Lists> | null = null;
  const books = new Map<string, BookAnswer>();
  // By ticker, as last asked for: the event, or the error where the read failed. A failed read is
  // kept as long as a good one, so opening the pool again does not ask again (audit, finding 3).
  const events = new Map<string, { atMs: number; event?: ListedEvent; error?: string }>();
  const fresh = () => [...events.values()].filter((e) => e.event !== undefined && (keptD !== null || base.nowMs() - e.atMs < BOOK_KEEP_MS));
  const withEvents = (l: Lists): Lists => {
    const f = fresh();
    return { ...l, events: f.map((e) => e.event!), eventsAtMs: f.reduce((n, e) => Math.max(n, e.atMs), 0) || l.eventsAtMs };
  };
  let poolTurn: Promise<unknown> = Promise.resolve();

  async function readLists(): Promise<Lists> {
    const settings = await r.settings();
    const pools = await r.listPools();
    return { settings, pools, events: [], eventsAtMs: stamp() };
  }

  return {
    /** The lists: the last read while it is under five minutes old (or a read that failed under
     * five minutes ago: the page waits, it does not ask again), otherwise a new one. */
    async screen(): Promise<Lists> {
      if (reading !== null) return reading.then(withEvents);
      const now = base.nowMs();
      if (keptD !== null && lists !== null) return withEvents(lists);
      if (keptD === null && listsAskedMs !== null && now - listsAskedMs < LISTS_EVERY_MS + 2_000) { // two seconds over: a read on 2026-11-18 began 94 ms short of five minutes after the one before
        if (lists !== null) return withEvents(lists);
        throw new Error("the lists were asked for under five minutes ago and this server holds no answer (the read failed, or the server was restarted); the next is not before " + new Date(listsAskedMs + LISTS_EVERY_MS).toISOString());
      }
      listsAskedMs = now;
      saveTimes();
      reading = readLists().then((l) => (lists = l)).finally(() => { reading = null; });
      return reading.then(withEvents);
    },

    /** An opened pool: each of its events by ticker, then the books of their contracts with both
     * prices, each asked at most once in `BOOK_KEEP_MS`. One pool at a time: a second opening
     * waits for the first. A 429 ends the opening; what was read before it is still answered. */
    async pool(poolKey: string): Promise<PoolAnswer> {
      if (lists === null) throw new Error("the lists have not been read");
      const tickers = lists.pools.rows.filter((row) => row.poolKey === poolKey).map((row) => row.ticker);
      if (tickers.length === 0) throw new Error("no pool " + poolKey + " on the reward list as last read");
      const run = poolTurn.then(async () => {
        const out: PoolAnswer = { events: [], books: {}, errors: [] };
        const stopped = (e: unknown) => e instanceof Error && e.constructor.name === "Stopped";
        for (const ticker of tickers) {
          const had = events.get(ticker);
          if (had !== undefined && (keptD !== null || base.nowMs() - had.atMs < KEEP)) {
            if (had.event !== undefined) out.events.push(had.event);
            else out.errors.push(ticker + ": " + had.error + " (not asked again before " + new Date(had.atMs + BOOK_KEEP_MS).toISOString() + ")");
            continue;
          }
          try {
            const event = await r.event(ticker);
            events.set(ticker, { atMs: stamp(), event });
            out.events.push(event);
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            events.set(ticker, { atMs: stamp(), error });
            out.errors.push(ticker + ": " + error);
            if (stopped(e)) return out;
          }
        }
        for (const symbol of symbolsToRead(out.events, a.unreadToo === true)) {
          const had = books.get(symbol);
          if (had !== undefined && (keptD !== null || base.nowMs() - had.atMs < KEEP)) { out.books[symbol] = had; continue; }
          try {
            const book = await r.book(symbol, 0);
            const ans = { atMs: stamp(), book };
            books.set(symbol, ans);
            out.books[symbol] = ans;
          } catch (e) {
            const ans = { atMs: base.nowMs(), book: null, error: e instanceof Error ? e.message : String(e) };
            books.set(symbol, ans);
            out.books[symbol] = ans;
            if (stopped(e)) { out.errors.push("stopped at " + symbol + ": the exchange asked for a pause"); return out; }
          }
        }
        return out;
      });
      poolTurn = run.catch(() => undefined);
      return run;
    },
  };
}
