// Every value in this file is invented. None is a reading of any market.
import { describe, expect, it } from "vitest";
import { ourScore, pairQualifies, poolOthersMost } from "@app/score";
import { allocate, toAllocPool, type AllocPool } from "./alloc.ts";
import { S } from "./fixtures.ts";

const book = (bid: [number, number] | null, ask: [number, number] | null) => ({ bids: bid ? [{ cents: bid[0], qty: bid[1] }] : [], asks: ask ? [{ cents: ask[0], qty: ask[1] }] : [] });
const c = (symbol: string, bid: [number, number] | null, ask: [number, number] | null) => ({ symbol, stepCents: 1, top: { bidCents: bid?.[0] ?? null, askCents: ask?.[0] ?? null }, book: book(bid, ask) });
const USD = 1_000_000;

// Pool A: a mid-priced contract with a little resting. Pool B: a penny contract with a lot resting.
const A: AllocPool = { key: "a", name: "A", microsADay: 20 * USD, contracts: [c("A-1", [40, 200], [44, 200])] };
const B: AllocPool = { key: "b", name: "B", microsADay: 20 * USD, contracts: [c("B-1", [1, 5_000], [3, 300])] };

describe("allocate", () => {
  it("spends nothing it does not have, and every quote it places qualifies", () => {
    for (const budget of [0, 50, 99, 150, 400, 5_000]) {
      const out = allocate(S, [A, B], budget * USD, "join");
      expect(out.tiedMicros).toBeLessThanOrEqual(budget * USD);
      for (const q of out.quotes) {
        expect(pairQualifies(S, q.pair)).toBe(true);
        expect(q.score).toBe(ourScore(S, q.pair, [A, B].flatMap((p) => p.contracts).find((x) => x.symbol === q.symbol)!.top));
      }
    }
    expect(allocate(S, [A, B], 50 * USD, "join").quotes).toEqual([]); // no pair of the least size fits in fifty dollars
  });

  it("with room for one entry, takes the one that adds the most floor a dollar", () => {
    // Joining A costs (40 + 56) x 100 cents = $96 and scores 100/4 x 2 = 50 against 100 resting: a third of the pool.
    // Joining B costs (1 + 97) x 100 cents = $98 and scores 100/1 x 2 = 200 against 5,300 resting: under a twentieth.
    const out = allocate(S, [A, B], 100 * USD, "join");
    expect(out.quotes.map((q) => q.symbol)).toEqual(["A-1"]);
    expect(out.pools[0].share).toBeCloseTo(50 / 150, 12);
    expect(out.leastMicrosADay).toBe(Math.floor((20 * USD * 50) / 150));
  });

  it("grows the cheap side, not both alike", () => {
    const out = allocate(S, [B], 300 * USD, "join");
    const q = out.quotes[0];
    expect(q.pair.ask.qty).toBe(100); // an ask at three cents costs 97 cents a contract
    expect(q.pair.bid.qty).toBeGreaterThan(1_000); // a bid at one cent costs a cent
    expect(q.tiedMicros).toBeLessThanOrEqual(300 * USD);
    expect(q.tiedMicros).toBeGreaterThan(299 * USD); // a block of the bid is one dollar: almost none is left over
  });

  it("stops adding to a pool nobody else can be scoring in: one entry already takes it whole", () => {
    const alone: AllocPool = { key: "c", name: "C", microsADay: 5 * USD, contracts: [c("C-1", [30, 10], [50, 10])] }; // a book twenty wide: no qualifying pair in it
    const out = allocate(S, [alone], 10_000 * USD, "widest");
    expect(out.quotes.length).toBe(1);
    expect(out.quotes[0].pair).toEqual({ bid: { cents: 35, qty: 100 }, ask: { cents: 45, qty: 100 } });
    expect(out.pools[0].share).toBe(1);
    expect(out.leastMicrosADay).toBe(5 * USD);
  });

  it("the widest stance scores less than joining in the same book", () => {
    const wide = allocate(S, [A], 100 * USD, "widest"), join = allocate(S, [A], 100 * USD, "join");
    expect(wide.quotes[0].pair).toEqual({ bid: { cents: 37, qty: 100 }, ask: { cents: 47, qty: 100 } });
    expect(wide.pools[0].share).toBeLessThan(join.pools[0].share);
  });

  it("leaves out a pool with a book not read whole, and one no pair can rest in, and says why", () => {
    const cut: AllocPool = { key: "d", name: "D", microsADay: USD, contracts: [{ ...c("D-1", [40, 200], [44, 200]), book: { bids: [{ cents: 40, qty: 200 }], asks: [{ cents: 44, qty: 200 }], depth: 1 } }] };
    const empty: AllocPool = { key: "e", name: "E", microsADay: USD, contracts: [c("E-1", null, [3, 12])] };
    const out = allocate(S, [cut, empty, A], 100 * USD, "join");
    expect(out.leftOut.map((x) => x.key)).toEqual(["d", "e"]);
    expect(out.quotes.map((q) => q.pool)).toEqual(["a"]);
  });

  it("spreads across pools once a pool's next dollar adds less than another's first", () => {
    const out = allocate(S, [A, B], 2_000 * USD, "join");
    expect(new Set(out.quotes.map((q) => q.pool))).toEqual(new Set(["a", "b"]));
    expect(out.leastMicrosADay).toBe(out.pools.reduce((n, p) => n + p.leastMicrosADay, 0));
    expect(out.leastMicrosADay).toBeLessThan(40 * USD); // never more than the pools hold
  });
});

describe("toAllocPool", () => {
  const pool = { key: "p", name: "P", microsADay: USD, eventCount: 1 };
  const priced = { symbol: "P-1", stepCents: 1, top: { bidCents: 40, askCents: 44 } };
  const oneSided = { symbol: "P-2", stepCents: 1, top: { bidCents: null, askCents: 3 } };
  const b = book([40, 200], [44, 200]);

  it("takes a pool whose every scoring contract has its book, and gives a one-sided contract an empty one", () => {
    const out = toAllocPool(S, pool, [{ live: false, contracts: [priced, oneSided], unread: ["P-3"] }], new Map([["P-1", b], ["P-3", book(null, [3, 12])]]));
    expect("why" in out).toBe(false);
    const p = out as AllocPool;
    expect(p.contracts.map((x) => x.symbol)).toEqual(["P-1", "P-2", "P-3"]);
    expect(p.contracts[1].book).toEqual({ bids: [], asks: [] });
    expect(p.contracts[2].top).toEqual({ bidCents: null, askCents: 3 }); // the unpriced contract's prices are its book's
  });

  it("gives the reason where no floor can be worked out", () => {
    const why = (events: Parameters<typeof toAllocPool>[2], books = new Map([["P-1", b]]), count = 1) => (toAllocPool(S, { ...pool, eventCount: count }, events, books) as { why: string }).why;
    expect(why([])).toBe("not read");
    expect(why([{ live: false, contracts: [priced], unread: [] }], undefined, 2)).toMatch(/only 1 of its 2 events/);
    expect(why([{ live: true, contracts: [priced], unread: [] }])).toMatch(/in play/);
    expect(why([{ live: false, contracts: [priced], unread: [] }], new Map())).toMatch(/book of P-1 was not read/);
    expect(why([{ live: false, contracts: [priced], unread: ["P-3"] }])).toMatch(/could not price/);
  });
});

// Audit of 2026-11-18, findings 2 and 6.
describe("the allocator after the audit", () => {
  const pool = { key: "p", name: "P", microsADay: 1_000 * USD, eventCount: 1 };
  it("rests on the book's prices, not the list's, and never through them", () => {
    const p = toAllocPool(S, pool, [{ live: false, contracts: [{ symbol: "P-1", stepCents: 1, top: { bidCents: 40, askCents: 44 } }], unread: [] }], new Map([["P-1", book([45, 200], [48, 200])]])) as AllocPool;
    expect(p.contracts[0].top).toEqual({ bidCents: 45, askCents: 48 });
    const out = allocate(S, [p], 100 * USD, "join");
    expect(out.quotes[0].pair.bid.cents).toBe(45);
    expect(out.quotes[0].pair.ask.cents).toBe(48);
  });

  it("places nothing in a contract whose book was not read", () => {
    // A side missing on the list is the one case with no book (round 2: a contract with both prices listed is refused without one).
    const p = toAllocPool(S, pool, [{ live: false, contracts: [{ symbol: "P-1", stepCents: 1, top: { bidCents: null, askCents: 90 } }], unread: [] }], new Map()) as AllocPool;
    expect(p.contracts[0].noBook).toBe(true);
    const out = allocate(S, [p], 1_000 * USD, "widest");
    expect(out.quotes).toEqual([]);
    expect(out.leftOut.map((x) => x.key)).toEqual(["p"]);
  });

  it("refuses a pool with an event that lists no contract", () => {
    const out = toAllocPool(S, pool, [{ live: false, contracts: [], unread: [] }], new Map()) as { why: string };
    expect(out.why).toMatch(/lists no contract/);
  });
});

// Audit round 2: a contract the list shows two prices for needs its book, however wide the list says it is.
describe("the allocator after the second audit round", () => {
  it("refuses a pool where a contract with both listed prices has no book", () => {
    const out = toAllocPool(S, { key: "p", name: "P", microsADay: USD, eventCount: 1 },
      [{ live: false, contracts: [{ symbol: "P-1", stepCents: 1, top: { bidCents: 45, askCents: 48 } }, { symbol: "P-2", stepCents: 1, top: { bidCents: 10, askCents: 90 } }], unread: [] }],
      new Map([["P-1", book([45, 10], [48, 10])]])) as { why: string };
    expect(out.why).toMatch(/book of P-2 was not read/);
  });
});

// Audit of 2026-11-18, the screen, finding 3.
describe("a pair resting inside a book's best prices", () => {
  it("has the others scored at the midpoint the pair gives the book, not the one read", () => {
    // On a five-cent step the widest pair around 40 and 49 is 40 and 45: the ask rests inside the book.
    const bk = { bids: [{ cents: 40, qty: 300 }], asks: [{ cents: 49, qty: 300 }] };
    const pool: AllocPool = { key: "s", name: "S", microsADay: 20 * USD, contracts: [{ symbol: "S-1", stepCents: 5, top: { bidCents: 40, askCents: 49 }, book: bk }] };
    const out = allocate(S, [pool], 100 * USD, "widest");
    const q = out.quotes[0];
    expect([q.pair.bid.cents, q.pair.ask.cents]).toEqual([40, 45]);
    const read = poolOthersMost(S, [{ book: bk }])!, moved = poolOthersMost(S, [{ book: bk, pair: q.pair }])!;
    expect(moved).not.toBe(read);
    expect(out.pools[0].othersMost).toBe(moved);
    expect(out.pools[0].share).toBeCloseTo(q.score / (q.score + moved), 12);
    expect(out.leastMicrosADay).toBe(Math.floor((20 * USD * q.score) / (q.score + moved)));
  });
});

describe("a large budget", () => {
  it("is worked out in bounded time, spends what it can, and every quote still qualifies", () => {
    const pools: AllocPool[] = Array.from({ length: 80 }, (_, i) => ({ key: "p" + i, name: "P" + i, microsADay: (5 + i) * USD, contracts: [c("P" + i + "-1", [1 + (i % 40), 500 + i], [4 + (i % 40), 300 + i]), c("P" + i + "-2", [50, 200], [55, 200])] }));
    const t = Date.now();
    const out = allocate(S, pools, 1_000_000 * USD, "widest");
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(out.tiedMicros).toBeLessThanOrEqual(1_000_000 * USD);
    expect(out.tiedMicros).toBeGreaterThan(999_000 * USD);
    for (const q of out.quotes) expect(pairQualifies(S, q.pair)).toBe(true);
  });
});
