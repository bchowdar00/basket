// The worked example of the one page: a business whose trade follows a team, and the contracts in
// pools Basket already reads that would pay it when the team falls short. Pure: it works only on
// what Basket's server has read (its list and its books) and on the allocation library. No figure
// of the exchange's is written here; the contracts are found by their names.
//
// "Falls short" side: a contract pays a dollar if its event happens. The other side of it pays a
// dollar if it does not, and is priced here as a dollar less the resting bid, taken bid by bid.
// That is an assumption about how the other side is taken; the exchange's trading rules were not
// read, and the page says so.
import type { Book, Level, Settings } from "@app/score";
import { allocate, restingPair, toAllocPool, type AllocPool, type ReadEvent } from "../alloc.ts";
import type { ListedEvent, PoolRow } from "../../../services/engine/src/gemini.ts";

export type Held = { atMs: number; events: ListedEvent[]; books: Record<string, Book> };
export type Leg = { symbol: string; pool: string; paysIf: string; order: number; bids: Level[]; askCents: number | null; stepCents: number; atMs: number };

/** The contracts of the example among the pools held, in a fixed order: the division first, then
 * the win totals from the lowest. Only contracts whose book was read are legs. */
export function findLegs(pools: Record<string, Held>): Leg[] {
  const legs: Leg[] = [];
  for (const [pool, held] of Object.entries(pools)) {
    for (const e of held.events) {
      if (e.live) continue;
      const symbols = [...e.contracts.map((c) => c.symbol), ...e.unread];
      // A contract the list could not price has no step given; one cent is used, as the allocator does.
      const rest = (symbol: string, book: Book) => ({ bids: book.bids, askCents: book.asks.length === 0 ? null : Math.min(...book.asks.map((a) => a.cents)), stepCents: e.contracts.find((c) => c.symbol === symbol)?.stepCents ?? 1, atMs: held.atMs });
      if (/afc east/i.test(e.title)) {
        for (const symbol of symbols) {
          const book = held.books[symbol];
          if (/-BUF$/.test(symbol) && book !== undefined) legs.push({ symbol, pool, paysIf: "Buffalo does not win the AFC East", order: 0, ...rest(symbol, book) });
        }
      } else if (/buffalo/i.test(e.title) && /wins/i.test(e.title)) {
        for (const symbol of symbols) {
          const m = /-(\d+)PLUS$/.exec(symbol);
          const book = held.books[symbol];
          if (m !== null && book !== undefined) legs.push({ symbol, pool, paysIf: "Buffalo wins fewer than " + Number(m[1]) + " games", order: Number(m[1]), ...rest(symbol, book) });
        }
      }
    }
  }
  return legs.sort((a, b) => a.order - b.order);
}

export type Cover = { priceCents: number | null; resting: number; filled: number; costMicros: number };

/** Taking `want` contracts of a leg's falls-short side against the resting bids, best bid first. */
export function cover(leg: Leg, want: number): Cover {
  const bids = [...leg.bids].sort((a, b) => b.cents - a.cents);
  let left = Math.max(0, want), filled = 0, costMicros = 0, resting = 0;
  for (const b of bids) {
    resting += b.qty;
    const take = Math.min(b.qty, left);
    filled += take; left -= take;
    costMicros += take * (100 - b.cents) * 10_000;
  }
  return { priceCents: bids.length === 0 ? null : 100 - bids[0].cents, resting, filled, costMicros: Math.round(costMicros) };
}

/** The bids Basket's allocator would rest in the example's pools for a budget, joining the best
 * prices: by symbol, the size and the price. A pool no floor can be worked out for adds nothing. */
export function basketBids(settings: Settings, rows: PoolRow[], pools: Record<string, Held>, legs: Leg[], budgetUsd: number): Map<string, Level> {
  const out = new Map<string, Level>();
  const alloc: AllocPool[] = [];
  for (const key of new Set(legs.map((l) => l.pool))) {
    const held = pools[key];
    const mine = rows.filter((r) => r.poolKey === key);
    if (held === undefined || mine.length === 0) continue;
    const events: ReadEvent[] = held.events.map((e) => ({ live: e.live, contracts: e.contracts, unread: e.unread }));
    const got = toAllocPool(settings, { key, name: mine[0].poolName ?? mine[0].title, microsADay: Math.min(...mine.map((r) => r.poolMicrosADay)), eventCount: mine[0].poolEventCount ?? mine.length }, events, new Map(Object.entries(held.books)));
    if (!("why" in got)) alloc.push(got);
  }
  if (alloc.length === 0) return out;
  for (const q of allocate(settings, alloc, budgetUsd * 1_000_000, "join").quotes) out.set(q.symbol, { cents: q.pair.bid.cents, qty: q.pair.bid.qty });
  return out;
}

/** The bid of a pair at the program's least size resting in a leg at the best prices (the
 * allocator's own "join"), or null where no qualifying pair can rest there. */
export function leastBid(settings: Settings, leg: Leg): Level | null {
  const bidCents = leg.bids.length === 0 ? null : Math.max(...leg.bids.map((b) => b.cents));
  return restingPair(settings, { top: { bidCents, askCents: leg.askCents }, stepCents: leg.stepCents }, "join")?.bid ?? null;
}
