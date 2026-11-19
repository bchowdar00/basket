// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readSettings, type Top } from "@app/score";
import { decide, priceTests, readRule, tiedUpMicros, worstLossMicros, type ContractIn, type EventIn, type Read, type Rule } from "../src/index.ts";
import { ruleHash } from "../src/hash.ts";

const s = readSettings({ min_size_threshold: 100, max_spread_cents: 10, spread_penalty_exponent: 2, min_spread_floor: "0.001", min_payout_threshold_usd: 1 });
const rule: Rule = readRule(JSON.parse(readFileSync(new URL("../../../settings/rule.json", import.meta.url), "utf8")));
const MIN = 60_000, HOUR = 60 * MIN, NOW = 1_800_000_000_000;
const top = (bidCents: number | null, askCents: number | null): Top => ({ bidCents, askCents });
const lv = (cents: number) => ({ cents, qty: 100 });

/** A log read every five minutes for `hours`, ending now; `at(minutesAgo)` gives the best prices then. */
function log(hours: number, at: (minutesAgo: number) => Top): Read[] {
  const reads: Read[] = [];
  for (let ago = hours * 60; ago >= 0; ago -= 5) reads.push({ atMs: NOW - ago * MIN, top: at(ago) });
  return reads;
}
/** Others quote 44 to 56; one side stepped a cent three hours ago, so the quote is tended. */
const tended = (ago: number) => (ago > 180 ? top(43, 56) : top(44, 56));
const good = (symbol = "A-1", over: Partial<ContractIn> = {}): ContractIn => ({ symbol, stepCents: 1, log: log(26, tended), ...over });
const event = (over: Partial<EventIn> = {}): EventIn => ({ ticker: "EV-1", startMs: NOW + 30 * HOUR, live: false, poolMicrosADay: 250_000_000, makersLastDay: 0, volume: 0, contracts: [good()], ...over });
const nothingHeld = () => ({ filled: new Set<string>(), tiedUpMicros: 0, quoted: new Set<string>() });
const one = (e: EventIn) => decide(rule, s, [e], nothingHeld(), NOW);

test("the settings file holds exactly the thirteen figures that are ours", () => {
  assert.deepEqual(rule, {
    maxOthersSpreadCents: 15, tendedWithinMs: 24 * HOUR, stillCents: 3, stillOverMs: HOUR, pullBeforeStartMs: 6 * HOUR,
    capPerMarketMicros: 60_000_000, drawMicros: 7_500_000_000, bondMicros: 5_000_000_000, reachedMarginCents: 1, readEveryMs: 5 * MIN,
    sweepsADay: 4, sweepApartMs: 1_200, noSizeBeforeMs: Date.UTC(2026, 10, 17, 6, 0, 0),
  });
});

test("the hub's limits on the sweep: more than four a day, or books less than 1.2 seconds apart, are refused", () => {
  assert.throws(() => readRule({ ...rule, sweepsADay: 5 }), /sweepsADay/);
  assert.equal(readRule({ ...rule, sweepsADay: 1 }).sweepsADay, 1);
  assert.throws(() => readRule({ ...rule, sweepApartMs: 1_199 }), /sweepApartMs/);
  assert.equal(readRule({ ...rule, sweepApartMs: 2_000 }).sweepApartMs, 2_000);
  assert.throws(() => readRule({ ...rule, noSizeBeforeMs: 1 }), /noSizeBeforeMs/); // the hub's instant is the earliest (audit 1, finding 4)
  assert.throws(() => readRule({ ...rule, noSizeBeforeMs: Date.UTC(2026, 10, 17, 5, 59, 59) }), /noSizeBeforeMs/);
  assert.equal(readRule({ ...rule, noSizeBeforeMs: Date.UTC(2026, 10, 18) }).noSizeBeforeMs, Date.UTC(2026, 10, 18));
  const { noSizeBeforeMs: _gone, ...missing } = rule;
  assert.throws(() => readRule(missing), /noSizeBeforeMs/);
});

test("a settings file with a figure missing, a figure too many or a figure that is not positive is refused", () => {
  const { stillCents: _gone, ...missing } = rule;
  assert.throws(() => readRule(missing), /stillCents/);
  assert.throws(() => readRule({ ...rule, extra: 1 }), /extra/);
  assert.throws(() => readRule({ ...rule, drawMicros: 0 }), /drawMicros/);
  assert.throws(() => readRule({ ...rule, readEveryMs: "300000" }), /readEveryMs/);
  assert.throws(() => readRule({ ...rule, stillCents: 2.5 }), /stillCents/);
  assert.throws(() => readRule([rule]), /not an object/);
});

test("a draw of more than twice the bond is refused; exactly twice is not", () => {
  assert.throws(() => readRule({ ...rule, drawMicros: 10_000_000_001 }), /twice the bond/);
  assert.equal(readRule({ ...rule, drawMicros: 10_000_000_000 }).drawMicros, 10_000_000_000);
});

test("a contract whose four price tests pass may be quoted", () => {
  assert.equal(priceTests(rule, good(), NOW), "quote");
});

test("two sides: a side missing now, or in any read of the last hour, stops the quote", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago === 0 ? top(44, null) : tended(ago))) }), NOW), "one-sided");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago === 35 ? top(null, 56) : tended(ago))) }), NOW), "one-sided");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago === 65 ? top(null, 56) : tended(ago))) }), NOW), "quote");
});

test("a crossed answer in the last hour counts as a side missing", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago === 20 ? top(56, 44) : tended(ago))) }), NOW), "one-sided");
});

test("a log that does not reach back an hour, or holds one read in it, is too short to quote on", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, tended).filter((r) => r.atMs > NOW - 55 * MIN) }), NOW), "short-log");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, tended).filter((r) => r.atMs === NOW || r.atMs < NOW - 61 * MIN) }), NOW), "short-log");
  assert.equal(priceTests(rule, good("A-1", { log: [] }), NOW), "short-log");
});

test("a log whose last read is more than two reads old says nothing about now", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, tended).filter((r) => r.atMs <= NOW - 15 * MIN) }), NOW), "short-log");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, tended).filter((r) => r.atMs <= NOW - 10 * MIN) }), NOW), "quote");
});

test("a hole of more than two reads inside the hour makes the log too short; one missed read does not", () => {
  const without = (from: number, to: number) => log(26, tended).filter((r) => r.atMs < NOW - to * MIN || r.atMs > NOW - from * MIN);
  assert.equal(priceTests(rule, good("A-1", { log: without(15, 25) }), NOW), "short-log");   // reads at 30 and 10 minutes ago: twenty apart
  assert.equal(priceTests(rule, good("A-1", { log: without(15, 15) }), NOW), "quote");       // reads at 20 and 10: ten apart is one missed read
  assert.equal(priceTests(rule, good("A-1", { log: without(120, 150) }), NOW), "quote");     // a hole before the hour is no matter
});

test("tended: a quote nobody has changed in twenty-four hours stops the quote; a change twenty-three hours ago does not", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, () => top(44, 56)) }), NOW), "untended");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 25 * 60 ? top(43, 56) : top(44, 56))) }), NOW), "untended");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 23 * 60 ? top(43, 56) : top(44, 56))) }), NOW), "quote");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 24 * 60 ? top(43, 56) : top(44, 56))) }), NOW), "quote");
});

test("tended: a log shorter than a day that shows no change cannot show the quote is tended", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(3, () => top(44, 56)) }), NOW), "untended");
});

test("still: a midpoint that moved three cents inside the hour stops the quote; two and a half does not", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 30 ? top(41, 53) : top(44, 56))) }), NOW), "moving");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 30 ? top(42, 53) : top(44, 56))) }), NOW), "quote");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 90 ? top(38, 50) : top(44, 56))) }), NOW), "quote");
});

test("narrow enough: other people's spread of sixteen cents stops the quote; fifteen does not", () => {
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 180 ? top(41, 58) : top(42, 58))) }), NOW), "too-wide");
  assert.equal(priceTests(rule, good("A-1", { log: log(26, (ago) => (ago > 180 ? top(42, 58) : top(43, 58))) }), NOW), "quote");
});

test("a pair ties up its bid and the other side of its ask; its worst loss is the larger of the two", () => {
  assert.equal(tiedUpMicros({ bid: lv(45), ask: lv(55) }), 90_000_000);
  assert.equal(tiedUpMicros({ bid: lv(46), ask: lv(55) }), 91_000_000);
  assert.equal(worstLossMicros({ bid: lv(45), ask: lv(55) }), 45_000_000);
  assert.equal(worstLossMicros({ bid: lv(60), ask: lv(70) }), 60_000_000);
  assert.equal(worstLossMicros({ bid: lv(30), ask: lv(40) }), 60_000_000);
});

test("an acceptable event is quoted with the widest pair around other people's midpoint", () => {
  assert.deepEqual(one(event()), [{ event: "EV-1", symbol: "A-1", pair: { bid: lv(45), ask: lv(55) }, reason: "quote" }]);
});

test("the loss cap: a pair that can lose sixty dollars is quoted, one that can lose sixty-one is not", () => {
  const at = (bid: number, ask: number) => (ago: number) => (ago > 180 ? top(bid - 1, ask) : top(bid, ask));
  assert.equal(one(event({ contracts: [good("A-1", { log: log(26, at(59, 71)) })] }))[0].reason, "quote");          // pair 60 to 70
  assert.equal(one(event({ contracts: [good("A-1", { log: log(26, at(60, 72)) })] }))[0].reason, "outside-cap");    // pair 61 to 71
  assert.equal(one(event({ contracts: [good("A-1", { log: log(26, at(28, 40)) })] }))[0].reason, "outside-cap");    // pair 29 to 39: the ask can lose 61
});

test("an event with no pool, with a maker on the last scored day, in play, or inside six hours of its start is not quoted", () => {
  assert.deepEqual(one(event({ poolMicrosADay: null })), [{ event: "EV-1", symbol: null, pair: null, reason: "no-pool" }]);
  assert.equal(one(event({ poolMicrosADay: 0 }))[0].reason, "no-pool");
  assert.equal(one(event({ makersLastDay: 1 }))[0].reason, "makers-last-day");
  assert.equal(one(event({ live: true }))[0].reason, "live-or-pulled");
  assert.equal(one(event({ startMs: NOW + 6 * HOUR }))[0].reason, "live-or-pulled");
  assert.equal(one(event({ startMs: NOW + 6 * HOUR + MIN }))[0].reason, "quote");
});

test("a maker count the list does not give is read as none", () => {
  assert.equal(one(event({ makersLastDay: null }))[0].reason, "quote");
});

test("an event where somebody may be qualifying, in any of its contracts, is not quoted", () => {
  const narrow = good("A-2", { log: log(26, (ago) => (ago > 180 ? top(46, 53) : top(47, 53))) });
  assert.deepEqual(one(event({ contracts: [good(), narrow] })), [{ event: "EV-1", symbol: null, pair: null, reason: "others-may-qualify" }]);
});

test("a contract with no read at this pass proves nothing, so its event is not quoted", () => {
  const stale = good("A-2", { log: log(26, tended).filter((r) => r.atMs <= NOW - 15 * MIN) });
  assert.deepEqual(one(event({ contracts: [good(), stale] })), [{ event: "EV-1", symbol: null, pair: null, reason: "others-may-qualify" }]);
  assert.deepEqual(one(event({ contracts: [good(), good("A-2", { log: [] })] })), [{ event: "EV-1", symbol: null, pair: null, reason: "others-may-qualify" }]);
  assert.deepEqual(one(event({ contracts: [] })), [{ event: "EV-1", symbol: null, pair: null, reason: "others-may-qualify" }]);
});

test("money that is not enough for a dearer pair still goes to a cheaper one after it", () => {
  const dear = event({ ticker: "EV-D", poolMicrosADay: 500_000_000, contracts: [good("D-1", { log: log(26, (ago) => (ago > 180 ? top(44, 56) : top(45, 56))) })] }); // pair 46 to 55 ties up 91
  const cheap = event({ ticker: "EV-C", poolMicrosADay: 25_000_000, contracts: [good("C-1")] });                                                                    // pair 45 to 55 ties up 90
  const got = decide({ ...rule, drawMicros: 90_000_000 }, s, [dear, cheap], nothingHeld(), NOW);
  assert.deepEqual(got.map((d) => [d.event, d.reason, d.pair === null]), [["EV-D", "no-money", true], ["EV-C", "quote", false]]);
});

test("a narrow contract whose book was read and is thin does not stop the event; the pair then sits behind", () => {
  const thin = { bids: [{ cents: 47, qty: 20 }], asks: [{ cents: 53, qty: 20 }] };
  const narrow = good("A-2", { log: log(26, (ago) => (ago > 180 ? top(46, 53) : top(47, 53))), book: thin });
  const got = one(event({ contracts: [narrow] }));
  assert.deepEqual(got, [{ event: "EV-1", symbol: "A-2", pair: { bid: lv(45), ask: lv(55) }, reason: "quote" }]);
});

test("one contract an event: of two that pass, the one nearest fifty cents is quoted", () => {
  const far = good("A-2", { log: log(26, (ago) => (ago > 180 ? top(53, 66) : top(54, 66))) });   // midpoint 60
  const got = one(event({ contracts: [far, good("A-1")] }));
  assert.deepEqual(got.map((d) => [d.symbol, d.reason]), [["A-2", "not-nearest"], ["A-1", "quote"]]);
});

test("of two contracts as near to fifty cents as each other, the first listed is quoted", () => {
  const low = good("A-1", { log: log(26, (ago) => (ago > 180 ? top(38, 51) : top(39, 51))) });    // midpoint 45
  const high = good("A-2", { log: log(26, (ago) => (ago > 180 ? top(48, 61) : top(49, 61))) });   // midpoint 55
  assert.deepEqual(one(event({ contracts: [low, high] })).map((d) => [d.symbol, d.reason]), [["A-1", "quote"], ["A-2", "not-nearest"]]);
  assert.deepEqual(one(event({ contracts: [high, low] })).map((d) => [d.symbol, d.reason]), [["A-2", "quote"], ["A-1", "not-nearest"]]);
});

test("an event with a filled contract is not quoted again, in any contract", () => {
  const held = { ...nothingHeld(), filled: new Set(["A-1"]) };
  const got = decide(rule, s, [event({ contracts: [good("A-1"), good("A-2")] })], held, NOW);
  assert.deepEqual(got, [{ event: "EV-1", symbol: null, pair: null, reason: "filled" }]);
});

test("each contract of an event that cannot be quoted carries its own reason", () => {
  const wide = good("A-2", { log: log(26, (ago) => (ago > 180 ? top(30, 50) : top(31, 50))) });
  const still = good("A-3", { log: log(26, () => top(44, 56)) });
  const got = one(event({ contracts: [wide, still] }));
  assert.deepEqual(got.map((d) => [d.symbol, d.reason, d.pair]), [["A-2", "too-wide", null], ["A-3", "untended", null]]);
});

test("the money: at ninety dollars a pair, seven and a half thousand covers eighty-three events and the next has none", () => {
  const events = Array.from({ length: 85 }, (_, i) => event({ ticker: "EV-" + String(i).padStart(2, "0"), contracts: [good("C-" + i)] }));
  const got = decide(rule, s, events, nothingHeld(), NOW);
  assert.equal(got.filter((d) => d.reason === "quote").length, 83);
  assert.equal(got.filter((d) => d.reason === "no-money").length, 2);
  const backwards = decide(rule, s, [...events].reverse(), nothingHeld(), NOW);
  assert.deepEqual(backwards.filter((d) => d.reason === "no-money").map((d) => d.event).sort(), ["EV-83", "EV-84"]);
});

test("the money: what is tied up in filled positions is no longer there to quote with", () => {
  const events = Array.from({ length: 85 }, (_, i) => event({ ticker: "EV-" + String(i).padStart(2, "0"), contracts: [good("C-" + i)] }));
  const got = decide(rule, s, events, { ...nothingHeld(), tiedUpMicros: 450_000_000 }, NOW);
  assert.equal(got.filter((d) => d.reason === "quote").length, 78);
});

test("the money goes to the larger pool first, then to the event with more hours left", () => {
  const small = event({ ticker: "EV-S", poolMicrosADay: 25_000_000, contracts: [good("S-1")] });
  const big = event({ ticker: "EV-B", poolMicrosADay: 500_000_000, contracts: [good("B-1")] });
  const later = event({ ticker: "EV-L", poolMicrosADay: 500_000_000, startMs: NOW + 50 * HOUR, contracts: [good("L-1")] });
  const two = decide({ ...rule, drawMicros: 180_000_000 }, s, [small, big, later], nothingHeld(), NOW);
  assert.deepEqual(two.map((d) => [d.event, d.reason]), [["EV-S", "no-money"], ["EV-B", "quote"], ["EV-L", "quote"]]);
  const oneOnly = decide({ ...rule, drawMicros: 90_000_000 }, s, [small, big, later], nothingHeld(), NOW);
  assert.deepEqual(oneOnly.map((d) => [d.event, d.reason]), [["EV-S", "no-money"], ["EV-B", "no-money"], ["EV-L", "quote"]]);
});

test("an event quoted at the last read keeps its place ahead of a larger pool", () => {
  const small = event({ ticker: "EV-S", poolMicrosADay: 25_000_000, contracts: [good("S-1")] });
  const big = event({ ticker: "EV-B", poolMicrosADay: 500_000_000, contracts: [good("B-1")] });
  const tight: Rule = { ...rule, drawMicros: 90_000_000 };
  const got = decide(tight, s, [small, big], { ...nothingHeld(), quoted: new Set(["EV-S"]) }, NOW);
  assert.deepEqual(got.map((d) => [d.event, d.reason]), [["EV-S", "quote"], ["EV-B", "no-money"]]);
});

test("the rule's hash changes with one settings figure and with one file, and not with the order the files are given in", () => {
  const files = [{ path: "packages/score/src/index.ts", sha256: "aa" }, { path: "packages/rule/src/index.ts", sha256: "bb" }];
  const base = ruleHash('{"stillCents":3}', files);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(ruleHash('{"stillCents":3}', [...files].reverse()), base);
  assert.notEqual(ruleHash('{"stillCents":4}', files), base);
  assert.notEqual(ruleHash('{"stillCents":3}', [files[0], { ...files[1], sha256: "bc" }]), base);
  assert.notEqual(ruleHash('{"stillCents":3}', [files[0]]), base);
});
