// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  eventState, leastShare, makerScore, midHalfCents, minuteShareMicros, mostOthersScore, noneFromPrices, noneFromSizes,
  orderScore, ourScore, pairQualifies, poolOthersMost, poolState, readSettings, sharesInPool, widestPair, type Book, type PoolEvent, type Settings,
} from "../src/index.ts";

// The shape of the exchange's settings answer, with invented figures of the kind it publishes.
const config = { enabled: true, min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 };
const s: Settings = readSettings(config);
const lv = (cents: number, qty: number) => ({ cents, qty });
const share = (mine: number, ...others: number[]) => mine / (mine + others.reduce((a, b) => a + b, 0));

test("the settings are read from the exchange's answer, in cents and millionths", () => {
  assert.deepEqual(s, { minSize: 100, maxSpreadCents: 10, exponent: 2, floorCents: 0.1, minPayoutMicros: 1_000_000 });
});

test("settings with a missing figure, a negative figure or text that is not a number are refused", () => {
  const { min_size_threshold: _gone, ...missing } = config;
  assert.throws(() => readSettings(missing), /min_size_threshold/);
  assert.throws(() => readSettings({ ...config, max_spread_cents: -10 }), /max_spread_cents/);
  assert.throws(() => readSettings({ ...config, spread_penalty_exponent: "two" }), /spread_penalty_exponent/);
  assert.throws(() => readSettings(null), /settings/);
});

test("a midpoint is carried doubled, so a half cent is a whole number", () => {
  assert.equal(midHalfCents({ bidCents: 48, askCents: 53 }), 101);
  assert.equal(midHalfCents({ bidCents: 48, askCents: null }), null);
});

test("the published worked example: two makers around a 50.5 cent midpoint split a snapshot 78.7 to 21.3", () => {
  const mid = 101;
  const a = makerScore(s, { bid: lv(48, 100), ask: lv(52, 100) }, mid);
  const b = makerScore(s, { bid: lv(47, 100), ask: lv(54, 100) }, mid);
  assert.equal((share(a, b) * 100).toFixed(1), "78.7");
  assert.equal((share(b, a) * 100).toFixed(1), "21.3");
});

test("a pair twenty cents wide, a one-sided maker and a maker under the least size score nothing", () => {
  const mid = 100;
  assert.equal(makerScore(s, { bid: lv(40, 100), ask: lv(60, 100) }, mid), 0);
  assert.equal(makerScore(s, { bid: lv(49, 100), ask: null }, mid), 0);
  assert.equal(makerScore(s, { bid: lv(48, 99), ask: lv(52, 100) }, mid), 0);
  assert.equal(orderScore(s, 48, 99, mid), 0);
});

test("a pair exactly at the widest spread qualifies; one cent wider does not", () => {
  assert.equal(pairQualifies(s, { bid: lv(45, 100), ask: lv(55, 100) }), true);
  assert.equal(pairQualifies(s, { bid: lv(45, 100), ask: lv(56, 100) }), false);
});

test("an order at the midpoint is scored at the floor, not at zero distance", () => {
  assert.equal(orderScore(s, 50, 100, 100), 100 / 0.1 ** 2);
});

test("from prices alone: nobody can qualify in a book wider than the widest spread or with a side missing", () => {
  assert.equal(noneFromPrices(s, { bidCents: 40, askCents: 51 }), true);
  assert.equal(noneFromPrices(s, { bidCents: 40, askCents: null }), true);
  assert.equal(noneFromPrices(s, { bidCents: null, askCents: null }), true);
  assert.equal(noneFromPrices(s, { bidCents: 40, askCents: 50 }), false);
});

test("a crossed or locked answer is never read as 'nobody can qualify'", () => {
  assert.equal(noneFromPrices(s, { bidCents: 50, askCents: 50 }), false);
  assert.equal(noneFromPrices(s, { bidCents: 52, askCents: 50 }), false);
  assert.equal(noneFromSizes(s, { bids: [lv(52, 500)], asks: [lv(50, 500)] }), null);
});

test("from sizes: nobody can qualify when one side holds fewer than the least size inside every window", () => {
  const thinBid: Book = { bids: [lv(47, 60), lv(46, 39)], asks: [lv(53, 400)] };            // 6 cents wide, 99 bids in all
  assert.equal(noneFromSizes(s, thinBid), true);
  const enough: Book = { bids: [lv(47, 60), lv(46, 40)], asks: [lv(53, 400)] };             // 100 bids at 46 and above; 46 to 53 is 7 cents
  assert.equal(noneFromSizes(s, enough), false);
  const tooFar: Book = { bids: [lv(47, 60), lv(42, 40)], asks: [lv(53, 400)] };             // the hundredth bid is 11 cents from the ask
  assert.equal(noneFromSizes(s, tooFar), true);
  const thinAsk: Book = { bids: [lv(47, 400)], asks: [lv(53, 50), lv(58, 50)] };            // the hundredth ask is 11 cents from the bid
  assert.equal(noneFromSizes(s, thinAsk), true);
});

test("from sizes: a book wider than the widest spread, or with a side empty, is left to the prices", () => {
  assert.equal(noneFromSizes(s, { bids: [lv(40, 500)], asks: [lv(51, 500)] }), null);
  assert.equal(noneFromSizes(s, { bids: [], asks: [lv(51, 500)] }), null);
});

test("from sizes: when only the top levels were read and they end inside the window, nothing is concluded", () => {
  const five: Book = { bids: [lv(47, 10), lv(46, 10), lv(45, 10), lv(44, 10), lv(43, 10)], asks: [lv(50, 400)], depth: 5 };
  assert.equal(noneFromSizes(s, five), null);                 // a sixth bid at 42 or 41 could still make the hundred
  const reached: Book = { bids: [lv(47, 10), lv(46, 10), lv(45, 10), lv(44, 10), lv(39, 10)], asks: [lv(50, 400)], depth: 5 };
  assert.equal(noneFromSizes(s, reached), true);              // the fifth bid is already outside every window
});

test("an event's state: every contract wide; a narrow contract not yet read; a narrow contract read and thin", () => {
  const wide = { top: { bidCents: 30, askCents: 45 } };
  const narrow = { top: { bidCents: 47, askCents: 53 } };
  assert.equal(eventState(s, [wide, wide]), "none-prices");
  assert.equal(eventState(s, [wide, narrow]), "may");
  assert.equal(eventState(s, [wide, { ...narrow, book: { bids: [lv(47, 99)], asks: [lv(53, 400)] } }]), "none-sizes");
  assert.equal(eventState(s, [wide, { ...narrow, book: { bids: [lv(47, 100)], asks: [lv(53, 400)] } }]), "may");
  assert.equal(eventState(s, []), "may");                     // an event with no contract listed proves nothing
});

test("the widest pair sits five cents each side of a whole-cent midpoint", () => {
  assert.deepEqual(widestPair(s, { bidCents: 44, askCents: 56 }, 1), { bid: lv(45, 100), ask: lv(55, 100) });
});

test("around a half-cent midpoint the widest pair is nine cents wide, on whole cents", () => {
  assert.deepEqual(widestPair(s, { bidCents: 44, askCents: 57 }, 1), { bid: lv(46, 100), ask: lv(55, 100) });
});

test("the price step is taken from the caller: on a five-cent step the pair lands on the step", () => {
  assert.deepEqual(widestPair(s, { bidCents: 40, askCents: 60 }, 5), { bid: lv(45, 100), ask: lv(55, 100) });
  assert.deepEqual(widestPair(s, { bidCents: 40, askCents: 55 }, 5), { bid: lv(45, 100), ask: lv(50, 100) });
  assert.throws(() => widestPair(s, { bidCents: 40, askCents: 60 }, 0.5), /step/);
});

test("no pair is written for a one-sided, crossed or edge-of-range book", () => {
  assert.equal(widestPair(s, { bidCents: 44, askCents: null }, 1), null);
  assert.equal(widestPair(s, { bidCents: 50, askCents: 50 }, 1), null);
  assert.equal(widestPair(s, { bidCents: 1, askCents: 6 }, 1), null);       // the bid would be below one cent
  assert.equal(widestPair(s, { bidCents: 94, askCents: 99 }, 1), null);     // the ask would be above ninety-nine
});

test("the most the others can be scoring: every resting contract counts, whatever the size of its level", () => {
  const book: Book = { bids: [lv(48, 100), lv(47, 99)], asks: [lv(52, 300)] };
  assert.equal(mostOthersScore(s, book, 100), 100 / 2 ** 2 + 99 / 3 ** 2 + 300 / 2 ** 2);   // an account's small order scores beside its large one
  assert.equal(mostOthersScore(s, { bids: [lv(48, 100), lv(30, 40)], asks: [lv(52, 100)] }, 100), 100 / 4 + 40 / 20 ** 2 + 100 / 4); // and so does one far from the midpoint
});

test("the most the others can be scoring is nothing where nobody can be qualifying", () => {
  assert.equal(mostOthersScore(s, { bids: [lv(40, 500)], asks: [lv(55, 500)] }, 95), 0);    // wider than the widest spread
  assert.equal(mostOthersScore(s, { bids: [lv(48, 60)], asks: [lv(52, 500)] }, 100), 0);    // too thin on one side for any pair
  assert.equal(mostOthersScore(s, { bids: [lv(40, 500), lv(39, 500)], asks: [lv(55, 500), lv(56, 500)], depth: 2 }, 95), 0); // the prices decide, however little was read
});

test("a book not read whole bounds nothing: no figure, where a level not read could be scoring", () => {
  const top2: Book = { bids: [lv(48, 100), lv(47, 100)], asks: [lv(52, 100), lv(53, 100)], depth: 2 };
  assert.equal(mostOthersScore(s, top2, 100), null);
  assert.equal(mostOthersScore(s, { bids: [lv(48, 100), lv(47, 100)], asks: [lv(52, 100)], depth: 2 }, 100), null); // one side cut off is enough
  const whole: Book = { bids: [lv(48, 100)], asks: [lv(52, 100)], depth: 2 };                // fewer levels than were asked for: the whole book
  assert.equal(mostOthersScore(s, whole, 100), 50);
  assert.equal(leastShare(s, { bid: lv(45, 100), ask: lv(55, 100) }, top2), null);
});

test("the least share of a pair: all of an empty pool, less where others rest nearer the midpoint", () => {
  const pair = { bid: lv(45, 100), ask: lv(55, 100) };
  assert.equal(leastShare(s, pair, { bids: [lv(40, 10)], asks: [lv(60, 10)] }), 1);
  const crowded: Book = { bids: [lv(48, 100)], asks: [lv(52, 100)] };
  const mine = 2 * (100 / 5 ** 2), theirs = 2 * (100 / 2 ** 2);
  assert.equal(leastShare(s, pair, crowded), mine / (mine + theirs));
});

test("a pool's share of one minute is its day over 1,440, rounded down to a millionth", () => {
  assert.equal(minuteShareMicros(250_000_000), 173_611);
  assert.equal(minuteShareMicros(260_000_000), 180_555); // 180,555.55 is rounded down, not to the nearest
});

// Plan 1.3-B: our score, the others across a pool, shares in a pool, and the whole-pool test.

const pair100 = { bid: lv(45, 100), ask: lv(55, 100) };

test("our score: a pair at the midpoint the book would have with it in, the dearer bid and the cheaper ask", () => {
  assert.equal(ourScore(s, pair100, { bidCents: 44, askCents: 56 }), 8); // five cents each side: 100 / 25 twice
  assert.equal(ourScore(s, pair100, { bidCents: 46, askCents: 54 }), 8); // inside ours: the midpoint is 46 + 54, the same 50
  assert.equal(ourScore(s, pair100, { bidCents: null, askCents: 56 }), 8); // a missing side takes the pair's own price
  assert.equal(ourScore(s, { bid: lv(45, 99), ask: lv(55, 100) }, { bidCents: 44, askCents: 56 }), 0); // under the least size
});

test("our score is nothing where the others' best prices touch or cross our pair: it would be filled (audit 1, finding 2)", () => {
  assert.equal(ourScore(s, pair100, { bidCents: 55, askCents: 60 }), 0);
  assert.equal(ourScore(s, pair100, { bidCents: 56, askCents: 60 }), 0);
  assert.equal(ourScore(s, pair100, { bidCents: 40, askCents: 45 }), 0);
  assert.equal(ourScore(s, pair100, { bidCents: 30, askCents: 44 }), 0);
  assert.equal(ourScore(s, pair100, { bidCents: 50, askCents: 50 }), 0); // a locked top inside the pair
  assert.equal(leastShare(s, pair100, { bids: [lv(56, 100)], asks: [lv(60, 100)] }), 0);
});

test("an event's unread count that is not a plain whole number is never read as none (audit 1, finding 4)", () => {
  const w = (unread: number): PoolEvent => ({ live: false, unread, contracts: [{ top: { bidCents: 40, askCents: 60 } }] });
  assert.equal(poolState(s, 1, [w(Number.NaN)]), "may");
  assert.equal(poolState(s, 1, [w(-1)]), "may");
  assert.equal(poolState(s, 1, [w(0.5)]), "may");
  assert.equal(poolState(s, 1, [w(0)]), "none-prices");
});

test("the least share is unchanged by being written on our score", () => {
  const book: Book = { bids: [lv(46, 300)], asks: [lv(54, 300)] }; // eight cents wide: others may qualify
  const mine = 8, others = 300 / 16 + 300 / 16; // four cents each side of 50
  assert.equal(leastShare(s, pair100, book), mine / (mine + others));
  assert.equal(leastShare(s, pair100, { bids: [lv(30, 500)], asks: [lv(70, 500)] }), 1);
});

test("the others across a pool: the sum of each book at its own midpoint; one book not read whole gives no figure", () => {
  const a: Book = { bids: [lv(48, 100)], asks: [lv(52, 100)] }; // two cents each side: 25 + 25
  const b: Book = { bids: [lv(45, 100)], asks: [lv(55, 100)] }; // five cents each side: 4 + 4
  assert.equal(mostOthersScore(s, a, 100), 50);
  assert.equal(mostOthersScore(s, b, 100), 8);
  assert.equal(poolOthersMost(s, [{ book: a }, { book: b }]), 58);
  assert.equal(poolOthersMost(s, [{ book: a }, { book: { bids: [lv(60, 100)], asks: [lv(62, 100)] } }]), 50 + 100 + 100); // its own midpoint, 61
  assert.equal(poolOthersMost(s, [{ book: a }, { book: { bids: [lv(48, 100)], asks: [] } }]), 50); // a side missing adds nothing
  assert.equal(poolOthersMost(s, [{ book: a }, { book: { bids: [lv(48, 100), lv(47, 100)], asks: [lv(52, 100), lv(53, 100)], depth: 2 } }]), null);
  assert.equal(poolOthersMost(s, []), 0);
});

test("the others in a book where our pair stands are scored at the midpoint our pair gives it (audit 1, finding 1)", () => {
  const book: Book = { bids: [lv(40, 100)], asks: [lv(48, 1000)] };
  const ours = { bid: lv(43, 100), ask: lv(50, 100) }; // with it in, the best prices are 43 and 48
  assert.equal(poolOthersMost(s, [{ book, pair: ours }]), mostOthersScore(s, book, 43 + 48));
  assert.ok(poolOthersMost(s, [{ book, pair: ours }])! > poolOthersMost(s, [{ book }])!);
  assert.equal(leastShare(s, ours, book), ourScore(s, ours, { bidCents: 40, askCents: 48 }) / (ourScore(s, ours, { bidCents: 40, askCents: 48 }) + poolOthersMost(s, [{ book, pair: ours }])!));
});

test("shares in a pool are worked out together: ours summed against the others, never each alone", () => {
  assert.deepEqual(sharesInPool([8, 8], 84), [0.08, 0.08]);
  assert.deepEqual(sharesInPool([8], 92), [0.08]);
  assert.deepEqual(sharesInPool([0, 0], 10), [0, 0]);
  assert.deepEqual(sharesInPool([], 10), []);
  const [x, y] = sharesInPool([8, 8], 84);
  assert.ok(x + y < 2 * (8 / (8 + 84))); // each alone against the others would overstate the two together
});

const wide = (): PoolEvent => ({ live: false, unread: 0, contracts: [{ top: { bidCents: 40, askCents: 60 } }] });
const narrow = (book?: Book): PoolEvent => ({ live: false, unread: 0, contracts: [{ top: { bidCents: 45, askCents: 55 }, ...(book ? { book } : {}) }] });

test("the whole pool: nobody can qualify only when that holds for every event of it, all of them listed", () => {
  assert.equal(poolState(s, 3, [wide(), wide(), wide()]), "none-prices");
  assert.equal(poolState(s, 3, [wide(), wide(), narrow({ bids: [lv(45, 50)], asks: [lv(55, 500)] })]), "none-sizes");
  assert.equal(poolState(s, 3, [wide(), wide(), narrow({ bids: [lv(45, 100)], asks: [lv(55, 100)] })]), "may");
  assert.equal(poolState(s, 3, [wide(), wide(), narrow()]), "may"); // narrow and not read
});

test("the whole pool is 'may' when an event is missing from the list, live, unread in part, or has no contract", () => {
  assert.equal(poolState(s, 4, [wide(), wide(), wide()]), "may");
  assert.equal(poolState(s, 2, [wide(), wide(), wide()]), "may");
  assert.equal(poolState(s, 3, [wide(), wide(), { ...wide(), live: true }]), "may");
  assert.equal(poolState(s, 3, [wide(), wide(), { ...wide(), unread: 1 }]), "may");
  assert.equal(poolState(s, 3, [wide(), wide(), { live: false, unread: 0, contracts: [] }]), "may");
  assert.equal(poolState(s, 0, []), "may");
});
