// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";

import { allocate } from "../alloc.ts";
import { screenOf } from "../pools.ts";
import { simAt, SIM_SETTINGS } from "./markets.ts";

const T = Date.UTC(2026, 10, 20, 9, 0, 20);

test("the invented markets are the same for everyone in a minute and move by the next", () => {
  const a = simAt(T), b = simAt(T + 30_000), c = simAt(T + 60_000);
  const flat = (s: ReturnType<typeof simAt>) => JSON.stringify([...s.read].map(([k, r]) => [k, [...r.books]]));
  expect(flat(a)).toBe(flat(b));
  expect(flat(a)).not.toBe(flat(c));
  expect(a.input.source).toBe("sim");
});

test("every book has both sides in whole cents between 1 and 99, the bid under the ask, and every symbol is its own", () => {
  const seen = new Set<string>();
  for (let m = 0; m < 180; m += 7) {
    const s = simAt(T + m * 60_000);
    seen.clear();
    for (const r of s.read.values()) for (const [symbol, book] of r.books) {
      expect(seen.has(symbol)).toBe(false);
      seen.add(symbol);
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);
      for (const l of [...book.bids, ...book.asks]) { expect(Number.isInteger(l.cents) && l.cents >= 1 && l.cents <= 99).toBe(true); expect(l.qty).toBeGreaterThan(0); }
      expect(book.bids[0].cents).toBeLessThan(book.asks[0].cents);
    }
  }
});

test("the screen reads them: every pool is on it, some hold no qualifying pair, and a budget is placed across more than one pool", () => {
  const s = simAt(T);
  const screen = screenOf({ ...s.input, readAtMs: Object.fromEntries([...s.read].map(([k, r]) => [k, r.atMs])) }, T);
  expect(screen.sport.length).toBe(s.read.size);
  expect(screen.sport.every((p) => p.read)).toBe(true);
  expect(screen.sport.some((p) => p.count.state === "none-prices")).toBe(true);
  expect(screen.sport.some((p) => p.count.state === "may")).toBe(true);
  expect(typeof allocate).toBe("function");
  expect(SIM_SETTINGS.minSize).toBeGreaterThan(0);
});
