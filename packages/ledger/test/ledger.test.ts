// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readRule, type Rule } from "@app/rule";
import { readSettings, sharesInPool, type Pair, type PoolEvent, type Top } from "@app/score";
import {
  dayRewardMicros, rewardByShareMicros, rewardByTextMicros, fillAt, geminiDay, markMicros, minuteMarks, minutesCounted, passRow, poolCount, row, samePair, sweepFor, volumeSays,
  type Credit, type Fill, type Seen, type Standing, type Sweep,
} from "../src/index.ts";
import { chain } from "../src/chain.ts";

const s = readSettings({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 });
const rule: Rule = readRule(JSON.parse(readFileSync(new URL("../../../settings/rule.json", import.meta.url), "utf8")));
const SEC = 1_000, MIN = 60 * SEC, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 16, 15, 0, 0); // on a minute mark
const top = (bidCents: number | null, askCents: number | null): Top => ({ bidCents, askCents });
const pair: Pair = { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 100 } };
const standing: Standing = { event: "EV-1", symbol: "A-1", pair, sinceMs: T0 };
const seen = (t: Top, eventVolume: number | null = 10, atMs = T0 + 5 * MIN): Seen => ({ atMs, top: t, eventVolume });
const before = seen(top(44, 56), 10, T0);
const fill = (side: Fill["side"], by: Fill["by"] = "reached"): Fill => ({ event: "EV-1", symbol: "A-1", atMs: T0 + 5 * MIN, by, side, qty: 100 });
const USD = 1_000_000;

test("reached: other people's best ask within a cent of the bid, or lower, fills the bid", () => {
  assert.deepEqual(fillAt(rule, standing, before, seen(top(40, 46))), fill("bid"));
  assert.deepEqual(fillAt(rule, standing, before, seen(top(40, 44))), fill("bid"));
  assert.equal(fillAt(rule, standing, before, seen(top(40, 47))), null);
});

test("reached: other people's best bid within a cent of the ask, or higher, fills the ask", () => {
  assert.deepEqual(fillAt(rule, standing, before, seen(top(54, 60))), fill("ask"));
  assert.deepEqual(fillAt(rule, standing, before, seen(top(56, 60))), fill("ask"));
  assert.equal(fillAt(rule, standing, before, seen(top(53, 60))), null);
});

test("reached: the margin is the rule's figure", () => {
  assert.deepEqual(fillAt({ ...rule, reachedMarginCents: 2 }, standing, before, seen(top(40, 47))), fill("bid"));
  assert.deepEqual(fillAt({ ...rule, reachedMarginCents: 2 }, standing, before, seen(top(53, 60))), fill("ask"));
});

test("reached: a side that is missing reaches nothing, and the side that is there still can", () => {
  assert.equal(fillAt(rule, standing, before, seen(top(null, null))), null);
  assert.equal(fillAt(rule, standing, before, seen(top(44, null))), null);
  assert.deepEqual(fillAt(rule, standing, before, seen(top(null, 46))), fill("bid"));
});

test("reached: an answer in which both sides are reached is the worse of the two", () => {
  assert.deepEqual(fillAt(rule, standing, before, seen(top(54, 46))), fill("worse"));
});

test("traded: a rise in the event's volume fills one side, the worse one", () => {
  assert.deepEqual(fillAt(rule, standing, before, seen(top(44, 56), 11)), fill("worse", "traded"));
});

test("traded: no rise, a fall and a missing volume fill nothing", () => {
  assert.equal(fillAt(rule, standing, before, seen(top(44, 56), 10)), null);
  assert.equal(fillAt(rule, standing, before, seen(top(44, 56), 9)), null);
  assert.equal(fillAt(rule, standing, before, seen(top(44, 56), null)), null);
  assert.equal(fillAt(rule, standing, { ...before, eventVolume: null }, seen(top(44, 56), 11)), null);
});

test("a fall or a missing volume says nothing; it is not a level volume", () => {
  assert.equal(volumeSays(before, seen(top(44, 56), 11)), "rose");
  assert.equal(volumeSays(before, seen(top(44, 56), 10)), "level");
  assert.equal(volumeSays(before, seen(top(44, 56), 9)), "nothing");
  assert.equal(volumeSays(before, seen(top(44, 56), null)), "nothing");
  assert.equal(volumeSays({ ...before, eventVolume: null }, seen(top(44, 56), 11)), "nothing");
  assert.equal(volumeSays({ ...before, eventVolume: 0 }, seen(top(44, 56), null)), "nothing");
  assert.equal(volumeSays({ ...before, eventVolume: 0 }, seen(top(44, 56), 0)), "level");
});

test("a price that reached one side while the volume rose: both rules apply, and the fill is the worse side", () => {
  assert.deepEqual(fillAt(rule, standing, before, seen(top(40, 46), 25)), fill("worse", "traded"));
  assert.deepEqual(fillAt(rule, standing, before, seen(top(54, 60), 25)), fill("worse", "traded"));
  assert.deepEqual(fillAt(rule, standing, before, seen(top(54, 46), 25)), fill("worse", "traded"));
});

test("a fill whose side is not known is of the larger of the two sizes", () => {
  const uneven: Standing = { ...standing, pair: { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 300 } } };
  assert.equal(fillAt(rule, uneven, before, seen(top(44, 56), 11))!.qty, 300);
  assert.equal(fillAt(rule, uneven, before, seen(top(40, 46)))!.qty, 100);
  assert.equal(fillAt(rule, uneven, before, seen(top(54, 60)))!.qty, 300);
});

test("a fill is counted across a gap of three hours between reads", () => {
  const late = T0 + 3 * HOUR;
  assert.deepEqual(fillAt(rule, standing, before, seen(top(40, 46), 10, late)), { ...fill("bid"), atMs: late });
  assert.deepEqual(fillAt(rule, standing, before, seen(top(44, 56), 11, late)), { ...fill("worse", "traded"), atMs: late });
});

test("marking a filled bid: held to the result where there is one", () => {
  assert.equal(markMicros(fill("bid"), pair, { result: 0, last: top(44, 56) }), -45 * USD);
  assert.equal(markMicros(fill("bid"), pair, { result: 1, last: top(44, 56) }), 55 * USD);
});

test("marking a filled bid with no result: what it could be sold for, and nothing where nobody bids", () => {
  assert.equal(markMicros(fill("bid"), pair, { result: null, last: top(40, 60) }), -5 * USD);   // the midpoint would say +5
  assert.equal(markMicros(fill("bid"), pair, { result: null, last: top(null, 60) }), -45 * USD);
});

test("marking a filled ask: held to the result, else what it could be bought back for, and the whole dollar where nobody offers", () => {
  assert.equal(markMicros(fill("ask"), pair, { result: 1, last: top(44, 56) }), -45 * USD);
  assert.equal(markMicros(fill("ask"), pair, { result: 0, last: top(44, 56) }), 55 * USD);
  assert.equal(markMicros(fill("ask"), pair, { result: null, last: top(40, 60) }), -5 * USD);
  assert.equal(markMicros(fill("ask"), pair, { result: null, last: top(40, null) }), -45 * USD);
});

test("marking a fill whose side is not known takes the worse of the two", () => {
  assert.equal(markMicros(fill("worse", "traded"), pair, { result: 1, last: top(44, 56) }), -45 * USD);
  assert.equal(markMicros(fill("worse", "traded"), pair, { result: 0, last: top(44, 56) }), -45 * USD);
  assert.equal(markMicros(fill("worse", "traded"), pair, { result: null, last: top(44, 70) }), -15 * USD);
  assert.equal(markMicros(fill("worse", "traded"), pair, { result: null, last: top(30, 56) }), -15 * USD);
});

test("a last read that is crossed or locked is no price: nothing for a long, the whole dollar for a short", () => {
  assert.equal(markMicros(fill("bid"), pair, { result: null, last: top(70, 30) }), -45 * USD);
  assert.equal(markMicros(fill("ask"), pair, { result: null, last: top(70, 30) }), -45 * USD);
  assert.equal(markMicros(fill("worse", "traded"), pair, { result: null, last: top(70, 30) }), -45 * USD);
  assert.equal(markMicros(fill("bid"), pair, { result: null, last: top(50, 50) }), -45 * USD);
  assert.equal(markMicros(fill("ask"), pair, { result: null, last: top(50, 50) }), -45 * USD);
  assert.equal(markMicros(fill("bid"), pair, { result: 1, last: top(70, 30) }), 55 * USD);   // a result does not need the last read
});

test("marking uses each side's own price and size", () => {
  const uneven: Pair = { bid: { cents: 40, qty: 200 }, ask: { cents: 49, qty: 300 } };
  assert.equal(markMicros(fill("bid"), uneven, { result: 0, last: top(null, null) }), -80 * USD);
  assert.equal(markMicros(fill("ask"), uneven, { result: 1, last: top(null, null) }), -153 * USD);
  assert.equal(markMicros(fill("worse"), uneven, { result: 1, last: top(null, null) }), -153 * USD);
});

const at = (atMs: number, quoted = true, alone = true) => ({ atMs, quoted, alone });

test("minutes: two reads five minutes apart, quoted and alone at both, count five", () => {
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 5 * MIN)), 5);
});

test("minutes: what is counted is the minute marks between the two reads", () => {
  assert.equal(minutesCounted(rule, at(T0 + 10 * SEC), at(T0 + 5 * MIN + 5 * SEC)), 5);
  assert.equal(minutesCounted(rule, at(T0 + 10 * SEC), at(T0 + 4 * MIN + 58 * SEC)), 4);
  assert.equal(minutesCounted(rule, at(T0 + 59 * SEC), at(T0 + 61 * SEC)), 1);
  assert.equal(minutesCounted(rule, at(T0 + SEC), at(T0 + 59 * SEC)), 0);
});

test("minutes: a read up to a minute late still counts, and never more than five", () => {
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 6 * MIN)), 5);
  assert.equal(minutesCounted(rule, at(T0 + 30 * SEC), at(T0 + 6 * MIN + 30 * SEC)), 5);
});

test("minutes: a longer gap counts nothing", () => {
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 6 * MIN + 1)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 10 * MIN)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 11 * MIN)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 3 * HOUR)), 0);
});

test("minutes: quoted at one end only, or not alone at either end, counts nothing", () => {
  assert.equal(minutesCounted(rule, at(T0, false), at(T0 + 5 * MIN)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 5 * MIN, false)), 0);
  assert.equal(minutesCounted(rule, at(T0, true, false), at(T0 + 5 * MIN)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(T0 + 5 * MIN, true, false)), 0);
});

test("minutes: reads out of order, at the same moment or with no time count nothing", () => {
  assert.equal(minutesCounted(rule, at(T0 + 5 * MIN), at(T0)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(T0)), 0);
  assert.equal(minutesCounted(rule, at(Number.NaN), at(T0)), 0);
  assert.equal(minutesCounted(rule, at(T0), at(Number.NaN)), 0);
});

test("the same quote is the same two prices and sizes; no quote is never the same quote", () => {
  assert.equal(samePair(pair, { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 100 } }), true);
  assert.equal(samePair(pair, { bid: { cents: 46, qty: 100 }, ask: { cents: 55, qty: 100 } }), false);
  assert.equal(samePair(pair, { bid: { cents: 45, qty: 100 }, ask: { cents: 54, qty: 100 } }), false);
  assert.equal(samePair(pair, { bid: { cents: 45, qty: 200 }, ask: { cents: 55, qty: 100 } }), false);
  assert.equal(samePair(pair, { bid: { cents: 45, qty: 100 }, ask: { cents: 55, qty: 200 } }), false);
  assert.equal(samePair(pair, null), false);
  assert.equal(samePair(null, null), false);
});

test("reward: the day's sum is rounded down to the cent, not each minute", () => {
  assert.equal(dayRewardMicros(s, 250 * USD, 1_080, 0), 187_500_000);
  assert.equal(dayRewardMicros(s, 250 * USD, 7, 0), 1_210_000);        // 1.2152...
});

test("reward: a maker on the next day's list makes the day nothing, and so does a list not yet seen", () => {
  assert.equal(dayRewardMicros(s, 250 * USD, 1_080, 1), 0);
  assert.equal(dayRewardMicros(s, 250 * USD, 1_080, null), 0);
  assert.equal(dayRewardMicros(s, 250 * USD, 1_080, 0), 187_500_000);
  assert.equal(rewardByTextMicros(s, 250 * USD, 1_080), 187_500_000);
  assert.equal(rewardByTextMicros(s, 250 * USD, 5), 0);
});

test("reward: a pool or a maker count that is not a plain figure is refused", () => {
  assert.throws(() => dayRewardMicros(s, Number.NaN, 5, 0), /pool/);
  assert.throws(() => dayRewardMicros(s, Number.POSITIVE_INFINITY, 5, 0), /pool/);
  assert.throws(() => dayRewardMicros(s, -1, 5, 0), /pool/);
  assert.throws(() => dayRewardMicros(s, 250 * USD, 5, -1), /maker count/);
  assert.throws(() => dayRewardMicros(s, 250 * USD, 5, Number.NaN), /maker count/);
  assert.throws(() => dayRewardMicros(s, 250 * USD, 5, 1.5), /maker count/);
});

test("reward: under the least payout the day is nothing; exactly the least payout is paid", () => {
  assert.equal(dayRewardMicros(s, 250 * USD, 5, 0), 0);                // 86 cents
  assert.equal(dayRewardMicros(s, 288 * USD, 5, 0), 1 * USD);
  assert.equal(dayRewardMicros({ ...s, minPayoutMicros: 2 * USD }, 250 * USD, 7, 0), 0);
});

test("reward: a day has at most 1,440 snapshots, and no minutes is nothing", () => {
  assert.equal(dayRewardMicros(s, 250 * USD, 1_440, 0), 250 * USD);
  assert.equal(dayRewardMicros(s, 250 * USD, 1_500, 0), 250 * USD);
  assert.equal(dayRewardMicros(s, 250 * USD, 0, 0), 0);
});

test("reward: minutes that are not a whole number of none or more are refused", () => {
  assert.throws(() => dayRewardMicros(s, 250 * USD, -1, 0), /minutes/);
  assert.throws(() => dayRewardMicros(s, 250 * USD, 2.5, 0), /minutes/);
});

const HASH = "ab".repeat(32);
const whole = (minutes: number): Credit[] => [{ minutes, share: 1, kind: "least" }];
const quiet = { day: "2026-11-16", event: "EV-1", symbol: "A-1", pair, tiedUpMicros: 90 * USD, poolMicrosADay: 250 * USD, minutes: 1_080, makersNextList: 0 as number | null, fills: [] as Fill[], mark: null, credits: whole(1_080), unsweptMinutes: 0, ruleHash: HASH };

test("a row with no fill: the reward, half of it, and the losing fills it would cover", () => {
  assert.deepEqual(row(s, quiet), {
    kind: "market", ruleHash: HASH,
    day: "2026-11-16", event: "EV-1", symbol: "A-1", tiedUpMicros: 90 * USD, minutes: 1_080,
    leastMinutes: 1_080, estimateMinutes: 0, unsweptMinutes: 0,
    rewardMicros: 187_500_000, halfRewardMicros: 93_750_000, fills: [], markMicros: 0,
    netMicros: 187_500_000, netAtHalfMicros: 93_750_000, losingFillsCovered: 4,
    rewardProvisional: false, rewardWaitingMicros: 0, markAtLastRead: false,
    readingOne: { micros: 187_500_000, waitingMicros: 0 },
  });
});

test("a row with a lost fill: the net at both rewards, also when it is negative", () => {
  const lost = row(s, { ...quiet, fills: [fill("bid")], mark: { result: 0, last: top(44, 56) } });
  assert.equal(lost.markMicros, -45 * USD);
  assert.equal(lost.netMicros, 142_500_000);
  assert.equal(lost.netAtHalfMicros, 48_750_000);
  const short = row(s, { ...quiet, minutes: 7, credits: whole(7), fills: [fill("bid")], mark: { result: 0, last: top(44, 56) } });
  assert.equal(short.rewardMicros, 1_210_000);
  assert.equal(short.halfRewardMicros, 605_000);
  assert.equal(short.netMicros, -43_790_000);
  assert.equal(short.netAtHalfMicros, -44_395_000);
  assert.equal(short.losingFillsCovered, 0);
});

test("a row whose next list shows a maker has no reward and covers no fill", () => {
  const claimed = row(s, { ...quiet, makersNextList: 2, fills: [fill("ask")], mark: { result: 1, last: top(44, 56) } });
  assert.deepEqual([claimed.rewardMicros, claimed.halfRewardMicros, claimed.losingFillsCovered, claimed.netMicros, claimed.netAtHalfMicros], [0, 0, 0, -45 * USD, -45 * USD]);
});

test("a row says when its reward waits for the next list and when its mark is at the last read", () => {
  const waiting = row(s, { ...quiet, makersNextList: null, fills: [fill("bid")], mark: { result: 0, last: top(44, 56) } });
  assert.deepEqual([waiting.rewardProvisional, waiting.rewardMicros, waiting.halfRewardMicros, waiting.rewardWaitingMicros, waiting.losingFillsCovered], [true, 0, 0, 187_500_000, 0]);
  assert.deepEqual([waiting.netMicros, waiting.netAtHalfMicros], [-45 * USD, -45 * USD]);
  assert.equal(row(s, { ...quiet, makersNextList: 3 }).rewardWaitingMicros, 0);
  const marked = row(s, { ...quiet, fills: [fill("bid")], mark: { result: null, last: top(40, 60) } });
  assert.equal(marked.markAtLastRead, true);
  assert.equal(marked.markMicros, -5 * USD);
  assert.equal(row(s, { ...quiet, fills: [fill("bid")], mark: { result: 1, last: top(40, 60) } }).markAtLastRead, false);
});

test("the losing fills covered are counted against the pair's worst loss", () => {
  const lopsided: Pair = { bid: { cents: 60, qty: 100 }, ask: { cents: 70, qty: 100 } };   // can lose 60
  assert.equal(row(s, { ...quiet, pair: lopsided }).losingFillsCovered, 3);
  const fifty: Pair = { bid: { cents: 50, qty: 100 }, ask: { cents: 60, qty: 100 } };      // can lose 50: 187.50 covers three, not four
  assert.equal(row(s, { ...quiet, pair: fifty }).losingFillsCovered, 3);
});

test("a pair that can lose nothing covers no fill", () => {
  const nothing: Pair = { bid: { cents: 45, qty: 0 }, ask: { cents: 55, qty: 0 } };
  assert.equal(row(s, { ...quiet, pair: nothing }).losingFillsCovered, 0);
});

test("a row with a fill and no mark is refused", () => {
  assert.throws(() => row(s, { ...quiet, fills: [fill("bid")], mark: null }), /mark/);
});

const day = (iso: string) => geminiDay(Date.parse(iso));

test("the exchange's day turns at 5:00:00 pm Eastern and is named for the date it ends on", () => {
  assert.equal(day("2026-11-14T21:59:59Z"), "2026-11-14");   // 4:59:59 pm, standard time
  assert.equal(day("2026-11-14T22:00:00Z"), "2026-11-15");
  assert.equal(day("2026-11-15T05:00:00Z"), "2026-11-15");   // midnight Eastern is inside the same day
  assert.equal(day("2026-11-15T21:59:59Z"), "2026-11-15");
});

test("the day turns at 5 pm Eastern on both sides of the clock change in the autumn", () => {
  assert.equal(day("2026-10-31T20:59:59Z"), "2026-10-31");   // 4:59:59 pm, daylight time
  assert.equal(day("2026-10-31T21:00:00Z"), "2026-11-01");
  assert.equal(day("2026-11-01T21:59:59Z"), "2026-11-01");   // 4:59:59 pm, standard time: this day had 25 hours
  assert.equal(day("2026-11-01T22:00:00Z"), "2026-11-02");
});

test("the day turns at 5 pm Eastern on both sides of the clock change in the spring", () => {
  assert.equal(day("2027-03-13T21:59:59Z"), "2027-03-13");
  assert.equal(day("2027-03-13T22:00:00Z"), "2027-03-14");
  assert.equal(day("2027-03-14T20:59:59Z"), "2027-03-14");   // this day had 23 hours
  assert.equal(day("2027-03-14T21:00:00Z"), "2027-03-15");
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("the chain is SHA-256 over the previous hash and then the row", () => {
  const a = sha("a"), b = sha("b");
  assert.equal(chain(a, '{"n":1}'), sha(a + '{"n":1}'));
  assert.match(chain(a, '{"n":1}'), /^[0-9a-f]{64}$/);
  assert.notEqual(chain(b, '{"n":1}'), chain(a, '{"n":1}'));
  assert.notEqual(chain(a, '{"n":2}'), chain(a, '{"n":1}'));
});

test("the chain refuses a previous hash that is not one", () => {
  assert.throws(() => chain("abc", "{}"), /previous hash/);
  assert.throws(() => chain(sha("a").toUpperCase(), "{}"), /previous hash/);
  assert.throws(() => chain(sha("a"), undefined as unknown as string), /row/);
  assert.throws(() => chain(sha("a"), ""), /row/);
});

// Plan 1.3-C: the reward column (least at a sweep, an estimate between), and the program's record.

const AT = (h: number, m = 0) => Date.UTC(2026, 10, 17, h, m, 0);

test("minute marks: the marks the counted minutes are, the last ones when a read's worth caps them", () => {
  const q = (atMs: number) => ({ atMs, quoted: true, alone: true });
  assert.deepEqual(minuteMarks(rule, q(AT(6, 0) + 30 * SEC), q(AT(6, 5) + 30 * SEC)), [AT(6, 1), AT(6, 2), AT(6, 3), AT(6, 4), AT(6, 5)]);
  assert.deepEqual(minuteMarks(rule, q(AT(6, 0)), q(AT(6, 6))), [AT(6, 2), AT(6, 3), AT(6, 4), AT(6, 5), AT(6, 6)]);
  assert.deepEqual(minuteMarks(rule, q(AT(6, 0)), { ...q(AT(6, 5)), alone: false }), []);
  assert.equal(minutesCounted(rule, q(AT(6, 0)), q(AT(6, 6))), 5);
});

const sw = (atMs: number, othersMost: number | null): Sweep => ({ atMs, othersMost });

test("a minute takes the nearest sweep with a figure: least within one read of it, an estimate further off", () => {
  const sweeps = [sw(AT(6), 92), sw(AT(12), 40)];
  assert.deepEqual(sweepFor(rule, sweeps, AT(6, 4)), { othersMost: 92, kind: "least" });
  assert.deepEqual(sweepFor(rule, sweeps, AT(5, 56)), { othersMost: 92, kind: "least" });
  assert.deepEqual(sweepFor(rule, sweeps, AT(6, 6)), { othersMost: 92, kind: "estimate" });
  assert.deepEqual(sweepFor(rule, sweeps, AT(8)), { othersMost: 92, kind: "estimate" });
  assert.deepEqual(sweepFor(rule, sweeps, AT(10)), { othersMost: 40, kind: "estimate" });
  assert.deepEqual(sweepFor(rule, sweeps, AT(9)), { othersMost: 92, kind: "estimate" }); // a tie goes to the earlier
});

test("a sweep with no figure for the pool is passed over; with no figure anywhere the minute is unswept", () => {
  assert.deepEqual(sweepFor(rule, [sw(AT(6), 92), sw(AT(8), null)], AT(8, 1)), { othersMost: 92, kind: "estimate" });
  assert.equal(sweepFor(rule, [sw(AT(6), null)], AT(6, 1)), null);
  assert.equal(sweepFor(rule, [], AT(6, 1)), null);
});

test("the reward by share: the pool over 1,440 times minutes times share, down to the cent once", () => {
  assert.equal(rewardByShareMicros(s, 250 * USD, [{ minutes: 300, share: 0.08, kind: "least" }]), 4_160_000); // 4.1666...
  assert.equal(rewardByShareMicros(s, 250 * USD, [{ minutes: 150, share: 0.08, kind: "least" }, { minutes: 150, share: 0.08, kind: "estimate" }]), 4_160_000);
  for (const m of [0, 7, 1_080, 1_440, 1_500]) assert.equal(rewardByShareMicros(s, 250 * USD, whole(m)), rewardByTextMicros(s, 250 * USD, m));
  assert.equal(rewardByShareMicros(s, 250 * USD, [{ minutes: 7, share: 0.08, kind: "least" }]), 0); // under the least payout
  assert.throws(() => rewardByShareMicros(s, 250 * USD, [{ minutes: 7, share: 1.5, kind: "least" }]), /share/);
  assert.throws(() => rewardByShareMicros(s, 250 * USD, [{ minutes: 7, share: Number.NaN, kind: "least" }]), /share/);
  assert.throws(() => rewardByShareMicros(s, 250 * USD, [{ minutes: 2.5, share: 1, kind: "least" }]), /minutes/);
});

test("a row's minutes are least, estimate or unswept; its reward is the share column, and design 1.0's reading stands apart", () => {
  const credits: Credit[] = [{ minutes: 5, share: 0.5, kind: "least" }, { minutes: 10, share: 0.5, kind: "estimate" }];
  const r = row(s, { ...quiet, minutes: 18, credits, unsweptMinutes: 3 });
  assert.deepEqual([r.minutes, r.leastMinutes, r.estimateMinutes, r.unsweptMinutes], [18, 5, 10, 3]);
  assert.equal(r.rewardMicros, 1_300_000); // 250 x 7.5 / 1,440 = 1.302...
  assert.deepEqual(r.readingOne, { micros: 3_120_000, waitingMicros: 0 }); // 250 x 18 / 1,440 = 3.125
  assert.equal(r.netMicros, 1_300_000); // the reading of design 1.0 is in neither net
  assert.equal(r.netAtHalfMicros, 650_000);
  const waiting = row(s, { ...quiet, minutes: 18, credits, unsweptMinutes: 3, makersNextList: null });
  assert.deepEqual([waiting.rewardMicros, waiting.rewardWaitingMicros, waiting.readingOne.micros, waiting.readingOne.waitingMicros], [0, 1_300_000, 0, 3_120_000]);
  const claimed = row(s, { ...quiet, minutes: 18, credits, unsweptMinutes: 3, makersNextList: 1 });
  assert.deepEqual([claimed.rewardMicros, claimed.readingOne.micros], [0, 0]);
});

test("a row whose minutes are not its credited and unswept minutes, or whose rule hash is not one, is refused", () => {
  assert.throws(() => row(s, { ...quiet, minutes: 18, credits: whole(15), unsweptMinutes: 2 }), /minutes/);
  assert.throws(() => row(s, { ...quiet, ruleHash: "abc" }), /hash/);
});

test("two of our quotes in one pool share the minute together, below what each alone would claim", () => {
  const [a, b] = sharesInPool([8, 8], 84);
  const together = [a, b].map((share) => rewardByShareMicros(s, 250 * USD, [{ minutes: 1_000, share, kind: "least" }]));
  const alone = rewardByShareMicros(s, 250 * USD, [{ minutes: 1_000, share: 8 / (8 + 84), kind: "least" }]);
  assert.deepEqual(together, [13_880_000, 13_880_000]); // 250 x 80 / 1,440 = 13.888...
  assert.ok(together[0] + together[1] < 2 * alone);
});

const wideEv = (): PoolEvent => ({ live: false, unread: 0, contracts: [{ top: top(40, 60) }] });
const narrowEv = (): PoolEvent => ({ live: false, unread: 0, contracts: [{ top: top(45, 55) }] });

test("a pool's count: each event once, as live, unread, none from prices, none from sizes or may", () => {
  const thin = { live: false, unread: 0, contracts: [{ top: top(45, 55), book: { bids: [{ cents: 45, qty: 50 }], asks: [{ cents: 55, qty: 500 }] } }] };
  const events: PoolEvent[] = [wideEv(), { ...wideEv(), unread: 1 }, { ...wideEv(), live: true }, narrowEv(), thin, { live: false, unread: 0, contracts: [] }];
  assert.deepEqual(poolCount(s, "id:82", 6, events), { pool: "id:82", eventCount: 6, listed: 6, live: 1, unread: 2, nonePrices: 1, noneSizes: 1, may: 1, state: "may" });
  assert.equal(poolCount(s, "id:82", 3, [wideEv(), wideEv(), wideEv()]).state, "none-prices");
  assert.equal(poolCount(s, "id:82", 4, [wideEv(), wideEv(), wideEv()]).state, "may"); // one event the pool counts is not on the list
});

test("a pass row holds each pool's count and the volumes; it chains with the market rows", () => {
  const p = passRow(s, { atMs: AT(6, 0), ruleHash: HASH, pools: [{ pool: "id:82", eventCount: 3, events: [wideEv(), wideEv(), narrowEv()] }], volume: { rose: 1, level: 2, nothing: 0 } });
  assert.deepEqual(p, {
    kind: "pass", atMs: AT(6, 0), day: geminiDay(AT(6, 0)), ruleHash: HASH,
    pools: [{ pool: "id:82", eventCount: 3, listed: 3, live: 0, unread: 0, nonePrices: 2, noneSizes: 0, may: 1, state: "may" }],
    volume: { rose: 1, level: 2, nothing: 0 },
  });
  const start = createHash("sha256").update("start").digest("hex");
  const h1 = chain(start, JSON.stringify(p));
  const h2 = chain(h1, JSON.stringify(row(s, quiet)));
  assert.notEqual(h1, start);
  assert.notEqual(h2, h1);
  assert.throws(() => passRow(s, { atMs: AT(6, 0), ruleHash: "nothex", pools: [], volume: { rose: 0, level: 0, nothing: 0 } }), /hash/);
  assert.throws(() => passRow(s, { atMs: AT(6, 0), ruleHash: HASH, pools: [], volume: { rose: -1, level: 0, nothing: 0 } }), /volume/);
});

test("bad inputs are refused, never read as a figure (audit 1, finding 4)", () => {
  assert.throws(() => sweepFor(rule, [sw(Number.NaN, 92)], AT(6)), /sweep/);
  assert.throws(() => rewardByShareMicros(s, 250 * USD, [{ minutes: 7, share: 1, kind: "other" as "least" }]), /kind/);
  assert.throws(() => row(s, { ...quiet, minutes: 7, credits: [{ minutes: 7, share: 1, kind: "other" as "least" }] }), /kind/);
  const nan: PoolEvent = { live: false, unread: Number.NaN, contracts: [{ top: top(40, 60) }] };
  const c = poolCount(s, "id:1", 1, [nan]);
  assert.deepEqual([c.unread, c.nonePrices, c.state], [1, 0, "may"]);
});
