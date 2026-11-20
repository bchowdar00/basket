// The shared reader for the public page's first step: ONE reader for every visitor. It reads
// Gemini's public reward list and, pool by pool, each pool's events and books, through the same
// paced reader the operator's own screen uses (`web/feed/live.ts`: 1.2 seconds between requests, a
// minute's stop after a 429, every raw answer kept in a folder outside the repository), and keeps
// the last answer for each pool in memory. A visitor's request is answered from that memory and
// never causes a request to Gemini. Nothing here places an order or sends anything but a public GET.
import type { Book, Settings } from "@app/score";
import type { ListedEvent, Pools } from "../../engine/src/gemini.ts";
import { screenOf } from "../../../web/src/pools.ts";
import { poolsToRead, SKIP_CATEGORIES } from "../../../web/src/screen/readall.ts";

export type Lists = { settings: Settings; pools: Pools; events: ListedEvent[]; eventsAtMs: number };
export type PoolAnswer = { events: ListedEvent[]; books: Record<string, { atMs: number; book: Book | null; error?: string }>; errors: string[] };
/** What the reader needs of `liveFeed`: the lists, and one pool. */
export type Feed = { screen(): Promise<Lists>; pool(key: string): Promise<PoolAnswer> };

export type Kept = { atMs: number; events: ListedEvent[]; books: Record<string, Book> };
export type PassState = { startedAtMs: number | null; finishedAtMs: number | null; done: number; total: number; note: string | null };

/** How long after a pass began the next may begin, and how recently somebody must have asked. */
export const PASS_EVERY_MS = 75 * 60_000;
export const VISIT_KEEPS_MS = 30 * 60_000;
const PAUSE_MS = 65_000;

export function sharedReader(a: { feed: Feed; nowMs: () => number; sleep: (ms: number) => Promise<void>; log?: (line: string) => void }) {
  let lists: Lists | null = null;
  const pools = new Map<string, Kept>();
  const pass: PassState = { startedAtMs: null, finishedAtMs: null, done: 0, total: 0, note: null };
  let running = false;
  let lastVisitMs: number | null = null;
  const log = a.log ?? (() => {});

  /** One pass: the lists, then every pool the operator's own run would read, in its order. A pool
   * cut short by a pause is asked for once more after the pause; a pool that still fails keeps the
   * copy read before, if there is one. */
  async function runPass(): Promise<void> {
    if (running) return;
    running = true;
    pass.startedAtMs = a.nowMs();
    pass.finishedAtMs = null;
    pass.done = 0;
    pass.note = null;
    try {
      lists = await a.feed.screen();
      const sport = screenOf({ settings: lists.settings, pools: lists.pools, events: [], eventsAtMs: lists.eventsAtMs, passes: [] }, a.nowMs()).sport;
      const keys = poolsToRead(sport, new Set<string>(), SKIP_CATEGORIES).map((p) => p.key);
      pass.total = keys.length;
      // A pool no longer on the list is dropped, so the page never shows a pool Gemini took off.
      for (const k of [...pools.keys()]) if (!keys.includes(k)) pools.delete(k);
      for (const key of keys) {
        for (let attempt = 0; attempt < 2; attempt++) {
          let got: PoolAnswer;
          try {
            got = await a.feed.pool(key);
          } catch (e) {
            log("pool " + key + ": " + (e instanceof Error ? e.message : String(e)));
            break;
          }
          const paused = got.errors.some((e) => e.includes("pause") || e.includes("Stopped") || e.includes("429"));
          if (paused && attempt === 0) {
            pass.note = "Gemini asked for a pause; waiting a minute";
            await a.sleep(PAUSE_MS);
            pass.note = null;
            continue;
          }
          if (got.events.length > 0) {
            const books: Record<string, Book> = {};
            for (const [symbol, b] of Object.entries(got.books)) if (b.book !== null) books[symbol] = b.book;
            pools.set(key, { atMs: a.nowMs(), events: got.events, books });
          }
          break;
        }
        pass.done++;
      }
    } catch (e) {
      pass.note = "the last read did not finish: " + (e instanceof Error ? e.message : String(e));
      log(pass.note);
    } finally {
      pass.finishedAtMs = a.nowMs();
      running = false;
    }
  }

  return {
    runPass,
    /** Called on a timer: starts a pass when none has run, or when the last began long enough ago and somebody has asked lately. */
    due(): boolean {
      if (running) return false;
      const now = a.nowMs();
      if (pass.startedAtMs === null) return true;
      if (lists === null) return now - pass.startedAtMs > 6 * 60_000; // the lists never came: tried again once their five minutes have passed
      if (now - pass.startedAtMs < PASS_EVERY_MS) return false;
      return lastVisitMs !== null && now - lastVisitMs < VISIT_KEEPS_MS;
    },
    visited(): void { lastVisitMs = a.nowMs(); },
    /** What the page's first request gets: the lists as last read, or null before the first read. */
    screen(): unknown {
      if (lists === null) return null;
      return {
        source: "live", shared: true, settings: lists.settings,
        pools: { ...lists.pools, rows: lists.pools.rows.map(({ raw, ...rest }) => rest) }, // the raw row is not sent to the browser
        events: [], eventsAtMs: lists.eventsAtMs, passes: [], pass: { ...pass },
      };
    },
    /** Every pool read so far, by key. */
    pools(): unknown {
      return { pools: Object.fromEntries(pools), pass: { ...pass } };
    },
    state: () => ({ ...pass, running, pools: pools.size }),
  };
}
