// Every value in this file is invented. None is a reading of any market.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { ListedEvent, PoolRow } from "../../../services/engine/src/gemini.ts";
import { ExampleView } from "./Example.tsx";
import { basketBids, cover, findLegs, leastBid, type Held } from "./example.ts";

const S = { minSize: 100, maxSpreadCents: 10, exponent: 2, floorCents: 0.1, minPayoutMicros: 1_000_000 };
const ev = (ticker: string, title: string, contracts: [string, number, number][]): ListedEvent => ({
  ticker, title, category: "Invented", subcategory: null, startMs: 0, live: false, volume: 0, unread: [],
  contracts: contracts.map(([symbol, bid, ask]) => ({ symbol, stepCents: 1, top: { bidCents: bid, askCents: ask } })),
});
const row = (ticker: string, title: string, poolKey: string): PoolRow => ({ ticker, title, category: "Invented", poolMicrosADay: 10_000_000, source: "invented", endsAtMs: null, makers: 1, poolId: null, poolEventCount: 1, poolName: null, poolKey, raw: {} });

const POOLS: Record<string, Held> = {
  "event:W": { atMs: 0, events: [ev("W", "Buffalo Total Wins", [["X-W-14PLUS", 57, 60], ["X-W-12PLUS", 90, 95]])], books: {
    "X-W-14PLUS": { bids: [{ cents: 57, qty: 40 }, { cents: 50, qty: 10 }], asks: [{ cents: 60, qty: 30 }] },
    "X-W-12PLUS": { bids: [{ cents: 90, qty: 100 }], asks: [{ cents: 95, qty: 50 }] },
  } },
  "event:D": { atMs: 0, events: [ev("D", "AFC East Division Winner?", [["X-D-BUF", 98, 99], ["X-D-NE", 2, 3]])], books: {
    "X-D-BUF": { bids: [{ cents: 98, qty: 20 }], asks: [{ cents: 99, qty: 20 }] },
    "X-D-NE": { bids: [{ cents: 2, qty: 20 }], asks: [{ cents: 3, qty: 20 }] },
  } },
  "event:O": { atMs: 0, events: [ev("O", "Detroit Total Wins", [["X-O-9PLUS", 40, 44]])], books: { "X-O-9PLUS": { bids: [{ cents: 40, qty: 5 }], asks: [{ cents: 44, qty: 5 }] } } },
};
const ROWS = [row("W", "Buffalo Total Wins", "event:W"), row("D", "AFC East Division Winner?", "event:D"), row("O", "Detroit Total Wins", "event:O")];

test("the legs are found by name: the division first, then the win totals from the lowest, and no other team's", () => {
  const legs = findLegs(POOLS);
  expect(legs.map((l) => l.symbol)).toEqual(["X-D-BUF", "X-W-12PLUS", "X-W-14PLUS"]);
  expect(legs[2].paysIf).toBe("Buffalo wins fewer than 14 games");
});

test("taking the falls-short side walks the bids best first and stops at what rests", () => {
  const leg = findLegs(POOLS)[2];
  expect(cover(leg, 45)).toEqual({ priceCents: 43, resting: 50, filled: 45, costMicros: 40 * 430_000 + 5 * 500_000 });
  expect(cover(leg, 500).filled).toBe(50);
  expect(cover({ ...leg, bids: [] }, 10)).toEqual({ priceCents: null, resting: 0, filled: 0, costMicros: 0 });
});

test("Basket's bids come from the allocator, only for the example's pools", () => {
  const legs = findLegs(POOLS);
  const bids = basketBids(S, ROWS, POOLS, legs, 1_000);
  expect(bids.size).toBeGreaterThan(0);
  expect(bids.has("X-O-9PLUS")).toBe(false);
  for (const b of bids.values()) expect(b.qty).toBeGreaterThanOrEqual(S.minSize);
});

test("the panel: the figures, the words that go with them, and a plain line when nothing is held", () => {
  const html = renderToStaticMarkup(<ExampleView data={{ settings: S, rows: ROWS, pools: POOLS }} want={45} onWant={() => {}} nowMs={120_000} />);
  expect(html.split("data-leg").length).toBe(4);
  expect(html).toContain("Buffalo does not win the AFC East");
  expect(html).toContain("rules were not read");
  expect(html).toContain("nothing is ordered");
  expect(html).toContain("2 min ago");
  const none = renderToStaticMarkup(<ExampleView data="none" want={45} onWant={() => {}} nowMs={0} />);
  expect(none).toContain("not held by Basket");
  expect(none).not.toContain("<table");
});

test("a least-size bid joins the best bid where the book is narrow enough, and is nothing where a side is missing", () => {
  const legs = findLegs(POOLS);
  expect(leastBid(S, legs[2])).toEqual({ cents: 57, qty: 100 });
  expect(leastBid(S, { ...legs[2], bids: [], askCents: null })).toBeNull();
});
