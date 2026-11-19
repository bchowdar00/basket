// The operator's screen reads the forward run's own recorded answers, read again through the
// engine's own reader: no second parser of Gemini's answers, and the screen sees exactly what the
// pass saw. Pure: the lines come from the caller.
import type { Settings } from "@app/score";
import { reader, type Answer, type ListedEvent, type Pools } from "../../services/engine/src/gemini.ts";

export type ReadLine = { atMs: number; url: string; status?: number; json?: unknown; text?: string; error?: string };
export type Replayed = { settings: Settings; pools: Pools; events: ListedEvent[]; eventsAtMs: number; poolsAtMs: number };

const BASE = "https://api.gemini.com/v1/prediction-markets/";
const firstEventsPage = (category: string) => BASE + "events?status=active&category=" + encodeURIComponent(category) + "&limit=100&offset=0";
const firstRewardsPage = BASE + "liquidity-rewards/events?limit=100&offset=0";
const CONFIG = BASE + "liquidity-rewards/config";
const isEvents = (url: string) => url.startsWith(BASE + "events?");
const isRewards = (url: string) => url.startsWith(BASE + "liquidity-rewards/events?");

class Missing extends Error {}

/** The answers of one read of a list: from the line at `i` (its first page) to the next first page. */
function windowAt(lines: ReadLine[], i: number, first: string, isPage: (url: string) => boolean): Map<string, ReadLine> {
  const m = new Map<string, ReadLine>();
  for (let j = i; j < lines.length; j++) {
    if (j > i && lines[j].url === first) break;
    if (isPage(lines[j].url)) m.set(lines[j].url, lines[j]); // a page asked twice in one read: the later answer, as the reader took it
  }
  return m;
}

const lastIndexBefore = (lines: ReadLine[], url: string, beforeIdx: number) => {
  for (let j = beforeIdx; j >= 0; j--) if (lines[j].url === url) return j;
  return -1;
};

/** The last whole pass in `lines` (in the order they were written), read again. */
export async function replay(lines: ReadLine[], category: string): Promise<Replayed> {
  const first = firstEventsPage(category);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].url !== first) continue;
    const ri = lastIndexBefore(lines, firstRewardsPage, i), ci = lastIndexBefore(lines, CONFIG, i);
    if (ri < 0 || ci < 0) continue;
    const answers = new Map([...windowAt(lines, i, first, isEvents), ...windowAt(lines, ri, firstRewardsPage, isRewards), [CONFIG, lines[ci]] as const]);
    let clock = 0;
    const r = reader({
      async fetcher(url: string): Promise<Answer> {
        const a = answers.get(url);
        if (a === undefined || a.status === undefined) throw new Missing(url);
        return { status: a.status, json: a.json, ...(a.text !== undefined ? { text: a.text } : {}) };
      },
      async sleep(ms: number) { clock += ms; },
      nowMs: () => clock,
    });
    try {
      const settings = await r.settings();
      const pools = await r.listPools();
      const events = await r.listEvents(category);
      return { settings, pools, events: events.events, eventsAtMs: lines[i].atMs, poolsAtMs: lines[ri].atMs };
    } catch {
      continue; // a read still under way, or one that failed: the one before it
    }
  }
  throw new Error("replay: no whole pass of " + category + " in the answers kept");
}
