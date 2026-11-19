// Every value in this file is invented. None is a reading of any market.
//
// The loop on a stand-in for the exchange: a fetcher that answers made-up lists by address, and a
// made-up clock. No test reaches the network. Files go to a fresh folder under the system's temp.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRule } from "@app/rule";
import { chain } from "@app/ledger/chain";
import { geminiDay } from "@app/ledger";
import { main, FORWARD_CATEGORY, SKIP_CATEGORIES, MISSING_PASSES_MOST } from "../src/main.ts";
import { ruleHashOf } from "../../../scripts/rule-hash.mjs";

const BUILD = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const rule = readRule(JSON.parse(readFileSync(BUILD + "/settings/rule.json", "utf8")));
const HASH: string = ruleHashOf(BUILD).hash;

const cents = (c: number) => (c / 100).toFixed(2);
const contract = (symbol: string, b: number, a: number) => ({
  instrumentSymbol: symbol, status: "active", marketState: "open", priceIncrement: "0.01",
  prices: { bestBid: cents(b), bestAsk: cents(a), buy: { yes: cents(a), no: cents(100 - b) }, sell: { yes: cents(b), no: cents(100 - a) } },
});
/** The stand-in. Its last scored day is the day before the clock's; the made-up contract's bid steps a cent every 36 list reads (three hours), so it is tended. */
function exchange(c: { nowMs(): number }, over: { poolTickers?: string[] } = {}) {
  const asked: string[] = [];
  const listReads = () => asked.filter((u) => u.includes("/prediction-markets/events?")).length;
  const answer = (url: string): unknown => {
    if (url.includes("/liquidity-rewards/config")) return { min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 };
    if (url.includes("/liquidity-rewards/events")) return {
      last_score_date: geminiDay(c.nowMs() - 86_400_000), pagination: { total: 2 },
      events: (over.poolTickers ?? ["MU-1", "MU-2"]).map((event_ticker, i) => ({ event_ticker, title: "made up", category: "College Made Up", daily_pool_usd: "250", pool_source: "category_default", qualifying_maker_count: i, pool_id: 7, pool_event_count: 2, pool_category_name: "Made Up" })),
    };
    if (url.includes("/prediction-markets/events")) return {
      pagination: { total: 2 },
      data: [
        { ticker: "MU-1", title: "made up", category: FORWARD_CATEGORY, startTime: "2026-11-20T00:00:00Z", isLive: false, volume: "10", contracts: [contract("MU-1-A", Math.floor(listReads() / 36) % 2 === 0 ? 44 : 45, 56)] },
        { ticker: "MU-2", title: "made up", category: FORWARD_CATEGORY, startTime: "2026-11-20T00:00:00Z", isLive: false, volume: "10", contracts: [contract("MU-2-A", 46, 54)] }, // narrow: a maker may be there
      ],
    };
    if (url.includes("/v1/book/MU-2-A")) return { bids: [{ price: "0.46", amount: "300" }], asks: [{ price: "0.54", amount: "300" }] };
    if (url.includes("/v1/book/")) return { bids: [{ price: "0.44", amount: "300" }], asks: [{ price: "0.56", amount: "300" }] };
    throw new Error("the stand-in has no answer for " + url);
  };
  return {
    asked,
    fetcher: async (url: string) => { asked.push(url); return { status: 200, json: answer(url) }; },
  };
}
function clock(startMs: number) {
  let now = startMs;
  return { nowMs: () => now, sleep: async (ms: number) => { now += ms; await Promise.resolve(); } };
}
const folder = () => mkdtempSync(join(tmpdir(), "vault-forward-test-"));
const lines = (dir: string) => readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const T = Date.UTC(2026, 10, 17, 1, 0, 0); // before the team's instant: no sweep

test("M1 the ledger's first line holds the rule's hash and the settings path; each pass row chains on the last", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 3 });
  const [first, ...rest] = lines(dir);
  assert.deepEqual([first.ruleHash, first.settingsPath], [HASH, BUILD + "/settings/rule.json"]);
  assert.equal(rest.length, 3);
  let head = HASH;
  for (const l of rest) { head = chain(head, JSON.stringify(l.row)); assert.equal(l.head, head); }
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).chainHex, head);
  assert.equal(readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").length, 3);
  assert.ok(x.asked.every((u) => !u.includes("/v1/book/"))); // no book before the team's instant
});

test("M2 every raw answer is kept under reads/, each line its own gzip member (zcat gives the lines back)", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 2 });
  const files = readdirSync(join(dir, "reads"));
  assert.ok(files.length > 0 && files.every((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f)), files.join(" "));
  const kept = files.flatMap((f) => gunzipSync(readFileSync(join(dir, "reads", f))).toString("utf8").trim().split("\n")).map((l) => JSON.parse(l));
  assert.equal(kept.length, x.asked.length);
  assert.deepEqual(kept.map((k) => k.url), x.asked);
  assert.ok(kept.every((k) => k.status === 200 && k.json !== undefined));
});

test("M3 a restart reads its files back and carries on from the same chain", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 2 });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 2 });
  const [, ...rest] = lines(dir);
  assert.equal(rest.length, 4);
  let head = HASH;
  for (const l of rest) { head = chain(head, JSON.stringify(l.row)); assert.equal(l.head, head); }
});

test("M4 a ledger made under another rule hash is refused before any request", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify({ ruleHash: "00".repeat(32), settingsPath: "made up" }) + "\n");
  await assert.rejects(main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 }), /rule hash/);
  assert.equal(x.asked.length, 0);
});

test("M5 a read where no listed event of the category has a pool row is logged as skipped and makes no pass row (audit 2 round 2)", async () => {
  const dir = folder(), c = clock(T), x = exchange(c, { poolTickers: ["ELSEWHERE-1"] });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 2 });
  assert.equal(lines(dir).length, 1);
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 2);
  assert.ok(log.every((l) => typeof l.skipped === "string" && l.skipped.includes("pool row")));
});

test("M8 a state whose head is not the ledger's last head is refused before any request (audit 2, finding 5)", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 2 });
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...st, chainHex: HASH }));
  const before = x.asked.length;
  await assert.rejects(main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 }), /head/);
  assert.equal(x.asked.length, before);
});

test("M9 a ledger with rows and no state is refused before any request (audit 2, finding 5)", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
  rmSync(join(dir, "state.json"));
  const before = x.asked.length;
  await assert.rejects(main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 }), /state/);
  assert.equal(x.asked.length, before);
});

test("M6 the hash check is written before the first request, in main's own text", () => {
  const text = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const body = text.slice(text.indexOf("export async function main"));
  assert.ok(body.indexOf("ruleHashOf(") > 0);
  assert.ok(body.indexOf("ruleHashOf(") < body.indexOf("reader("));
  assert.ok(body.indexOf("checkLedger(") < body.indexOf("reader("));
});

test("M7 from the team's instant a sweep runs where a quote stands, its books are kept, and its figure joins the state", async () => {
  const dir = folder(), c = clock(rule.noSizeBeforeMs - 26 * 3_600_000), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 26 * 12 + 3 });
  const books = x.asked.filter((u) => u.includes("/v1/book/"));
  assert.ok(books.length >= 1 && books.every((u) => u.includes("MU-2-A")));
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.ok(st.sweptAtMs.length >= 1 && st.sweptAtMs.every((t: number) => t >= rule.noSizeBeforeMs));
  const figures = (st.sweeps["id:7"] as { othersMost: number | null }[]).map((w) => w.othersMost);
  assert.ok(figures.length >= 1 && figures.every((f) => f !== null && f > 0)); // the others in MU-2's book
  assert.ok(existsSync(join(dir, "reads")));
});

test("M10 with a sender, the loop sends the starting head and each new head, writes commits.jsonl, and the last line is the ledger's last head (T16)", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  const sent: string[] = [];
  const sender = { async send(h: `0x${string}`) { sent.push(h); return ("0x" + "e".repeat(64)) as `0x${string}`; } };
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 3, sender });
  const rows = lines(dir).slice(1);
  const last = rows[rows.length - 1].head;
  const commits = readFileSync(join(dir, "commits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sent[0], "0x" + HASH); // the first offer is the head the run starts from
  assert.equal(sent[sent.length - 1], "0x" + last);
  assert.equal(new Set(sent).size, sent.length); // no head sent twice
  assert.ok(commits.every((l) => typeof l.tx === "string" && typeof l.head === "string"));
  assert.equal(commits[commits.length - 1].head, last);
});

test("M11 without a sender nothing is committed and no commits.jsonl is written", async () => {
  const dir = folder(), c = clock(T), x = exchange(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
  assert.equal(existsSync(join(dir, "commits.jsonl")), false);
});

// --- reading the reward list's events by ticker when the category list no longer gives them
// (added 2026-11-18). Every value below is invented.
//
// A stand-in whose active category list is EMPTY: the season-long markets the reward list names left
// it on 2026-11-18 while they stayed active, so they are read one event at a time by their ticker.
// `poolRows` are the reward rows; `fail` maps a ticker to how its by-ticker read goes wrong.
function byTickerWorld(c: { nowMs(): number }, over: { poolRows?: { ticker: string; category: string }[]; fail?: Record<string, "bad" | "stop" | "none">; failAt?: (ticker: string, nth: number) => boolean; eventCategory?: Record<string, string>; bidAt?: (ticker: string, nth: number) => number } = {}) {
  const asked: string[] = [];
  const rows = over.poolRows ?? [{ ticker: "SEASON-1", category: "College Football" }, { ticker: "SEASON-2", category: "College Basketball" }];
  const byTickerReqs = (ticker: string) => asked.filter((u) => u.endsWith("/prediction-markets/events/" + ticker)).length;
  // An event read by its ticker carries the exchange's top category ("Sports", "Politics"), as the
  // kept answers of 2026-11-18 do; the reward row's own category is a sub-category.
  const eventOf = (ticker: string, nth: number) => ({ ticker, title: "made up", category: over.eventCategory?.[ticker] ?? FORWARD_CATEGORY, startTime: "2026-12-01T00:00:00Z", isLive: false, volume: "10", contracts: [contract(ticker + "-A", over.bidAt?.(ticker, nth) ?? 46, 54)] });
  const answer = (url: string): { status: number; json: unknown } => {
    if (url.includes("/liquidity-rewards/config")) return { status: 200, json: { min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 } };
    if (url.includes("/liquidity-rewards/events")) return { status: 200, json: {
      last_score_date: geminiDay(c.nowMs() - 86_400_000), pagination: { total: rows.length },
      events: rows.map((r, i) => ({ event_ticker: r.ticker, title: "made up", category: r.category, daily_pool_usd: "250", pool_source: "category_default", qualifying_maker_count: 0, pool_id: 100 + i, pool_event_count: 1, pool_category_name: r.category })),
    } };
    if (url.includes("/prediction-markets/events/")) { // one event by its ticker
      const ticker = decodeURIComponent(url.slice(url.indexOf("/prediction-markets/events/") + "/prediction-markets/events/".length));
      const fail = over.failAt?.(ticker, byTickerReqs(ticker)) ? "bad" : over.fail?.[ticker];
      if (fail === "bad") return { status: 500, json: null };
      if (fail === "stop") return { status: 429, json: null };
      return { status: 200, json: eventOf(ticker, byTickerReqs(ticker)) };
    }
    if (url.includes("/prediction-markets/events")) return { status: 200, json: { pagination: { total: 0 }, data: [] } }; // the category list no longer gives them
    throw new Error("the stand-in has no answer for " + url);
  };
  return { asked, byTickerReqs, fetcher: async (url: string) => { asked.push(url); return answer(url); } };
}

test("M12 a reward event gone from the category list is read by its ticker and handed to the pass", async () => {
  const dir = folder(), c = clock(T), x = byTickerWorld(c);
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
  assert.equal(x.byTickerReqs("SEASON-1"), 1);
  assert.equal(x.byTickerReqs("SEASON-2"), 1);
  assert.ok(lines(dir).length > 1, "a pass row was written"); // old code would skip and write none
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].skipped, undefined); // the pass ran
  assert.equal(log[0].byTicker, 2);
  assert.deepEqual(log[0].missing, []);
});

test("M13 a reward row whose category is skipped is not read by ticker", async () => {
  assert.ok(SKIP_CATEGORIES.includes("Bitcoin")); // copied from web/src/pools.ts
  const dir = folder(), c = clock(T);
  const x = byTickerWorld(c, { poolRows: [{ ticker: "SEASON-1", category: "College Football" }, { ticker: "BTC-1", category: "Bitcoin" }] });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
  assert.equal(x.byTickerReqs("SEASON-1"), 1);
  assert.equal(x.byTickerReqs("BTC-1"), 0); // its category settles too fast to be worth a floor
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[0].byTicker, 1);
});

test("M14 a by-ticker read that fails is left out for the pass and named in missing", async () => {
  const dir = folder(), c = clock(T);
  const x = byTickerWorld(c, { poolRows: [{ ticker: "SEASON-1", category: "College Football" }, { ticker: "BAD-1", category: "College Football" }], fail: { "BAD-1": "bad" } });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
  assert.ok(lines(dir).length > 1, "the readable event still drove a pass");
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[0].skipped, undefined);
  assert.equal(log[0].byTicker, 1);
  assert.deepEqual(log[0].missing, ["BAD-1"]);
});

test("M15 a 429 on a by-ticker read ends the pass as today, writing no row", async () => {
  const dir = folder(), c = clock(T);
  const x = byTickerWorld(c, { poolRows: [{ ticker: "STOP-1", category: "College Football" }], fail: { "STOP-1": "stop" } });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
  assert.equal(lines(dir).length, 1); // just the ledger's first line; no pass row
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.ok(typeof log[0].skipped === "string" && log[0].skipped.includes("pause"), log[0].skipped);
});

// Audit of 2026-11-18, the engine, finding 1: a copy kept from the pass before showed the same prices
// at two reads, and the ledger counts a minute where the same quote stood at both.
test("M16 an event read by its ticker is read afresh at every pass, and the pass sees the prices of that read", async () => {
  const rows = [{ ticker: "SEASON-1", category: "College Football" }];
  const dir = folder(), c = clock(T);
  const x = byTickerWorld(c, { poolRows: rows, bidAt: (_t, nth) => 45 + nth }); // the bid moves a cent at every read
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 4 });
  assert.equal(x.byTickerReqs("SEASON-1"), 4);
  assert.equal(readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").filter((l) => JSON.parse(l).byTicker === 1).length, 4);
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(st.seen["SEASON-1-A"].top.bidCents, 49); // the fourth read's price, not an earlier one's
});

// Finding 2: the reward list also names events of other categories; the ledger under this hash is sport alone.
test("M17 an event read by its ticker that is not of the forward run's category is kept out of the pass and not asked for again", async () => {
  const rows = [{ ticker: "SEASON-1", category: "College Football" }, { ticker: "VOTE-1", category: "Presidential" }];
  const dir = folder(), c = clock(T);
  const x = byTickerWorld(c, { poolRows: rows, eventCategory: { "VOTE-1": "Politics" } });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 3 });
  assert.equal(x.byTickerReqs("VOTE-1"), 1); // read once, found to be of another category, never again
  assert.equal(x.byTickerReqs("SEASON-1"), 3);
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const l of log) { assert.equal(l.byTicker, 1); assert.equal(l.notForward, 1); }
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.ok(!JSON.stringify(st).includes("VOTE-1")); // no read, no log, no quote, no row of it in the state
  assert.ok(st.seen["SEASON-1-A"] !== undefined);
});

// Audit of 2026-11-19, the engine, finding 2: one failed answer is not an event that left the exchange.
test("M18 while a by-ticker read fails of an event a quote stands on, the pass is not made and no fill is written; after MISSING_PASSES_MOST in a row the event is taken as gone", async () => {
  assert.equal(MISSING_PASSES_MOST, 3);
  const rows = [{ ticker: "SEASON-1", category: "College Football" }, { ticker: "SEASON-2", category: "College Football" }];
  const seed = async () => {
    const dir = folder(), c = clock(T);
    const x = byTickerWorld(c, { poolRows: rows, failAt: (t, nth) => t === "SEASON-1" && nth >= 2 }); // every read after the first fails
    await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 1 });
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    st.standing["SEASON-1"] = { event: "SEASON-1", symbol: "SEASON-1-A", pair: { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 100 } }, sinceMs: c.nowMs(), pool: "id:100" };
    writeFileSync(join(dir, "state.json"), JSON.stringify(st));
    return { dir, c, x };
  };
  { // three failed reads in a row: three passes not made, the quote still stands, nothing filled
    const { dir, c, x } = await seed();
    const before = lines(dir).length;
    await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 3 });
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    assert.equal(st.positions.length, 0);
    assert.ok(st.standing["SEASON-1"] !== undefined);
    assert.equal(lines(dir).length, before);
    const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(-3);
    for (const l of log) { assert.match(l.skipped, /a read failed of an event a quote stands on/); assert.deepEqual(l.held, ["SEASON-1"]); }
  }
  { // a fourth: the event is taken as gone, the pass is made, and the pass's own rule counts the quote as filled
    const { dir, c, x } = await seed();
    await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 4 });
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    assert.equal(st.positions.length, 1);
    assert.equal(st.positions[0].fill.event, "SEASON-1");
  }
});

// Finding 3: an answer with no category is a failed read, not an event of another category.
test("M19 an event read by its ticker with no category is left out for the pass and asked for again", async () => {
  const rows = [{ ticker: "SEASON-1", category: "College Football" }, { ticker: "BLANK-1", category: "College Football" }, { ticker: "CASE-1", category: "College Football" }];
  const dir = folder(), c = clock(T);
  const x = byTickerWorld(c, { poolRows: rows, eventCategory: { "BLANK-1": "", "CASE-1": "sports" } });
  await main({ dir, buildDir: BUILD, deps: { fetcher: x.fetcher, ...c }, passes: 2 });
  assert.equal(x.byTickerReqs("BLANK-1"), 2);
  const log = readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const l of log) { assert.deepEqual(l.missing, ["BLANK-1"]); assert.equal(l.notForward, 0); assert.equal(l.byTicker, 2); } // "sports" in another case is still sport
});

// Finding 1: the pass is stamped before its reads begin, so no price is older than the stamp.
test("M20 a pass is stamped with the time before its reads begin, not after them", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ticker: "SEASON-" + i, category: "College Football" }));
  const dir = folder(), c = clock(T), x = byTickerWorld(c, { poolRows: rows });
  let listAskedAtMs = -1, lastTickerAskedAtMs = -1;
  const fetcher = async (url: string) => {
    if (url.includes("/prediction-markets/events?") && listAskedAtMs < 0) listAskedAtMs = c.nowMs();
    if (url.includes("/prediction-markets/events/")) lastTickerAskedAtMs = c.nowMs();
    return x.fetcher(url);
  };
  await main({ dir, buildDir: BUILD, deps: { fetcher, ...c }, passes: 1 });
  const log = JSON.parse(readFileSync(join(dir, "passes.log"), "utf8").trim().split("\n")[0]);
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(st.lastPassMs, log.atMs);
  assert.ok(log.atMs <= listAskedAtMs, "the stamp is no later than the first read of events");
  assert.ok(lastTickerAskedAtMs - log.atMs >= 19 * 1_200, "the by-ticker reads came after the stamp, at the reader's pacing");
});
