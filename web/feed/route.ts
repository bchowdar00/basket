// A dev-server route that serves the operator's screen its input. It reads the forward run's own
// recorded folder, read-only, and hands back the same `ScreenIn` the screen's tests build by hand:
// the last whole pass replayed through the engine's own reader, and the pass rows of the last week.
//
// It never asks the exchange anything and never writes: it opens the newest read file for reading,
// takes only its tail, and streams the ledger a line at a time. The pure parts (finding gzip members
// in a buffer, reading a ledger line) are exported and tested; the file reading is the plugin's.

import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import type { Plugin } from "vite";
import type { PassRow } from "@app/ledger";
import { liveFeed } from "./live.ts";
import { replay, type ReadLine } from "./replay.ts";

const TAIL_BYTES = 96 * 1024 * 1024; // the most of a read file to look at; the file is tens of GB inflated
const WEEK_MS = 7 * 24 * 3_600_000;
const [MAGIC0, MAGIC1, MAGIC2] = [0x1f, 0x8b, 0x08]; // a gzip member: the magic and the deflate method

/** The offsets in `buf` where a gzip member could start: the bytes 1f 8b 08. Some are false, inside a
 * member's own compressed bytes; `readMembers` tells the real ones by trying to inflate. */
export function gzipMemberStarts(buf: Buffer): number[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === MAGIC0 && buf[i + 1] === MAGIC1 && buf[i + 2] === MAGIC2) starts.push(i);
  }
  return starts;
}

/** Each line of a read file is its own gzip member, so the whole file is never inflated. From each
 * candidate start, one member is inflated: the end is taken at the next candidate and extended to the
 * one after until it inflates, or to the buffer's end. A candidate that never inflates (a false magic,
 * or the partial member the tail begins in) is skipped. Each inflated member parses to one read line. */
export function readMembers(buf: Buffer): ReadLine[] {
  const starts = gzipMemberStarts(buf);
  const lines: ReadLine[] = [];
  let i = 0;
  while (i < starts.length) {
    let advanced = false;
    for (let j = i + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buf.length;
      let out: Buffer;
      try {
        out = gunzipSync(buf.subarray(starts[i], end));
      } catch {
        continue; // a truncated member or a false magic: widen the end and try again
      }
      for (const raw of out.toString("utf8").split("\n")) {
        const t = raw.trim();
        if (t === "") continue;
        try {
          lines.push(JSON.parse(t) as ReadLine);
        } catch {
          // a line that is not JSON is dropped; the pass is rebuilt only from the lines that read
        }
      }
      i = j;
      advanced = true;
      break;
    }
    if (!advanced) i++;
  }
  return lines;
}

/** A ledger line is `{"row":{...},...}`; this returns the row when it is a pass, else null. */
export function parseLedgerPass(line: string): PassRow | null {
  const t = line.trim();
  if (t === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const row = (obj as { row?: unknown }).row;
  if (typeof row !== "object" || row === null || (row as { kind?: unknown }).kind !== "pass") return null;
  return row as PassRow;
}

/** The pass rows of the last `days` days before `nowMs`, read from ledger lines. */
export function recentPasses(lines: Iterable<string>, nowMs: number, days = 7): PassRow[] {
  const cutoff = nowMs - days * 24 * 3_600_000;
  const out: PassRow[] = [];
  for (const line of lines) {
    const p = parseLedgerPass(line);
    if (p !== null && typeof p.atMs === "number" && p.atMs >= cutoff) out.push(p);
  }
  return out;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** The newest read file's tail, inflated member by member. */
function readTail(readsDir: string): ReadLine[] {
  const names = readdirSync(readsDir).filter((f) => f.endsWith(".jsonl.gz")).sort();
  if (names.length === 0) throw new Error("no reads/*.jsonl.gz in " + readsDir);
  const newest = join(readsDir, names[names.length - 1]);
  const size = statSync(newest).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(newest, "r"); // read-only
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return readMembers(buf);
}

/** The pass rows of the last week, streamed a line at a time so the whole ledger is never held. */
async function ledgerPasses(ledgerPath: string, nowMs: number): Promise<PassRow[]> {
  const cutoff = nowMs - WEEK_MS;
  const out: PassRow[] = [];
  const rl = createInterface({ input: createReadStream(ledgerPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const p = parseLedgerPass(line);
    if (p !== null && typeof p.atMs === "number" && p.atMs >= cutoff) out.push(p);
  }
  return out;
}

async function buildScreenIn(): Promise<unknown> {
  const dir = expandHome(process.env.BASKET_FORWARD_DIR ?? "~/Data/hackathons/vault/forward");
  const nowMs = Date.now();
  const lines = readTail(join(dir, "reads"));
  const replayed = await replay(lines, "Sports");
  const passes = await ledgerPasses(join(dir, "ledger.jsonl"), nowMs);
  const rows = replayed.pools.rows.map(({ raw, ...rest }) => rest); // the raw row is not sent to the browser
  return {
    settings: replayed.settings,
    pools: { ...replayed.pools, rows },
    events: replayed.events,
    eventsAtMs: replayed.eventsAtMs,
    passes,
  };
}

async function buildLive(live: ReturnType<typeof liveFeed>): Promise<unknown> {
  const l = await live.screen();
  let passes: PassRow[] = [];
  try {
    passes = await ledgerPasses(join(expandHome(process.env.BASKET_FORWARD_DIR ?? "~/Data/hackathons/vault/forward"), "ledger.jsonl"), Date.now());
  } catch {
    // no ledger on this Mac: the week strip is empty, the lists are still shown
  }
  return { source: "live", kept: process.env.BASKET_FEED === "kept", settings: l.settings, pools: { ...l.pools, rows: l.pools.rows.map(({ raw, ...rest }) => rest) }, events: l.events, eventsAtMs: l.eventsAtMs, passes };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** The dev-server plugin: GET /feed/screen, from the local host only. */
export function feedRoute(): Plugin {
  return {
    name: "basket-feed-screen",
    configureServer(server) {
      // BASKET_FEED=live: the lists and an opened pool's books are read from Gemini itself, under
      // the limits in `live.ts`; otherwise the forward run's recorded folder, and nothing is asked.
      const live = process.env.BASKET_FEED === "live" || process.env.BASKET_FEED === "kept" ? liveFeed({ kept: process.env.BASKET_FEED === "kept", dir: expandHome(process.env.BASKET_LIVE_DIR ?? "~/Data/hackathons/vault/live"), unreadToo: process.env.BASKET_READ_UNREAD === "1" }) : null;
      const local = (req: IncomingMessage) => {
        const port = (req.socket as { localPort?: number }).localPort;
        const host = req.headers.host ?? "";
        // A page of another site open in the same browser could point an image at this route, and the
        // browser would send this Host itself; it also says where the request came from, and anything
        // but this page is refused (audit of 2026-11-18, finding 4). A request with no such header is
        // not a browser's (a local tool).
        const site = req.headers["sec-fetch-site"];
        if (site !== undefined && site !== "same-origin") return false;
        return host === "127.0.0.1:" + port || host === "localhost:" + port;
      };
      server.middlewares.use("/feed/pool", async (req: IncomingMessage, res: ServerResponse) => {
        if (!local(req)) return send(res, 403, { error: "the feed answers the local host only" });
        if (live === null) return send(res, 404, { error: "nothing is asked for from the recorded folder" });
        const pool = new URL(req.url ?? "", "http://x").searchParams.get("pool");
        if (pool === null || pool === "") return send(res, 400, { error: "no pool named" });
        try {
          send(res, 200, await live.pool(pool));
        } catch (e) {
          send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
      server.middlewares.use("/feed/screen", async (req: IncomingMessage, res: ServerResponse) => {
        if (!local(req)) return send(res, 403, { error: "the feed answers the local host only" });
        try {
          send(res, 200, live === null ? { source: "recorded", ...((await buildScreenIn()) as object) } : await buildLive(live));
        } catch (e) {
          send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
