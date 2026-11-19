// Every value in this file is invented. None is a reading of any market.
//
// A made-up clock and a made-up fetcher stand in for the exchange: `sleep(ms)` adds to `now` and
// records the wait, and `fetcher` records `[url, now]` and answers from a script. No test reaches
// the network. Every ticker, price and amount below is made up.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reader, toEventIn, nodeDeps, NoAnswer, Stopped, BadAnswer, NotYet } from "../src/gemini.ts";
import { decide, readRule } from "@app/rule";
import { mostOthersScore, readSettings } from "@app/score";

// A category name used where the test does not care which category it is. Test 9 checks that no
// such invented name leaks into the module's source.
const CAT = "Zeta Quadrant";

type Scripted = { status: number; json: unknown } | { noAnswer: true };
const NO: Scripted = { noAnswer: true };
const ok = (json: unknown): Scripted => ({ status: 200, json });

// sleepMode shapes the made-up clock's sleep. "sync" (the default) adds to `now` and resolves at
// once. "async" gives up its turn (resolves on a later tick with setImmediate) before adding, so a
// race between concurrent calls can actually show. "half" advances the clock by only half of what
// was asked (at least one tick), to prove the pacing wait is a loop that looks at the clock again.
function makeWorld(responder: (i: number, url: string) => Scripted, sleepMode: "sync" | "async" | "half" = "sync") {
  let now = 0;
  const sleeps: number[] = [];
  const calls: [string, number][] = [];
  let i = 0;
  const d = {
    nowMs: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      if (sleepMode === "half") { now += Math.max(1, Math.floor(ms / 2)); return Promise.resolve(); }
      if (sleepMode === "async") return new Promise<void>((r) => setImmediate(() => { now += ms; r(); }));
      now += ms;
      return Promise.resolve();
    },
    fetcher: (url: string) => {
      calls.push([url, now]);
      const r = responder(i++, url);
      if ("noAnswer" in r) return Promise.reject(new NoAnswer("made-up timeout"));
      return Promise.resolve({ status: r.status, json: r.json });
    },
  };
  return { d, sleeps, calls };
}
const fromList = (list: Scripted[]) => (i: number) => list[i];

// --- builders; every field invented ---
const anEvent = (ticker: string, over: Record<string, unknown> = {}) => ({ ticker, title: "a made-up title", isLive: false, ...over });
// The exchange writes each best price three times and always sends `buy` and `sell`: `bestBid`
// again as `sell.yes` and, taken from a dollar, as `buy.no`; `bestAsk` again as `buy.yes` and,
// taken from a dollar, as `sell.no`. A test that gives only the best prices gets the twins made
// from the same values here (none for a price that is absent, null or empty; for a value that is
// no price at all the twin just repeats it). A test that gives any other key is left as written.
const withTwins = (prices: unknown): unknown => {
  if (typeof prices !== "object" || prices === null || Array.isArray(prices)) return prices;
  const p = prices as Record<string, unknown>;
  if (Object.keys(p).some((k) => k !== "bestBid" && k !== "bestAsk")) return prices;
  const none = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  const other = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1 ? (1 - n).toFixed(2) : v; };
  const buy: Record<string, unknown> = {}, sell: Record<string, unknown> = {};
  if (!none(p.bestAsk)) { buy.yes = p.bestAsk; sell.no = other(p.bestAsk); }
  if (!none(p.bestBid)) { sell.yes = p.bestBid; buy.no = other(p.bestBid); }
  return { buy, sell, ...p };
};
const aContract = (symbol: string, over: Record<string, unknown> = {}) => {
  const c: Record<string, unknown> = { instrumentSymbol: symbol, status: "active", marketState: "open", priceIncrement: "0.01", prices: { bestBid: "0.40", bestAsk: "0.60" }, ...over };
  return { ...c, prices: withTwins(c.prices) };
};
// A made-up list served the way the exchange serves one: by the offset and limit in the address.
// `at(i)` gives the list as it stands at the i-th request, so a test can move it between pages.
const offsetOf = (url: string) => Number(new URL(url).searchParams.get("offset"));
const served = (at: (i: number) => unknown[], key: "data" | "events" = "data", total?: (i: number) => number) => (i: number, url: string): Scripted => {
  const list = at(i);
  const page = list.slice(offsetOf(url), offsetOf(url) + 100);
  return ok({ [key]: page, last_score_date: "2026-02-02", pagination: { limit: 100, offset: offsetOf(url), total: total ? total(i) : list.length } });
};
const aPool = (ticker: string, over: Record<string, unknown> = {}) => ({
  event_ticker: ticker,
  title: "a made-up pool",
  category: "made-up",
  daily_pool_usd: "5.00",
  pool_source: "made-up-source",
  ends_at: null,
  qualifying_maker_count: 0,
  pool_event_count: 1,
  ...over,
});
const eventsPage = (data: unknown[], total: number) => ok({ data, pagination: { limit: 100, offset: 0, total } });
const poolsPage = (events: unknown[], total: number, lastScoreDate: string | null = "2026-02-02") =>
  ok({ events, last_score_date: lastScoreDate, pagination: { limit: 100, offset: 0, total } });
const aConfig = () => ({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: 1, min_payout_threshold_usd: 5, enabled: true });

test("1 eleven pages are read until a short page", async () => {
  // Each page after the first is asked from one item back, so its first item is the last one
  // already read: 100 on the first page and 99 new ones on each page after it.
  const all = Array.from({ length: 1003 }, (_, j) => anEvent(`E${j}`));
  const { d, calls } = makeWorld(served(() => all));
  const out = await reader(d).listEvents("Any Theme");
  assert.deepEqual(out.events.map((e) => e.ticker), all.map((e) => e.ticker));
  assert.equal(calls.length, 11);
  for (let k = 0; k < 11; k++) assert.equal(offsetOf(calls[k][0]), k * 99);
  assert.equal(out.twice, 0);
  assert.equal(out.moved, false);
});

test("1b a short first page ends the read even when the total says there is more", async () => {
  // Three items but a total of 500: the short page must end the read on its own, with no second
  // request. Without the `list.length < PAGE` rule the reader would ask on to offset 100 and beyond.
  const { d, calls } = makeWorld(() => eventsPage([anEvent("E1"), anEvent("E2"), anEvent("E3")], 500));
  const out = await reader(d).listEvents(CAT);
  assert.equal(out.events.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(out.moved, true); // three read against a total of 500: the list is not what it said
});

test("2 reading stops when what has been read reaches the total", async () => {
  // 199 items: the second page (asked from item 99) is a full page of 100 and reaches the total,
  // so there is no third request.
  const all = Array.from({ length: 199 }, (_, j) => anEvent(`E${j}`));
  const { d, calls } = makeWorld(served(() => all));
  const out = await reader(d).listEvents(CAT);
  assert.equal(calls.length, 2);
  assert.equal(out.events.length, 199);
  assert.equal(out.moved, false);
});

test("3 requests are at least 1.2 seconds apart, across functions", async () => {
  const responder = (_i: number, url: string): Scripted => {
    if (url.includes("/config")) return ok(aConfig());
    if (url.includes("liquidity-rewards/events")) return poolsPage([aPool("P1"), aPool("P2")], 2);
    return eventsPage([anEvent("E1", { contracts: [] })], 1);
  };
  const { d, calls } = makeWorld(responder);
  const r = reader(d);
  await r.listPools();
  await r.settings();
  await r.listEvents(CAT);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1], 0);
  for (let k = 1; k < calls.length; k++) assert.ok(calls[k][1] - calls[k - 1][1] >= 1200, `gap before request ${k}`);
});

test("4 a 429 stops the pass", async () => {
  const responder = (_i: number, url: string): Scripted => {
    if (url.includes("liquidity-rewards/events")) return { status: 429, json: null };
    return ok(aConfig());
  };
  const { d, calls } = makeWorld(responder);
  const r = reader(d);
  await assert.rejects(r.listPools(), (e) => e instanceof Stopped);
  assert.equal(calls.length, 1);
  await r.settings();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], 60000);
});

test("5 a page that does not answer is tried once more, then the pass is given up", async () => {
  {
    const { d, calls } = makeWorld(fromList([NO, poolsPage([aPool("P1")], 1)]));
    const out = await reader(d).listPools();
    assert.equal(out.rows.length, 1);
    assert.equal(calls.length, 2);
    // The retry goes through the same queue and the same pacing wait: it is sent at least APART_MS
    // after the request that did not answer, not straight to the fetcher.
    assert.ok(calls[1][1] - calls[0][1] >= 1200, `retry gap ${calls[1][1] - calls[0][1]}`);
  }
  {
    const { d, calls } = makeWorld(fromList([NO, NO]));
    await assert.rejects(reader(d).listPools(), (e) => e instanceof NoAnswer);
    assert.equal(calls.length, 2);
  }
});

test("6 a status of 500 rejects with BadAnswer naming 500", async () => {
  const { d } = makeWorld(() => ({ status: 500, json: null }));
  await assert.rejects(reader(d).listPools(), (e) => e instanceof BadAnswer && /500/.test((e as Error).message));
});

test("7 an answer that is not a list throws", async () => {
  {
    const { d } = makeWorld(() => ok({ data: {}, pagination: { limit: 100, offset: 0, total: 0 } }));
    await assert.rejects(reader(d).listEvents(CAT), (e) => e instanceof BadAnswer);
  }
  {
    const { d } = makeWorld(() => ok({ pagination: { limit: 100, offset: 0, total: 0 } }));
    await assert.rejects(reader(d).listPools(), (e) => e instanceof BadAnswer);
  }
  {
    const { d } = makeWorld(() => ok({ data: [], pagination: { limit: 100, offset: 0, total: "5" } }));
    await assert.rejects(reader(d).listEvents(CAT), (e) => e instanceof BadAnswer);
  }
});

test("8 an answer that never ends is refused", async () => {
  const { d, calls } = makeWorld((i) => eventsPage(Array.from({ length: 100 }, (_, j) => anEvent(`E${i}_${j}`)), 1_000_000_000));
  await assert.rejects(reader(d).listEvents(CAT), (e) => e instanceof BadAnswer);
  assert.equal(calls.length, 100);
});

test("9 the category in the address is built only by encoding the argument", async () => {
  const { d, calls } = makeWorld(() => eventsPage([anEvent("E1", { contracts: [] })], 1));
  await reader(d).listEvents("A & B");
  assert.ok(calls[0][0].includes("category=A%20%26%20B"), calls[0][0]);
  // The only `category=` in the source is immediately followed by the encoded argument, so no
  // category name can be written into the address. (Checking the source does not name the test's
  // own invented categories proved nothing: the source would never hold them in any case.)
  const src = readFileSync(fileURLToPath(new URL("../src/gemini.ts", import.meta.url)), "utf8");
  const at = src.indexOf("category=");
  assert.equal((src.match(/category=/g) || []).length, 1);
  assert.ok(src.slice(at).startsWith('category=" + encodeURIComponent(category)'), src.slice(at, at + 48));
});

test("10 an event's fields", async () => {
  const ev1 = anEvent("E1", {
    startTime: "not-a-real-date",
    volume: "12.50",
    contracts: [
      aContract("C-A", { priceIncrement: "0.01", prices: { bestBid: "0.47", bestAsk: "0.53" } }),
      aContract("C-B", { priceIncrement: "0.05", prices: { bestBid: "0.20", bestAsk: "0.80" } }),
      aContract("C-CLOSED", { status: "inactive", marketState: "closed" }),
      aContract("C-HALF", { priceIncrement: "0.025" }),
    ],
  });
  const ev2 = anEvent("E2", { contracts: [] });
  const { d } = makeWorld(() => eventsPage([ev1, ev2], 2));
  const out = await reader(d).listEvents(CAT);
  const e1 = out.events[0];
  assert.equal(e1.contracts.length, 2);
  assert.deepEqual(e1.unread, ["C-HALF"]); // a closed contract is dropped; the half-cent step is unread
  assert.deepEqual(e1.contracts.map((c) => c.symbol), ["C-A", "C-B"]);
  assert.deepEqual(e1.contracts.map((c) => c.stepCents), [1, 5]);
  assert.deepEqual(e1.contracts[0].top, { bidCents: 47, askCents: 53 });
  assert.deepEqual(e1.contracts[1].top, { bidCents: 20, askCents: 80 });
  assert.equal(e1.startMs, 0);
  assert.equal(e1.live, false);
  assert.equal(e1.volume, 12.5);
  assert.equal(out.events[1].volume, null);
});

test("11 an absent, empty or null price is no price; a zero or a whole dollar is unread", async () => {
  // Kept contracts: a readable cent, or a side with nobody on it (the key absent, empty or null).
  const kept: [string, unknown, number | null][] = [
    ["K0", "0.47", 47], ["K1", "0.470004", 47], ["K2", "", null], ["K3", null, null], ["K4", undefined, null],
  ];
  // Unread contracts: a best price that is there but impossible (zero, or a whole dollar or more).
  const unreadBids = ["0", "0.00", "1.00"];
  const contracts = [
    ...kept.map(([sym, bid]) => aContract(sym, { priceIncrement: "0.01", prices: bid === undefined ? { bestAsk: "0.50" } : { bestBid: bid, bestAsk: "0.50" } })),
    ...unreadBids.map((bid, k) => aContract(`U${k}`, { priceIncrement: "0.01", prices: { bestBid: bid, bestAsk: "0.50" } })),
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
  const out = await reader(d).listEvents(CAT);
  assert.deepEqual(out.events[0].contracts.map((c) => c.symbol), ["K0", "K1", "K2", "K3", "K4"]);
  kept.forEach(([sym, , want], k) => assert.equal(out.events[0].contracts[k].top.bidCents, want, `kept ${sym}`));
  out.events[0].contracts.forEach((c) => assert.equal(c.top.askCents, 50));
  assert.deepEqual(out.events[0].unread, ["U0", "U1", "U2"]);
});

test("17 a tradeable contract that cannot be read is named, not dropped", async () => {
  const contracts = [
    aContract("C-GOOD", { priceIncrement: "0.01", prices: { bestBid: "0.40", bestAsk: "0.60" } }),
    aContract("C-HALFSTEP", { priceIncrement: "0.025", prices: { bestBid: "0.40", bestAsk: "0.60" } }),
    aContract("C-FRACTION", { priceIncrement: "0.01", prices: { bestBid: "0.475", bestAsk: "0.60" } }),
    aContract("C-WORDS", { priceIncrement: "0.01", prices: { bestBid: "0.40", bestAsk: "abc" } }),
    aContract("C-NOSTEP", { priceIncrement: undefined, prices: { bestBid: "0.40", bestAsk: "0.60" } }),
    aContract("C-BADSHAPE", { priceIncrement: "0.01", prices: "0.40/0.60" }), // prices not an object
    aContract("C-INACTIVE", { status: "inactive" }), // not active, but the market is open: unread, not dropped
    aContract("C-DROP", { status: "inactive", marketState: "closed" }), // the only drop
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  assert.deepEqual(e.contracts.map((c) => c.symbol), ["C-GOOD"]);
  assert.deepEqual(e.unread, ["C-HALFSTEP", "C-FRACTION", "C-WORDS", "C-NOSTEP", "C-BADSHAPE", "C-INACTIVE"]); // C-DROP is in neither list
});

test("18 an event with a contract that could not be read is never taken as one where nobody can qualify", () => {
  const rule = readRule({ maxOthersSpreadCents: 14, tendedWithinMs: 3_600_000, stillCents: 2, stillOverMs: 600_000, pullBeforeStartMs: 7_200_000, capPerMarketMicros: 80_000_000, drawMicros: 900_000_000, bondMicros: 500_000_000, reachedMarginCents: 1, readEveryMs: 300_000, sweepsADay: 4, sweepApartMs: 1_200, noSizeBeforeMs: 1_794_895_200_000 });
  const s = readSettings(aConfig());
  const now = 1_000_000_000_000;
  const wide = { bidCents: 30, askCents: 70 }; // wider than the widest spread: nobody can hold a pair in it
  const base = { ticker: "E1", title: "t", category: "c", subcategory: null, startMs: now + 86_400_000, live: false, volume: 0, contracts: [{ symbol: "C-GOOD", stepCents: 1, top: wide }] };
  const pool = { ticker: "E1", title: "t", category: "c", poolMicrosADay: 5_000_000, source: "s", endsAtMs: null, makers: 0, poolId: null, poolEventCount: 1, poolName: null, poolKey: "event:E1", raw: {} };
  const logOf = () => [{ atMs: now, top: wide }];
  const held = { filled: new Set<string>(), tiedUpMicros: 0, quoted: new Set<string>() };

  const withUnread = toEventIn({ ...base, unread: ["C-FRACTION"] }, pool, logOf);
  assert.deepEqual(withUnread.contracts.map((c) => [c.symbol, c.log.length]), [["C-GOOD", 1], ["C-FRACTION", 0]]);
  assert.deepEqual(decide(rule, s, [withUnread], held, now), [{ event: "E1", symbol: null, pair: null, reason: "others-may-qualify" }]);

  const allRead = decide(rule, s, [toEventIn({ ...base, unread: [] }, pool, logOf)], held, now);
  assert.ok(allRead.length > 0 && allRead.every((x) => x.reason !== "others-may-qualify")); // the same event, all read, gets past that gate
});

test("12 a pool row keeps every field", async () => {
  const rowA = aPool("P1", { pool_id: 7, pool_event_count: 12, pool_category_name: "A Named Pool", extra_thing: "keepme" });
  const rowB = aPool("P2", { pool_event_count: 1 });
  const { d } = makeWorld(() => poolsPage([rowA, rowB], 2));
  const out = await reader(d).listPools();
  const a = out.rows[0];
  const b = out.rows[1];
  assert.equal(a.poolKey, "id:7");
  assert.equal(a.poolId, 7);
  assert.equal(a.poolEventCount, 12);
  assert.equal(a.poolName, "A Named Pool");
  assert.equal(a.raw.extra_thing, "keepme");
  assert.equal(b.poolKey, "event:P2");
  assert.equal(b.poolId, null);
  assert.equal(b.poolName, null);
  assert.equal(b.poolEventCount, 1);
});

test("13 dollars to millionths from the text", async () => {
  const rows = [aPool("P1", { daily_pool_usd: "250.00" }), aPool("P2", { daily_pool_usd: "0.10" }), aPool("P3", { daily_pool_usd: "10" })];
  const { d } = makeWorld(() => poolsPage(rows, 3));
  const out = await reader(d).listPools();
  assert.deepEqual(out.rows.map((r) => r.poolMicrosADay), [250_000_000, 100_000, 10_000_000]);
  for (const bad of ["1.2345678", "-1", "abc", undefined]) {
    const w = makeWorld(() => poolsPage([aPool("PX", { daily_pool_usd: bad })], 1));
    await assert.rejects(reader(w.d).listPools(), (e) => e instanceof BadAnswer);
  }
});

test("14 the same event on two pages is kept once and counted", async () => {
  const page1 = Array.from({ length: 100 }, (_, j) => aPool(`P${j}`));
  const page2 = [aPool("P99"), aPool("P0")]; // the item already read, then one that came back
  const { d, calls } = makeWorld(fromList([poolsPage(page1, 101, "2026-03-03"), poolsPage(page2, 101, "2026-09-09")]));
  const out = await reader(d).listPools();
  assert.equal(out.rows.length, 100);
  assert.equal(out.twice, 1);
  assert.equal(out.rows.filter((r) => r.ticker === "P0").length, 1);
  assert.equal(out.lastScoreDate, "2026-03-03");
  assert.equal(out.total, 101);
  assert.equal(out.moved, true); // a ticker came back on a later page
  assert.equal(calls.length, 2);
});

test("15 the settings are read through the score library", async () => {
  {
    const { d } = makeWorld(() => ok(aConfig()));
    const s = await reader(d).settings();
    assert.equal(s.minSize, 100);
    assert.equal(s.maxSpreadCents, 10);
    assert.equal(s.exponent, 2);
    assert.equal(s.floorCents, 100);
    assert.equal(s.minPayoutMicros, 5_000_000);
  }
  {
    const bad: Record<string, unknown> = aConfig();
    delete bad.min_size_threshold;
    const { d } = makeWorld(() => ok(bad));
    await assert.rejects(reader(d).settings(), (e) => e instanceof BadAnswer && /min_size_threshold/.test((e as Error).message));
  }
});

test("16 toEventIn carries the pool and the per-symbol log", () => {
  const listed = {
    ticker: "E1", title: "t", category: "c", subcategory: null, startMs: 123, live: true, volume: 9, unread: [],
    contracts: [
      { symbol: "C-A", stepCents: 1, top: { bidCents: 40, askCents: 60 } },
      { symbol: "C-B", stepCents: 2, top: { bidCents: 10, askCents: 20 } },
    ],
  };
  const pool = {
    ticker: "E1", title: "t", category: "c", poolMicrosADay: 7_000_000, source: "s", endsAtMs: null,
    makers: 4, poolId: null, poolEventCount: 1, poolName: null, poolKey: "event:E1", raw: {},
  };
  const logOf = (symbol: string) => [{ atMs: 1, top: { bidCents: symbol === "C-A" ? 1 : 2, askCents: 99 } }];
  const withPool = toEventIn(listed, pool, logOf);
  assert.equal(withPool.poolMicrosADay, 7_000_000);
  assert.equal(withPool.makersLastDay, 4);
  assert.equal(withPool.volume, 9);
  assert.equal(withPool.startMs, 123);
  assert.equal(withPool.live, true);
  assert.deepEqual(withPool.contracts.map((c) => c.symbol), ["C-A", "C-B"]);
  assert.equal(withPool.contracts[0].stepCents, 1);
  assert.deepEqual(withPool.contracts[0].log, [{ atMs: 1, top: { bidCents: 1, askCents: 99 } }]);
  assert.deepEqual(withPool.contracts[1].log, [{ atMs: 1, top: { bidCents: 2, askCents: 99 } }]);
  const noPool = toEventIn(listed, undefined, logOf);
  assert.equal(noPool.poolMicrosADay, null);
  assert.equal(noPool.makersLastDay, null);
});

// ---- the sends take turns (audit blocker 1) ----

const emptyLists = (_i: number, url: string): Scripted =>
  url.includes("/config") ? ok(aConfig()) : url.includes("liquidity-rewards/events") ? poolsPage([], 0) : eventsPage([], 0);

test("19 calls made at once take turns", async () => {
  // The clock lets the race show: this `sleep` gives up its turn (resolves on a later tick) rather
  // than adding to the clock and returning at once, so the three concurrent calls genuinely
  // interleave. Without one queue they would all be sent at time 0.
  const { d, calls } = makeWorld(emptyLists, "async");
  const r = reader(d);
  await Promise.all([r.listEvents("Q1"), r.listEvents("Q2"), r.settings()]);
  assert.equal(calls.length, 3);
  for (let k = 1; k < calls.length; k++) assert.ok(calls[k][1] - calls[k - 1][1] >= 1200, `gap before ${k}: ${calls[k][1] - calls[k - 1][1]}`);
});

test("20 a sleep that returns early does not let a send through", async () => {
  // The "half" clock advances by only half of what each sleep asks; the pacing wait must loop and
  // look at the clock again until it is really APART_MS on, not send after one short sleep.
  const { d, calls } = makeWorld(emptyLists, "half");
  const r = reader(d);
  await Promise.all([r.listEvents("Q1"), r.listEvents("Q2"), r.settings()]);
  assert.equal(calls.length, 3);
  for (let k = 1; k < calls.length; k++) assert.ok(calls[k][1] - calls[k - 1][1] >= 1200, `gap before ${k}: ${calls[k][1] - calls[k - 1][1]}`);
});

test("21 a call that was waiting when a 429 came waits the minute too", async () => {
  // Two calls at once: the pools call enters the queue first and is answered 429; the settings call
  // was already waiting, and works out its own wait at its turn, so it waits AFTER_429_MS too.
  const responder = (_i: number, url: string): Scripted =>
    url.includes("liquidity-rewards/events") ? { status: 429, json: null } : ok(aConfig());
  const { d, calls } = makeWorld(responder);
  const r = reader(d);
  const stopped = r.listPools().catch(() => "stopped");
  const config = r.settings();
  await Promise.all([stopped, config]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0][0].includes("liquidity-rewards/events"));
  assert.ok(calls[1][1] - calls[0][1] >= 60000, `second request at ${calls[1][1]}`);
});

test("22 a failed call does not block the next", async () => {
  const responder = (i: number): Scripted => (i === 0 ? { status: 500, json: null } : ok(aConfig()));
  const { d } = makeWorld(responder);
  const r = reader(d);
  await assert.rejects(r.listPools(), (e) => e instanceof BadAnswer);
  const s = await r.settings();
  assert.equal(s.minSize, 100);
});

// ---- which contracts are read, named, dropped (audit blocker 2) ----

test("23 a contract that can only be posted in is read", async () => {
  const contracts = [
    aContract("C-POST", { marketState: "post_only", prices: { bestBid: "0.47", bestAsk: "0.49" } }),
    aContract("C-CAPS", { marketState: "Open", prices: { bestBid: "0.30", bestAsk: "0.70" } }),
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  assert.deepEqual(e.contracts.map((c) => c.symbol), ["C-POST", "C-CAPS"]);
  assert.deepEqual(e.contracts[0].top, { bidCents: 47, askCents: 49 });
  assert.deepEqual(e.contracts[1].top, { bidCents: 30, askCents: 70 });
  assert.deepEqual(e.unread, []);
});

test("24 only a closed contract is dropped", async () => {
  const contracts = [
    aContract("C-CLOSED", { marketState: "closed" }), // the only drop: in neither list
    aContract("C-NOSTATE", { marketState: undefined }), // market state missing: unread
    aContract("C-HALTED", { marketState: "halted" }), // some other state: unread
    aContract("C-APPROVED", { status: "approved", marketState: "open" }), // not active: unread
    "x", // not an object: unread under ""
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  assert.deepEqual(e.contracts, []);
  assert.deepEqual(e.unread, ["C-NOSTATE", "C-HALTED", "C-APPROVED", ""]);
});

test("25 prices of the wrong shape is unread", async () => {
  const contracts = [
    aContract("C-MISSING", { prices: undefined }),
    aContract("C-STRING", { prices: "0.40/0.60" }),
    aContract("C-ARRAY", { prices: ["0.40", "0.60"] }),
    aContract("C-RENAMED", { prices: { best_bid: "0.40", best_ask: "0.60" } }),
    aContract("C-TEXTSIDES", { prices: { buy: "0.40", sell: "0.60" } }),
    aContract("C-EMPTYSIDES", { prices: { buy: {}, sell: {} } }),
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  assert.deepEqual(e.contracts.map((c) => c.symbol), ["C-EMPTYSIDES"]);
  assert.deepEqual(e.contracts[0].top, { bidCents: null, askCents: null }); // buy/sell present, no bid and no ask
  assert.deepEqual(e.unread, ["C-MISSING", "C-STRING", "C-ARRAY", "C-RENAMED", "C-TEXTSIDES"]);
});

test("26 a price that is there and impossible is unread", async () => {
  const impossible = ["0", "0.00", "1.00", "1.5", "47", "-0.40", "0x28", "4.7e-1", "0,47", "0.000001", "0.999995"];
  for (const bid of impossible) {
    const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts: [aContract("C1", { prices: { bestBid: bid, bestAsk: "0.50" } })] })], 1));
    const e = (await reader(d).listEvents(CAT)).events[0];
    assert.deepEqual(e.contracts, [], `impossible ${bid}`);
    assert.deepEqual(e.unread, ["C1"], `impossible ${bid}`);
  }
  const read: [unknown, number | null][] = [[" 0.47 ", 47], [0.47, 47], [null, null], ["", null]];
  for (const [bid, want] of read) {
    const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts: [aContract("C1", { prices: { bestBid: bid, bestAsk: "0.50" } })] })], 1));
    const e = (await reader(d).listEvents(CAT)).events[0];
    assert.deepEqual(e.unread, [], `read ${JSON.stringify(bid)}`);
    assert.equal(e.contracts[0].top.bidCents, want, `read ${JSON.stringify(bid)}`);
  }
});

test("27 a misread side leaves the event others-may-qualify and quotes nothing", async () => {
  const rule = readRule({ maxOthersSpreadCents: 14, tendedWithinMs: 3_600_000, stillCents: 2, stillOverMs: 600_000, pullBeforeStartMs: 7_200_000, capPerMarketMicros: 80_000_000, drawMicros: 900_000_000, bondMicros: 500_000_000, reachedMarginCents: 1, readEveryMs: 300_000, sweepsADay: 4, sweepApartMs: 1_200, noSizeBeforeMs: 1_794_895_200_000 });
  const s = readSettings(aConfig());
  const now = 1_700_000_000_000;
  const start = new Date(now + 86_400_000).toISOString();
  const contracts = [
    aContract("NARROW", { prices: "0.47|0.49" }), // a narrow book, but prices misshapen: unread
    aContract("WIDE", { prices: { bestBid: "0.44", bestAsk: "0.56" } }), // 12c: within the 14c others-spread
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { isLive: false, startTime: start, contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  assert.deepEqual(e.unread, ["NARROW"]);
  const tops = Object.fromEntries(e.contracts.map((c) => [c.symbol, c.top]));
  const step = 60_000;
  const logOf = (sym: string) => Array.from({ length: 200 }, (_, k) => ({ atMs: now - (199 - k) * step, top: k % 2 ? tops[sym] : (sym === "WIDE" ? { bidCents: 45, askCents: 57 } : tops[sym]) }));
  const pool = { ticker: "E1", title: "t", category: "c", poolMicrosADay: 5_000_000, source: "s", endsAtMs: null, makers: 0, poolId: null, poolEventCount: 1, poolName: null, poolKey: "event:E1", raw: {} };
  const out = decide(rule, s, [toEventIn(e, pool, logOf)], { filled: new Set<string>(), tiedUpMicros: 0, quoted: new Set<string>() }, now);
  assert.deepEqual(out, [{ event: "E1", symbol: null, pair: null, reason: "others-may-qualify" }]);
  assert.ok(out.every((x) => x.pair === null));
});

test("28 contracts that is not a list gives no contracts and one unread blank", async () => {
  for (const contracts of [undefined, {}]) {
    const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
    const e = (await reader(d).listEvents(CAT)).events[0];
    assert.deepEqual(e.contracts, [], JSON.stringify(contracts));
    assert.deepEqual(e.unread, [""], JSON.stringify(contracts));
  }
});

// ---- a list that moves while it is read (audit blocker 3) ----

test("29 the later copy of an event wins, and a moved list says so", async () => {
  {
    const c1 = [aContract("S1")];
    const c2 = [aContract("S1"), aContract("S2", { prices: { bestBid: "0.48", bestAsk: "0.50" } })];
    const page1 = [anEvent("E0", { contracts: c1 }), ...Array.from({ length: 99 }, (_, j) => anEvent(`F${j}`, { contracts: [] }))];
    const page2 = [anEvent("F98", { contracts: [] }), anEvent("E0", { contracts: c2 })]; // the item already read, then E0 again
    const { d } = makeWorld(fromList([eventsPage(page1, 101), eventsPage(page2, 101)]));
    const out = await reader(d).listEvents(CAT);
    const e0 = out.events.find((e) => e.ticker === "E0")!;
    assert.deepEqual(e0.contracts.map((c) => c.symbol), ["S1", "S2"]); // the later, fuller copy
    assert.equal(out.twice, 1);
    assert.equal(out.moved, true);
  }
  {
    const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts: [] })], 1));
    const out = await reader(d).listEvents(CAT);
    assert.equal(out.twice, 0);
    assert.equal(out.moved, false); // no repeats and one steady total
  }
  {
    const full = Array.from({ length: 100 }, (_, j) => anEvent(`G${j}`, { contracts: [] }));
    const { d } = makeWorld(fromList([eventsPage(full, 150), eventsPage([anEvent("G99", { contracts: [] }), anEvent("H1", { contracts: [] })], 999)]));
    const out = await reader(d).listEvents(CAT);
    assert.equal(out.twice, 0);
    assert.equal(out.moved, true); // a later page gave a different total
  }
});

// ---- the pool's fields and the settings (audit extra) ----

test("30 a pool id or event count out of range is refused", async () => {
  for (const bad of ["7", -1, 2.5]) {
    const { d } = makeWorld(() => poolsPage([aPool("P1", { pool_id: bad })], 1));
    await assert.rejects(reader(d).listPools(), (e) => e instanceof BadAnswer, `pool_id ${JSON.stringify(bad)}`);
  }
  {
    const { d } = makeWorld(() => poolsPage([aPool("P1", { pool_id: 0 })], 1));
    const out = await reader(d).listPools();
    assert.equal(out.rows[0].poolKey, "id:0");
    assert.equal(out.rows[0].poolId, 0);
  }
  {
    const { d } = makeWorld(() => poolsPage([aPool("PX", { pool_id: null })], 1));
    const out = await reader(d).listPools();
    assert.equal(out.rows[0].poolKey, "event:PX");
    assert.equal(out.rows[0].poolId, null);
  }
  for (const bad of [0, "3"]) {
    const { d } = makeWorld(() => poolsPage([aPool("P1", { pool_event_count: bad })], 1));
    await assert.rejects(reader(d).listPools(), (e) => e instanceof BadAnswer, `count ${JSON.stringify(bad)}`);
  }
  {
    const row: Record<string, unknown> = aPool("P1");
    delete row.pool_event_count;
    const { d } = makeWorld(() => poolsPage([row], 1));
    const out = await reader(d).listPools();
    assert.equal(out.rows[0].poolEventCount, 1); // absent gives 1
  }
});

test("31 settings that are not an object are a BadAnswer", async () => {
  for (const bad of [[1, 2, 3], null]) {
    const { d } = makeWorld(() => ok(bad));
    await assert.rejects(reader(d).settings(), (e) => e instanceof BadAnswer, JSON.stringify(bad));
  }
});

test("32 a slow answer that is a 429 still holds the call that was waiting", async () => {
  // A review finding on the fix: the pause was recorded after the queue's turn had been given up,
  // so when the answer took longer than APART_MS the waiting call saw nothing to wait for and was
  // sent at once. Here every answer takes 2,000 on the made-up clock and arrives on a later tick.
  let now = 0;
  const calls: [string, number][] = [];
  const d = {
    nowMs: () => now,
    sleep: (ms: number) => { now += ms; return Promise.resolve(); },
    fetcher: (url: string) => {
      calls.push([url, now]);
      const pools = url.includes("liquidity-rewards/events");
      return new Promise<{ status: number; json: unknown }>((r) => setImmediate(() => { now += 2000; r(pools ? { status: 429, json: null } : { status: 200, json: aConfig() }); }));
    },
  };
  const r = reader(d);
  const stopped = r.listPools().catch((e) => e);
  const config = r.settings();
  const [first] = await Promise.all([stopped, config]);
  assert.ok(first instanceof Stopped);
  assert.equal(calls.length, 2);
  // the 429 was seen at 2,000; the next request goes out no sooner than a minute after that
  assert.ok(calls[1][1] >= 2000 + 60000, `second request at ${calls[1][1]}`);
});

// ---- audit round 2 ----

test("33 a best price and its twin must agree, or the contract is unread", async () => {
  // The exchange writes each best price twice. A side is read as empty only when both say so, and
  // as a price only when both give the same cent; a key it has never sent is not guessed through.
  const full = { buy: { yes: "0.49", no: "0.53" }, sell: { yes: "0.47", no: "0.51" }, bestBid: "0.47", bestAsk: "0.49" };
  const contracts = [
    aContract("OK-BOTH", { prices: full }),
    aContract("OK-TRADED", { prices: { ...full, lastTradePrice: "0.48" } }),
    aContract("OK-EMPTY", { prices: { buy: {}, sell: {} } }),
    aContract("OK-ASK-ONLY", { prices: { buy: { yes: "0.49" }, sell: { no: "0.51" }, bestAsk: "0.49" } }),
    aContract("U-RENAMED", { prices: { best_bid: "0.47", best_ask: "0.49", buy: {}, sell: {} } }), // the audit's proof L5
    aContract("U-RENAMED-FILLED", { prices: { best_bid: "0.47", best_ask: "0.49", buy: { yes: "0.49" }, sell: { yes: "0.47" } } }),
    aContract("U-NEW-KEY", { prices: { ...full, midpoint: "0.48" } }),
    aContract("U-NO-TWINS", { prices: { bestBid: "0.47", bestAsk: "0.49", buy: {}, sell: {} } }),
    aContract("U-NO-ONLY", { prices: { buy: { no: "0.53" }, sell: { no: "0.51" } } }), // round 3: the other twins still name both prices
    aContract("U-INNER-KEYS", { prices: { buy: { Yes: "0.49" }, sell: { yes_price: "0.47" } } }),
    aContract("U-TWIN-NULL", { prices: { buy: { yes: null }, sell: { yes: "" } } }),
    aContract("U-NO-DIFFERS", { prices: { ...full, buy: { yes: "0.49", no: "0.52" } } }),
    aContract("U-NO-MISSING", { prices: { ...full, sell: { yes: "0.47" } } }),
    aContract("U-ASK-DIFFERS", { prices: { ...full, buy: { yes: "0.50", no: "0.53" } } }),
    aContract("U-BID-DIFFERS", { prices: { ...full, sell: { yes: "0.46", no: "0.51" } } }),
    aContract("U-BID-GONE", { prices: { buy: { yes: "0.49" }, sell: { yes: "0.47" }, bestAsk: "0.49" } }), // sell.yes still names a bid
    aContract("U-ASK-GONE", { prices: { buy: { yes: "0.49" }, sell: { yes: "0.47" }, bestBid: "0.47" } }),
    aContract("U-NO-BUY", { prices: { sell: { yes: "0.47" }, bestBid: "0.47" } }),
    aContract("U-SELL-LIST", { prices: { buy: {}, sell: [] } }),
    aContract("U-PROTO", { prices: JSON.parse('{"__proto__":{"bestBid":"0.47"},"buy":{},"sell":{}}') }),
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  assert.deepEqual(e.contracts.map((c) => [c.symbol, c.top.bidCents, c.top.askCents]), [["OK-BOTH", 47, 49], ["OK-TRADED", 47, 49], ["OK-EMPTY", null, null], ["OK-ASK-ONLY", null, 49]]);
  assert.deepEqual(e.unread, ["U-RENAMED", "U-RENAMED-FILLED", "U-NEW-KEY", "U-NO-TWINS", "U-NO-ONLY", "U-INNER-KEYS", "U-TWIN-NULL", "U-NO-DIFFERS", "U-NO-MISSING", "U-ASK-DIFFERS", "U-BID-DIFFERS", "U-BID-GONE", "U-ASK-GONE", "U-NO-BUY", "U-SELL-LIST", "U-PROTO"]);
});

test("34 a renamed price key beside a wide sibling quotes nothing (the audit's proof L5 as a regression)", async () => {
  const rule = readRule({ maxOthersSpreadCents: 14, tendedWithinMs: 3_600_000, stillCents: 2, stillOverMs: 600_000, pullBeforeStartMs: 7_200_000, capPerMarketMicros: 80_000_000, drawMicros: 900_000_000, bondMicros: 500_000_000, reachedMarginCents: 1, readEveryMs: 300_000, sweepsADay: 4, sweepApartMs: 1_200, noSizeBeforeMs: 1_794_895_200_000 });
  const s = readSettings(aConfig());
  const now = 1_700_000_000_000;
  const start = new Date(now + 86_400_000).toISOString();
  const contracts = [
    aContract("NARROW", { prices: { best_bid: "0.47", best_ask: "0.49", buy: {}, sell: {} } }), // a narrow book under keys the exchange has never sent
    aContract("WIDE", { prices: { bestBid: "0.44", bestAsk: "0.56" } }),
  ];
  const { d } = makeWorld(() => eventsPage([anEvent("E1", { startTime: start, contracts })], 1));
  const e = (await reader(d).listEvents(CAT)).events[0];
  const tops = Object.fromEntries(e.contracts.map((c) => [c.symbol, c.top]));
  const step = 60_000;
  const logOf = (sym: string) => Array.from({ length: 200 }, (_, k) => ({ atMs: now - (199 - k) * step, top: k % 2 || sym !== "WIDE" ? tops[sym] : { bidCents: 45, askCents: 57 } }));
  const pool = { ticker: "E1", title: "t", category: "c", poolMicrosADay: 5_000_000, source: "s", endsAtMs: null, makers: 0, poolId: null, poolEventCount: 1, poolName: null, poolKey: "event:E1", raw: {} };
  const out = decide(rule, s, [toEventIn(e, pool, logOf)], { filled: new Set<string>(), tiedUpMicros: 0, quoted: new Set<string>() }, now);
  assert.deepEqual(out, [{ event: "E1", symbol: null, pair: null, reason: "others-may-qualify" }]);
});

test("35 an event deleted early and another appended between pages shows as a list that moved", async () => {
  // The audit's proof L1. The total stays 201 and the count read stays 201, but everything slid one
  // place: the page asked from one item back no longer starts with the last item read.
  const before = Array.from({ length: 201 }, (_, j) => anEvent(`E${j}`, { contracts: [] }));
  const after = [...before.filter((e) => e.ticker !== "E5"), anEvent("ENEW", { contracts: [] })];
  const { d } = makeWorld(served((i) => (i === 0 ? before : after)));
  const out = await reader(d).listEvents(CAT);
  assert.equal(out.total, 201);
  assert.equal(out.moved, true);
  {
    // The slide alone: the count read equals the total, nothing came back and the total held, so
    // only the first item of the second page (E100, where E99 was expected) says the list moved.
    const page1 = Array.from({ length: 100 }, (_, j) => anEvent(`E${j}`, { contracts: [] }));
    const page2 = Array.from({ length: 99 }, (_, j) => anEvent(`E${100 + j}`, { contracts: [] }));
    const w = makeWorld(fromList([eventsPage(page1, 199), eventsPage(page2, 199)]));
    const slid = await reader(w.d).listEvents(CAT);
    assert.deepEqual([slid.events.length, slid.total, slid.twice, slid.moved], [199, 199, 0, true]);
  }
});

test("36 a list that did not move, read across three pages, says so", async () => {
  const all = Array.from({ length: 201 }, (_, j) => anEvent(`E${j}`, { contracts: [] }));
  const { d, calls } = makeWorld(served(() => all));
  const out = await reader(d).listEvents(CAT);
  assert.equal(calls.length, 3);
  assert.deepEqual([out.events.length, out.twice, out.moved], [201, 0, false]);
});

test("37 a later page that is empty, or more read than the total, is a list that moved", async () => {
  {
    // the list shrank to its first hundred between the pages: the page asked from item 99 is empty
    const full = Array.from({ length: 150 }, (_, j) => anEvent(`E${j}`, { contracts: [] }));
    const { d, calls } = makeWorld(served((i) => (i === 0 ? full : full.slice(0, 99)), "data", () => 150));
    const out = await reader(d).listEvents(CAT);
    assert.equal(calls.length, 2);
    assert.equal(out.moved, true);
  }
  for (const total of [0, 50]) {
    // the audit's proof L2: a full page against a total that says there is less
    const { d, calls } = makeWorld(() => eventsPage(Array.from({ length: 100 }, (_, j) => anEvent(`E${j}`, { contracts: [] })), total));
    const out = await reader(d).listEvents(CAT);
    assert.equal(calls.length, 1);
    assert.deepEqual([out.events.length, out.moved], [100, true]);
  }
});

test("38 an event is taken as live unless the exchange says exactly that it is not", async () => {
  const live = (v: unknown) => anEvent("E" + JSON.stringify(v), v === undefined ? { isLive: undefined } : { isLive: v });
  const { d } = makeWorld(() => eventsPage([live(false), live(true), live("true"), live("false"), live(null), live(undefined), live(0)], 7));
  const out = await reader(d).listEvents(CAT);
  assert.deepEqual(out.events.map((e) => e.live), [false, true, true, true, true, true, true]);
});

test("39 the real dependencies, on a stand-in for fetch: nothing here reaches a network", async () => {
  const real = globalThis.fetch;
  const asked: [string, boolean][] = [];
  const standIn = (answer: () => Promise<unknown>) => {
    globalThis.fetch = ((url: string, init: { signal?: AbortSignal }) => { asked.push([String(url), init.signal instanceof AbortSignal]); return answer(); }) as typeof fetch;
  };
  try {
    const { fetcher } = nodeDeps();
    standIn(async () => ({ status: 200, text: async () => JSON.stringify({ a: 1 }) }));
    assert.deepEqual(await fetcher("https://stand-in.invalid/one", 1000), { status: 200, json: { a: 1 } });
    assert.deepEqual(asked, [["https://stand-in.invalid/one", true]]);
    // a 429 whose body cannot be cancelled is still a 429 (the audit's finding: it was read as no answer)
    standIn(async () => ({ status: 429, body: { cancel: async () => { throw new Error("made-up cancel failure"); } } }));
    assert.deepEqual(await fetcher("https://stand-in.invalid/two", 1000), { status: 429, json: null });
    standIn(async () => ({ status: 503, body: null }));
    assert.deepEqual(await fetcher("https://stand-in.invalid/three", 1000), { status: 503, json: null });
    standIn(async () => ({ status: 200, text: async () => "<html>made-up page</html>" }));
    await assert.rejects(fetcher("https://stand-in.invalid/four", 1000), (e) => e instanceof BadAnswer && e.message.includes("<html>made-up page</html>")); // the body is kept in the error (audit 2, finding 9)
    standIn(async () => ({ status: 403, text: async () => "made-up refusal" }));
    assert.deepEqual(await fetcher("https://stand-in.invalid/six", 1000), { status: 403, json: null, text: "made-up refusal" }); // a refusal's body is kept
    standIn(async () => { throw new DOMException("made-up abort", "AbortError"); });
    await assert.rejects(fetcher("https://stand-in.invalid/five", 1000), (e) => e instanceof NoAnswer);
  } finally {
    globalThis.fetch = real;
  }
});

// --- plan 1.3-D: the book request. Every book below is invented. ---

const SIZES_FROM = 10_000_000; // an invented instant; the real one is in settings/rule.json
const lvl = (price: string, amount: string) => ({ price, amount, timestamp: "1" });
const aBook = (bids: unknown, asks: unknown) => ok({ bids, asks });
const CONFIG_OK = ok({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 });

test("D1 a book asked for before sizes may be read is refused, and nothing is asked", async () => {
  const w = makeWorld(() => aBook([], []));
  const r = reader(w.d);
  await assert.rejects(r.book("ZQ-1", SIZES_FROM), (e) => e instanceof NotYet);
  assert.equal(w.calls.length, 0);
});

test("D2 the book's address asks for both whole sides, the symbol encoded", async () => {
  const w = makeWorld(() => aBook([lvl("0.45", "100")], [lvl("0.55", "100")]));
  const r = reader(w.d);
  for (let i = 0; i < 2; i++) await w.d.sleep(SIZES_FROM);
  await r.book("ZQ A/1", SIZES_FROM);
  assert.equal(w.calls[0][0], "https://api.gemini.com/v1/book/ZQ%20A%2F1?limit_bids=0&limit_asks=0");
});

test("D3 a book waits its 1.2 seconds behind a list request, through the same queue", async () => {
  const w = makeWorld((i) => (i === 0 ? CONFIG_OK : aBook([lvl("0.45", "100")], [lvl("0.55", "100")])));
  const r = reader(w.d);
  await w.d.sleep(SIZES_FROM);
  await Promise.all([r.settings(), r.book("ZQ-1", SIZES_FROM)]);
  assert.equal(w.calls.length, 2);
  assert.ok(w.calls[1][1] - w.calls[0][1] >= 1_200);
});

test("D4 a 429 on a book stops as on a list, and nothing is asked for a minute", async () => {
  const w = makeWorld((i) => (i === 0 ? { status: 429, json: null } : CONFIG_OK));
  const r = reader(w.d);
  await w.d.sleep(SIZES_FROM);
  await assert.rejects(r.book("ZQ-1", SIZES_FROM), (e) => e instanceof Stopped);
  await r.settings();
  assert.ok(w.calls[1][1] - w.calls[0][1] >= 60_000);
});

test("D5 a level that is not a whole cent from 1 to 99 or a positive amount leaves the book unread, never empty", async () => {
  const cases: [unknown, unknown][] = [
    [[lvl("0.885", "100")], [lvl("0.55", "100")]],
    [[lvl("0.45", "100")], [lvl("1.00", "100")]],
    [[lvl("0.45", "0")], [lvl("0.55", "100")]],
    [[lvl("0.45", "100")], "not a list"],
    [[{ price: "0.45" }], [lvl("0.55", "100")]],
  ];
  for (const [bids, asks] of cases) {
    const w = makeWorld(() => aBook(bids, asks));
    await w.d.sleep(SIZES_FROM);
    assert.equal(await reader(w.d).book("ZQ-1", SIZES_FROM), null, JSON.stringify([bids, asks]));
  }
  const w = makeWorld(() => ok("not an object"));
  await w.d.sleep(SIZES_FROM);
  await assert.rejects(reader(w.d).book("ZQ-1", SIZES_FROM), (e) => e instanceof BadAnswer);
});

test("D6 a book's sides are sorted dearest bid and cheapest ask first; empty sides are empty", async () => {
  const w = makeWorld(() => aBook([lvl("0.40", "10"), lvl("0.45", "100.0")], [lvl("0.60", "5"), lvl("0.55", "100")]));
  await w.d.sleep(SIZES_FROM);
  assert.deepEqual(await reader(w.d).book("ZQ-1", SIZES_FROM), { bids: [{ cents: 45, qty: 100 }, { cents: 40, qty: 10 }], asks: [{ cents: 55, qty: 100 }, { cents: 60, qty: 5 }] });
  const e = makeWorld(() => aBook([], []));
  await e.d.sleep(SIZES_FROM);
  assert.deepEqual(await reader(e.d).book("ZQ-1", SIZES_FROM), { bids: [], asks: [] });
});

test("D7 a side of 50 levels or more is taken as not read whole: the bound on the others is none", async () => {
  const many = Array.from({ length: 50 }, (_, i) => lvl("0." + String(45 - Math.floor(i / 5)).padStart(2, "0"), "100"));
  const w = makeWorld(() => aBook(many, [lvl("0.55", "100")]));
  await w.d.sleep(SIZES_FROM);
  const b = await reader(w.d).book("ZQ-1", SIZES_FROM);
  assert.equal(b!.depth, 50);
  const s = readSettings({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 });
  assert.equal(mostOthersScore(s, b!, 100), null);
  const few = makeWorld(() => aBook(many.slice(0, 49), [lvl("0.55", "100")]));
  await few.d.sleep(SIZES_FROM);
  assert.equal((await reader(few.d).book("ZQ-1", SIZES_FROM))!.depth, undefined);
});

test("40 the real clock is the wall clock and never goes backwards (audit 2, finding 8)", () => {
  const { nowMs } = nodeDeps();
  const a = nowMs(), b = nowMs();
  assert.ok(Math.abs(a - Date.now()) < 1_000);
  assert.ok(b >= a);
});

// --- one event by its ticker (added 2026-11-18: the season-long markets left the category list) ---
test("E1 one event is read by its ticker through the same parser as a listed one", async () => {
  const { d, calls } = makeWorld(fromList([{ status: 200, json: anEvent("MADEUP27", { category: "Sports" }) }]));
  const e = await reader(d).event("MADEUP27");
  assert.equal(e.ticker, "MADEUP27");
  assert.equal(e.live, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.gemini.com/v1/prediction-markets/events/MADEUP27");
});

test("E2 an answer for another ticker, or one that is no event, is a bad answer", async () => {
  const other = makeWorld(fromList([{ status: 200, json: anEvent("OTHER") }]));
  await assert.rejects(reader(other.d).event("MADEUP27"), BadAnswer);
  const none = makeWorld(fromList([{ status: 200, json: [] }]));
  await assert.rejects(reader(none.d).event("MADEUP27"), BadAnswer);
});

test("E3 an event read by ticker waits its turn like any other request", async () => {
  const { d, calls } = makeWorld(fromList([{ status: 200, json: anEvent("A1") }, { status: 200, json: anEvent("B1") }]));
  const r = reader(d);
  await r.event("A1");
  await r.event("B1");
  assert.ok(calls[1][1] - calls[0][1] >= 1_200);
});

// 2026-11-18: the exchange's books hold amounts that are not whole (its quantity step is a hundredth
// of a contract; 73 of 1,077 books read that day had one). The score counts size as it is, so a
// part of a contract is read as it is and no longer leaves the book unread.
test("D5b an amount that is not whole is read as it is", async () => {
  const w = makeWorld(() => aBook([lvl("0.45", "2.5")], [lvl("0.55", "866.33")]));
  await w.d.sleep(SIZES_FROM);
  assert.deepEqual(await reader(w.d).book("ZQ-1", SIZES_FROM), { bids: [{ cents: 45, qty: 2.5 }], asks: [{ cents: 55, qty: 866.33 }] });
});
