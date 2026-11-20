// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PASS_EVERY_MS, sharedReader, type Feed, type Lists, type PoolAnswer } from "../src/pass.ts";

const S = { minSize: 100, maxSpreadCents: 10, exponent: 2, floorCents: 0.1, minPayoutMicros: 1_000_000 };
const row = (ticker: string, id: number, category = "Made-Up Sport") => ({ ticker, title: "made up " + ticker, category, poolMicrosADay: 5_000_000, source: "invented", endsAtMs: null, makers: 0, poolId: id, poolEventCount: 1, poolName: "Pool " + id, poolKey: "id:" + id, raw: { secret: 1 } });
const lists = (rows: ReturnType<typeof row>[]): Lists => ({ settings: S, pools: { lastScoreDate: "2026-11-19", total: rows.length, rows, twice: 0, moved: false }, events: [], eventsAtMs: 1_000 });
const ev = (ticker: string) => ({ ticker, title: "made up", category: "Made-Up Sport", subcategory: null, startMs: 9e12, live: false, volume: 1, contracts: [{ symbol: ticker + "-1", stepCents: 1, top: { bidCents: 40, askCents: 60 } }], unread: [] });
const good = (ticker: string): PoolAnswer => ({ events: [ev(ticker)], books: { [ticker + "-1"]: { atMs: 1, book: { bids: [{ cents: 40, qty: 10 }], asks: [{ cents: 60, qty: 10 }] } } }, errors: [] });

function world(feed: Feed) {
  let now = 1_000_000;
  const slept: number[] = [];
  const r = sharedReader({ feed, nowMs: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
  return { r, slept, advance: (ms: number) => { now += ms; } };
}

test("a pass reads the lists, then every pool once, skips an all-crypto pool, and never sends the raw row", async () => {
  const asked: string[] = [];
  const w = world({ screen: async () => lists([row("A", 1), row("B", 2), row("C", 3, "Bitcoin")]), pool: async (k) => { asked.push(k); return good(k === "id:1" ? "A" : "B"); } });
  assert.equal(w.r.screen(), null);
  await w.r.runPass();
  assert.deepEqual(asked.sort(), ["id:1", "id:2"]);
  const screen = w.r.screen() as { shared: boolean; pools: { rows: Record<string, unknown>[] }; pass: { done: number; total: number } };
  assert.equal(screen.shared, true);
  assert.equal(screen.pools.rows.some((x) => "raw" in x), false);
  assert.deepEqual([screen.pass.done, screen.pass.total], [2, 2]);
  assert.deepEqual(Object.keys((w.r.pools() as { pools: object }).pools).sort(), ["id:1", "id:2"]);
});

test("a pool cut short by a pause is asked for once more after a wait of over a minute", async () => {
  let n = 0;
  const w = world({ screen: async () => lists([row("A", 1)]), pool: async () => (n++ === 0 ? { events: [], books: {}, errors: ["stopped at A-1: the exchange asked for a pause"] } : good("A")) });
  await w.r.runPass();
  assert.equal(n, 2);
  assert.equal(w.slept.length, 1);
  assert.ok(w.slept[0] > 60_000);
  assert.equal(Object.keys((w.r.pools() as { pools: object }).pools).length, 1);
});

test("a pool that fails keeps the copy read before; a pool that left the list is dropped", async () => {
  let pass = 0;
  const w = world({
    screen: async () => (pass === 0 ? lists([row("A", 1), row("B", 2)]) : lists([row("A", 1)])),
    pool: async (k) => { if (pass === 1) throw new Error("no answer"); return good(k === "id:1" ? "A" : "B"); },
  });
  await w.r.runPass();
  pass = 1;
  await w.r.runPass();
  assert.deepEqual(Object.keys((w.r.pools() as { pools: object }).pools), ["id:1"]);
});

test("the first pass is due at once; the next only after the wait and only if somebody asked lately; a failed list read ends the pass with a note", async () => {
  const w = world({ screen: async () => lists([row("A", 1)]), pool: async () => good("A") });
  assert.equal(w.r.due(), true);
  await w.r.runPass();
  assert.equal(w.r.due(), false);
  w.advance(PASS_EVERY_MS + 1);
  assert.equal(w.r.due(), false, "nobody asked");
  w.r.visited();
  assert.equal(w.r.due(), true);
  const bad = world({ screen: async () => { throw new Error("the lists did not come"); }, pool: async () => good("A") });
  await bad.r.runPass();
  assert.match(String((bad.r.state() as { note: string }).note), /did not finish/);
  assert.equal(bad.r.screen(), null);
});
