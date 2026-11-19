// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { replay, type ReadLine } from "./replay.ts";

const E = (offset: number) => "https://api.gemini.com/v1/prediction-markets/events?status=active&category=Sports&limit=100&offset=" + offset;
const R = (offset: number) => "https://api.gemini.com/v1/prediction-markets/liquidity-rewards/events?limit=100&offset=" + offset;
const C = "https://api.gemini.com/v1/prediction-markets/liquidity-rewards/config";
const config = { max_spread_cents: 10, min_payout_threshold_usd: "1", enabled: true, min_size_threshold: 100, min_spread_floor: "0.001", spread_penalty_exponent: 2 };

const no = (p: string) => (1 - Number(p)).toFixed(2);
const event = (ticker: string, bid: string, ask: string) => ({
  ticker, title: "Made-up " + ticker, category: "Sports", isLive: false, startTime: "2026-11-18T01:00:00Z",
  contracts: [{
    instrumentSymbol: ticker + "-A", status: "active", marketState: "open", priceIncrement: "0.01",
    prices: { bestBid: bid, bestAsk: ask, buy: { yes: ask, no: no(bid) }, sell: { yes: bid, no: no(ask) } },
  }],
});
const page = (events: unknown[], total: number, offset: number) => ({ data: events, pagination: { limit: 100, offset, total } });
const rewards = (rows: unknown[]) => ({ events: rows, pagination: { limit: 100, offset: 0, total: rows.length }, last_score_date: "2026-11-16" });
const rewardRow = (ticker: string) => ({ event_ticker: ticker, title: "made up", category: "Pro Made-Up", daily_pool_usd: "300", pool_source: "category_default", pool_id: 1, pool_event_count: 1, pool_category_name: "Made-Up", qualifying_maker_count: 0, ends_at: null });

const line = (atMs: number, url: string, json: unknown): ReadLine => ({ atMs, url, status: 200, json });

test("the last pass's answers, read again through the engine's own reader", async () => {
  const lines = [
    line(1000, C, config),
    line(2200, R(0), rewards([rewardRow("OLD")])),
    line(3400, E(0), page([event("OLD", "0.40", "0.60")], 1, 0)),
    line(9000, C, config),
    line(10_200, R(0), rewards([rewardRow("G1")])),
    line(11_400, E(0), page([event("G1", "0.40", "0.60")], 1, 0)),
  ];
  const r = await replay(lines, "Sports");
  expect(r.events.map((e) => e.ticker)).toEqual(["G1"]);
  expect(r.events[0].contracts[0].top).toEqual({ bidCents: 40, askCents: 60 });
  expect(r.pools.rows.map((x) => x.ticker)).toEqual(["G1"]);
  expect(r.settings.maxSpreadCents).toBe(10);
  expect(r.eventsAtMs).toBe(11_400);
});

test("a pass still being read is passed over for the last whole one", async () => {
  const lines = [
    line(1000, C, config),
    line(2200, R(0), rewards([rewardRow("G1")])),
    line(3400, E(0), page([event("G1", "0.40", "0.60")], 1, 0)),
    line(9000, E(0), page(Array.from({ length: 100 }, (_, i) => event("N" + i, "0.40", "0.60")), 150, 0)), // the next page is not read yet
  ];
  const r = await replay(lines, "Sports");
  expect(r.events.map((e) => e.ticker)).toEqual(["G1"]);
  expect(r.eventsAtMs).toBe(3400);
});

test("no whole pass yet is said, not guessed", async () => {
  await expect(replay([line(1000, C, config)], "Sports")).rejects.toThrow(/no whole/);
});
