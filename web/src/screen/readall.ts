// The "read every pool for the allocator" run's pure sequencing: which pools to read, in which
// order, and how many events that is. The run itself (one request to /feed/pool at a time, 1.2
// seconds apart, stoppable) lives in App; only this decision is pure, so it can be tested without a
// network.

/** Categories of short-lived crypto markets: they settle too fast to be worth a maker's floor, so a
 * pool every category of which is one of these is not read. */
export const SKIP_CATEGORIES = ["Bitcoin", "Ether", "Solana", "XRP", "HYPE", "Zcash"];

/** The least a pool must carry for this run to decide on it: its key, its categories, and how many
 * events the reward list gives it. `PoolView` from `pools.ts` has all three. */
export type Readable = { key: string; categories: string[]; count: { eventCount: number } };

/**
 * The pools to read, in the order of `sport`: every pool not already read and not all-crypto. A
 * pool with no category is kept (nothing says it is short-lived).
 */
export function poolsToRead<T extends Readable>(sport: readonly T[], readKeys: ReadonlySet<string>, skipCategories: readonly string[]): T[] {
  const skip = new Set(skipCategories);
  return sport.filter((p) => {
    if (readKeys.has(p.key)) return false;
    if (p.categories.length > 0 && p.categories.every((c) => skip.has(c))) return false;
    return true;
  });
}

/** The number of events a run over these pools would ask for (E on the confirm line). */
export function eventsToRead(pools: readonly { count: { eventCount: number } }[]): number {
  return pools.reduce((n, p) => n + p.count.eventCount, 0);
}
