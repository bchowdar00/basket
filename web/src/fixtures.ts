// Every value in this file is invented. None is a reading of any market.
// Fixtures for the screen's tests.
import type { PassRow, PoolCount } from "@app/ledger";
import type { Settings } from "@app/score";
import type { ListedEvent, PoolRow, Pools } from "../../services/engine/src/gemini.ts";

export const T0 = Date.UTC(2026, 10, 17, 18, 0, 30); // half a minute past a mark
export const S: Settings = { minSize: 100, maxSpreadCents: 10, exponent: 2, floorCents: 0.1, minPayoutMicros: 1_000_000 };

export function ev(ticker: string, tops: [number | null, number | null][], over: Partial<ListedEvent> = {}): ListedEvent {
  return {
    ticker, title: "Made-up game " + ticker, category: "Sports", subcategory: null, startMs: T0 + 30 * 3_600_000, live: false, volume: 10,
    contracts: tops.map(([b, a], i) => ({ symbol: ticker + "-" + i, stepCents: 1, top: { bidCents: b, askCents: a } })), unread: [], ...over,
  };
}

export function row(ticker: string, id: number | null, count: number, over: Partial<PoolRow> = {}): PoolRow {
  return {
    ticker, title: "made up", category: "Pro Made-Up", poolMicrosADay: 300_000_000, source: "category_default", endsAtMs: null, makers: 0,
    poolId: id, poolEventCount: count, poolName: id === null ? null : "Pool " + id, poolKey: id === null ? "event:" + ticker : "id:" + id, raw: {}, ...over,
  };
}

export const pools = (rows: PoolRow[], lastScoreDate = "2026-11-16"): Pools => ({ lastScoreDate, total: rows.length, rows, twice: 0, moved: false });

export function passAt(atMs: number, counts: Partial<PoolCount>[]): PassRow {
  return {
    kind: "pass", atMs, day: "2026-11-17", ruleHash: "ab".repeat(32), volume: { rose: 0, level: 0, nothing: 0 },
    pools: counts.map((c) => ({ pool: "id:1", eventCount: 1, listed: 1, live: 0, unread: 0, nonePrices: 0, noneSizes: 0, may: 0, state: "may", ...c })),
  };
}
