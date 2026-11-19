// Every value in this file is invented. None is a reading of any market.
import { describe, expect, it } from "vitest";
import { orderScore } from "@app/score";
import { calcPool, quoteFor } from "./calc.ts";
import { S } from "./fixtures.ts";

const top = { bidCents: 40, askCents: 44 };

describe("quoteFor", () => {
  it("centres the widest pair on the midpoint and prices what it ties up", () => {
    const q = quoteFor(S, top, 1, 100, 10)!;
    expect(q.pair).toEqual({ bid: { cents: 37, qty: 100 }, ask: { cents: 47, qty: 100 } });
    expect(q.tiedMicros).toBe((37 + 53) * 100 * 10_000); // $90
    expect(q.worstLossMicros).toBe(53 * 100 * 10_000); // the ask filled and the contract settling at a dollar
  });

  it("scores as orderScore does when the size and the spread change", () => {
    const wide = quoteFor(S, top, 1, 100, 10)!, big = quoteFor(S, top, 1, 300, 10)!, tight = quoteFor(S, top, 1, 100, 6)!;
    expect(wide.score).toBe(orderScore(S, 37, 100, 84) + orderScore(S, 47, 100, 84));
    expect(big.score).toBe(3 * wide.score);
    expect(tight.pair).toEqual({ bid: { cents: 39, qty: 100 }, ask: { cents: 45, qty: 100 } });
    expect(tight.score).toBe(orderScore(S, 39, 100, 84) + orderScore(S, 45, 100, 84));
    expect(tight.score).toBeGreaterThan(wide.score);
  });

  it("gives nothing under the least size, over the widest spread, or with a side missing", () => {
    expect(quoteFor(S, top, 1, 99, 10)).toBeNull();
    expect(quoteFor(S, top, 1, 100, 11)).toBeNull();
    expect(quoteFor(S, { bidCents: null, askCents: 44 }, 1, 100, 10)).toBeNull();
  });

  it("narrows the pair where the widest would leave the range of prices, down to joining the best prices", () => {
    const low = quoteFor(S, { bidCents: 1, askCents: 3 }, 1, 100, 10)!; // five cents under a midpoint of two is below one cent
    expect(low.pair).toEqual({ bid: { cents: 1, qty: 100 }, ask: { cents: 3, qty: 100 } });
    expect(low.score).toBe(orderScore(S, 1, 100, 4) + orderScore(S, 3, 100, 4));
    expect(low.tiedMicros).toBe((1 + 97) * 100 * 10_000);
    const high = quoteFor(S, { bidCents: 97, askCents: 98 }, 1, 100, 10)!;
    expect(high.pair).toEqual({ bid: { cents: 96, qty: 100 }, ask: { cents: 99, qty: 100 } }); // three apart is the widest that stays at or under 99
  });

  it("takes the midpoint its own pair gives a wider book", () => {
    const q = quoteFor(S, { bidCents: 30, askCents: 50 }, 1, 100, 10)!; // the book is 20 wide; the pair rests inside it
    expect(q.pair).toEqual({ bid: { cents: 35, qty: 100 }, ask: { cents: 45, qty: 100 } });
    expect(q.score).toBe(orderScore(S, 35, 100, 80) + orderScore(S, 45, 100, 80));
  });
});

describe("calcPool", () => {
  const contracts = [
    { symbol: "A", top, stepCents: 1 },
    { symbol: "B", top: { bidCents: null, askCents: 9 }, stepCents: 1 },
  ];

  it("sums what the quoted contracts tie up and gives the whole minute as the credit alone", () => {
    const c = calcPool(S, 144_000_000, contracts, 100, 10);
    expect(c.quoted).toBe(1);
    expect(c.rows.map((r) => r.quote === null)).toEqual([false, true]);
    expect(c.tiedMicros).toBe(90_000_000);
    expect(c.worstLossMicros).toBe(53_000_000);
    expect(c.aloneMicrosAMinute).toBe(100_000); // 144 dollars a day over 1,440 minutes
    expect(c.least).toBeNull(); // no book read
  });

  it("gives no least share until every book is read", () => {
    const two = [contracts[0], { symbol: "C", top: { bidCents: 60, askCents: 63 }, stepCents: 1 }];
    const one = [{ ...two[0], book: { bids: [{ cents: 40, qty: 50 }], asks: [{ cents: 44, qty: 50 }] } }, two[1]];
    expect(calcPool(S, 144_000_000, one, 100, 10).least).toBeNull();
  });

  it("needs no book where the best prices already hold no qualifying pair, and claims nothing for a pool not handed over whole", () => {
    const book = { bids: [{ cents: 40, qty: 200 }], asks: [{ cents: 44, qty: 200 }] };
    const read = [{ ...contracts[0], book }, contracts[1]]; // B has a side missing and no book
    expect(calcPool(S, 144_000_000, read, 100, 10).least).not.toBeNull();
    expect(calcPool(S, 144_000_000, read, 100, 10, false).least).toBeNull();
  });

  it("sets ours against the most the resting orders can be scoring", () => {
    const book = { bids: [{ cents: 40, qty: 200 }], asks: [{ cents: 44, qty: 200 }] };
    const both = [{ ...contracts[0], book }, { ...contracts[1], book: { bids: [], asks: [{ cents: 9, qty: 500 }] } }];
    const c = calcPool(S, 144_000_000, both, 100, 10);
    const ours = c.rows[0].quote!.score;
    const others = orderScore(S, 40, 200, 84) + orderScore(S, 44, 200, 84); // book B has a side missing: nobody qualifies there
    expect(c.least!.share).toBeCloseTo(ours / (ours + others), 12);
    expect(c.least!.microsAMinute).toBe(Math.floor(100_000 * c.least!.share));
    expect(c.least!.share).toBeLessThan(0.5);
  });

  // Audit of 2026-11-18, finding 1: the list's prices and the book read after them can disagree.
  it("takes the best prices from the book where one was read, never from the list", () => {
    const s2 = { ...S, minSize: 10, maxSpreadCents: 6 };
    const moved = [{ symbol: "A", stepCents: 1, top: { bidCents: 10, askCents: 90 }, book: { bids: [{ cents: 49, qty: 1000 }], asks: [{ cents: 51, qty: 1000 }] } }];
    const c = calcPool(s2, 144_000_000, moved, 10, 6);
    expect(c.rows[0].top).toEqual({ bidCents: 49, askCents: 51 });
    expect(c.least!.share).toBeLessThan(0.01); // the list alone would have said the whole pool
    const through = [{ symbol: "A", stepCents: 1, top: { bidCents: 40, askCents: 44 }, book: { bids: [{ cents: 45, qty: 200 }], asks: [{ cents: 48, qty: 200 }] } }];
    const q = calcPool(S, 144_000_000, through, 100, 4).rows[0].quote!;
    expect(q.pair.bid.cents).toBeLessThanOrEqual(45); // centred on the book's prices, not resting through them
    expect(q.pair.ask.cents).toBeGreaterThanOrEqual(48);
  });

  it("claims no floor while it quotes in a contract whose book was not read", () => {
    const wide = [{ symbol: "A", stepCents: 1, top: { bidCents: 30, askCents: 50 } }]; // wider than the widest spread by the list: no book was asked for
    const c = calcPool(S, 144_000_000, wide, 100, 10);
    expect(c.quoted).toBe(1);
    expect(c.least).toBeNull();
  });

  it("every pair it gives qualifies, whatever the best prices", () => {
    for (let b = 1; b < 99; b++) for (let a = b + 1; a <= 99; a++) for (const w of [1, 3, 10]) {
      const q = quoteFor(S, { bidCents: b, askCents: a }, 1, 100, w);
      if (q === null) continue;
      expect(q.pair.ask.cents - q.pair.bid.cents).toBeLessThanOrEqual(10);
      expect(q.pair.bid.cents).toBeGreaterThanOrEqual(1);
      expect(q.pair.ask.cents).toBeLessThanOrEqual(99);
      expect(q.pair.ask.cents).toBeGreaterThan(q.pair.bid.cents);
    }
  });

  // Audit round 2: the same gap reached through the price step.
  it("claims no floor while a contract with both listed prices has no book, even one it cannot quote", () => {
    const cs = [
      { symbol: "A", stepCents: 1, top: { bidCents: 40, askCents: 44 }, book: { bids: [{ cents: 40, qty: 200 }], asks: [{ cents: 44, qty: 200 }] } },
      { symbol: "B", stepCents: 5, top: { bidCents: 12, askCents: 88 } }, // wide by the list; on a step of five no pair is given here
    ];
    expect(calcPool(S, 144_000_000, cs, 100, 4).least).toBeNull();
  });
});
