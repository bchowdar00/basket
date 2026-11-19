// Every value in this file is invented. None is a reading of any market.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Answer, Deps } from "../../services/engine/src/gemini.ts";
import { BOOK_KEEP_MS, LISTS_EVERY_MS, liveFeed, symbolsToRead } from "./live.ts";

const B = "https://api.gemini.com/v1/prediction-markets/";
const contract = (symbol: string, bid: string | null, ask: string | null) => ({
  instrumentSymbol: symbol, status: "active", marketState: "open", priceIncrement: "0.01",
  prices: { ...(bid !== null ? { bestBid: bid } : {}), ...(ask !== null ? { bestAsk: ask } : {}),
    buy: { ...(ask !== null ? { yes: ask } : {}), ...(bid !== null ? { no: (1 - Number(bid)).toFixed(2) } : {}) },
    sell: { ...(bid !== null ? { yes: bid } : {}), ...(ask !== null ? { no: (1 - Number(ask)).toFixed(2) } : {}) } },
});

/** A made-up exchange: one sport event with two contracts (one with a side missing), one reward row. */
function world(over: { status429For?: string; dir?: string } = {}) {
  const sent: { url: string; atMs: number }[] = [];
  const failing: string[] = [];
  let now = 1_000_000;
  const deps: Deps = {
    async fetcher(url): Promise<Answer> {
      sent.push({ url, atMs: now });
      if (failing.some((f) => url.includes(f))) return { status: 500, json: null };
      if (over.status429For !== undefined && url.includes(over.status429For)) return { status: 429, json: null };
      if (url.endsWith("liquidity-rewards/config")) return { status: 200, json: { max_spread_cents: 10, min_payout_threshold_usd: "1.00", enabled: true, min_size_threshold: "100", min_spread_floor: "0.001", spread_penalty_exponent: "2" } };
      if (url.startsWith(B + "liquidity-rewards/events")) return { status: 200, json: { last_score_date: "2026-01-01", pagination: { limit: 100, offset: 0, total: 1 }, events: [{ event_ticker: "MADEUP", title: "Made up", category: "Pro Made-Up", daily_pool_usd: "10.00", pool_source: "category_default", ends_at: null, qualifying_maker_count: 2, pool_id: null, pool_event_count: 1, pool_category_name: null }] } };
      if (url === B + "events/MADEUP") return { status: 200, json: { ticker: "MADEUP", title: "Made up", category: "Sports", isLive: false, startTime: "2030-01-01T00:00:00Z", volume: "1", contracts: [contract("GEMI-MADEUP-A", "0.40", "0.44"), contract("GEMI-MADEUP-B", null, "0.09")] } };
      if (url.includes("/book/")) return { status: 200, json: { bids: [{ price: "0.40", amount: "200" }], asks: [{ price: "0.44", amount: "150" }] } };
      throw new Error("not a request this test expects: " + url);
    },
    async sleep(ms) { now += ms; },
    nowMs: () => now,
  };
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), "live-test-"));
  return { feed: liveFeed({ dir, deps }), sent, dir, tick: (ms: number) => { now += ms; }, fail: (part: string) => { failing.push(part); } };
}

describe("liveFeed", () => {
  it("reads the settings and the reward list once, then not again inside five minutes, and keeps each answer raw", async () => {
    const w = world();
    const first = await w.feed.screen();
    expect(first.pools.rows.map((r) => r.ticker)).toEqual(["MADEUP"]);
    expect(first.events).toEqual([]);
    expect(w.sent.length).toBe(2);
    w.tick(LISTS_EVERY_MS - 10_000); // the pacing wait moved the clock on from the read's start
    await w.feed.screen();
    expect(w.sent.length).toBe(2);
    w.tick(10_000);
    await w.feed.screen();
    expect(w.sent.length).toBe(2); // five minutes after the read's start, and inside the two seconds' margin
    w.tick(2_000);
    await w.feed.screen();
    expect(w.sent.length).toBe(4);
    expect(readdirSync(join(w.dir, "reads")).length).toBe(1);
  });

  it("keeps the five minutes across a restart of the server", async () => {
    const w = world();
    await w.feed.screen();
    const again = world({ dir: w.dir }); // a new server on the same folder, its clock at the same start
    await expect(again.feed.screen()).rejects.toThrow(/not before/);
    expect(again.sent.length).toBe(0);
  });

  it("never sends two requests closer than 1.2 seconds", async () => {
    const w = world();
    await w.feed.screen();
    await w.feed.pool("event:MADEUP");
    expect(w.sent.length).toBe(4);
    for (let i = 1; i < w.sent.length; i++) expect(w.sent[i].atMs - w.sent[i - 1].atMs).toBeGreaterThanOrEqual(1_200);
  });

  it("opens a pool: its event by ticker, a book only for a contract with both prices, once an opening", async () => {
    const w = world();
    await w.feed.screen();
    const got = await w.feed.pool("event:MADEUP");
    expect(got.events.map((e) => e.ticker)).toEqual(["MADEUP"]);
    expect(Object.keys(got.books)).toEqual(["GEMI-MADEUP-A"]);
    expect(got.books["GEMI-MADEUP-A"].book).toEqual({ bids: [{ cents: 40, qty: 200 }], asks: [{ cents: 44, qty: 150 }] });
    expect(got.errors).toEqual([]);
    const n = w.sent.length;
    await w.feed.pool("event:MADEUP");
    expect(w.sent.length).toBe(n);
    expect((await w.feed.screen()).events.map((e) => e.ticker)).toEqual(["MADEUP"]); // the page gets the event back on its next refresh
    w.tick(BOOK_KEEP_MS);
    await w.feed.pool("event:MADEUP");
    expect(w.sent.length).toBe(n + 2);
  });

  it("does not ask the lists again after a 429 until five minutes have passed", async () => {
    const w = world({ status429For: "liquidity-rewards/events" });
    await expect(w.feed.screen()).rejects.toThrow();
    const n = w.sent.length;
    await expect(w.feed.screen()).rejects.toThrow(/not before/);
    expect(w.sent.length).toBe(n);
  });

  it("stops an opening at a 429 and asks nothing more in it", async () => {
    const w = world({ status429For: "/book/" });
    await w.feed.screen();
    const got = await w.feed.pool("event:MADEUP");
    expect(got.books["GEMI-MADEUP-A"].book).toBeNull();
    expect(got.errors.length).toBe(1);
  });

  it("asks for an unread contract's book only when told to", () => {
    const e = { ticker: "T", title: "", category: "Sports", subcategory: null, startMs: 0, live: false, volume: null,
      contracts: [{ symbol: "T-A", stepCents: 1, top: { bidCents: 40, askCents: 44 } }, { symbol: "T-B", stepCents: 1, top: { bidCents: null, askCents: 3 } }], unread: ["T-C", ""] };
    expect(symbolsToRead([e])).toEqual(["T-A"]);
    expect(symbolsToRead([e], true)).toEqual(["T-C", "T-A"]);
    expect(symbolsToRead([{ ...e, live: true }], true)).toEqual([]);
  });

  // Audit of 2026-11-18, finding 3.
  it("does not ask again for an event whose read failed, inside five minutes", async () => {
    const w = world({ status429For: "nothing" });
    await w.feed.screen();
    const sentBefore = w.sent.length;
    w.fail("events/MADEUP");
    const first = await w.feed.pool("event:MADEUP");
    expect(first.errors.length).toBe(1);
    const n = w.sent.length;
    expect(n).toBe(sentBefore + 1);
    const second = await w.feed.pool("event:MADEUP");
    expect(second.errors.length).toBe(1);
    expect(w.sent.length).toBe(n);
  });

  // Audit round 2: a stop time later than the clock (the clock moved back across a restart) is not trusted.
  it("ignores a kept 429 time that is later than now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-test-"));
    writeFileSync(join(dir, "lists-asked.json"), JSON.stringify({ atMs: null, pausedAtMs: 1_000_000 + 3_600_000 }));
    const w = world({ dir });
    await w.feed.screen();
    expect(w.sent[0].atMs).toBe(1_000_000);
  });

  it("serves the kept answers again and asks nothing", async () => {
    const w = world();
    await w.feed.screen();
    const live = await w.feed.pool("event:MADEUP");
    const n = w.sent.length;
    const kept = liveFeed({ dir: w.dir, kept: true, deps: { fetcher: async () => { throw new Error("a request was sent"); }, sleep: async () => undefined, nowMs: () => 0 } });
    const lists = await kept.screen();
    expect(lists.pools.rows.map((r) => r.ticker)).toEqual(["MADEUP"]);
    const again = await kept.pool("event:MADEUP");
    expect(again.events).toEqual(live.events);
    expect(again.books["GEMI-MADEUP-A"].book).toEqual(live.books["GEMI-MADEUP-A"].book);
    expect(again.books["GEMI-MADEUP-A"].atMs).toBe(w.sent[n - 1].atMs); // the time shown is the kept answer's own
    expect((await kept.screen()).events.length).toBe(1);
    expect(w.sent.length).toBe(n);
    expect(readdirSync(join(w.dir, "reads")).length).toBe(1); // nothing written either
  });

  it("refuses a pool before the lists are read, and a pool the list does not name", async () => {
    await expect(world().feed.pool("event:MADEUP")).rejects.toThrow(/have not been read/);
    const w = world();
    await w.feed.screen();
    await expect(w.feed.pool("event:NOPE")).rejects.toThrow(/no pool/);
  });
});
