// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { S, T0, ev, pools, row } from "../fixtures.ts";
import { screenOf, type PoolView, type ScreenIn } from "../pools.ts";
import { GEMINI_TEXT } from "../words.ts";
import { allocate, toAllocPool, type AllocPool, type ReadEvent, type Stance } from "../alloc.ts";
import { Allocator } from "./Allocator.tsx";
import type { Book } from "@app/score";
import type { ListedEvent } from "../../../services/engine/src/gemini.ts";

// react-dom/server escapes & < > " ' in text; undo those so phrase assertions read plainly.
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const USD = 1_000_000;
const ASSUMPTION = "Assumes each order is paid for in full when placed. Gemini's margin rules were not read.";

const book = (bid: [number, number] | null, ask: [number, number] | null): Book => ({
  bids: bid ? [{ cents: bid[0], qty: bid[1] }] : [],
  asks: ask ? [{ cents: ask[0], qty: ask[1] }] : [],
});

type Read = { events: ListedEvent[]; books: ReadonlyMap<string, Book> };

function sportOf(rows: ReturnType<typeof row>[], events: ListedEvent[]): PoolView[] {
  const input: ScreenIn = { settings: S, pools: pools(rows), events, eventsAtMs: T0, passes: [] };
  return screenOf(input, T0).sport;
}

function render(sport: PoolView[], readPools: ReadonlyMap<string, Read>, budgetUsd = 10_000, stance: Stance = "widest"): string {
  return decode(renderToStaticMarkup(
    <Allocator settings={S} sport={sport} readPools={readPools} budgetUsd={budgetUsd} stance={stance} onBudget={() => {}} onStance={() => {}} />,
  ));
}

// A pool with one contract whose book is twenty cents wide: no other maker can be qualifying in it,
// so one entry takes the whole pool. Mirrors the "takes it whole" case in alloc.test.ts.
const wholeRows = [row("C", 1, 1, { poolMicrosADay: 5 * USD })];
const wholeEvents = [ev("C", [[30, 50]])];
const wholeRead: ReadonlyMap<string, Read> = new Map([["id:1", { events: wholeEvents, books: new Map([["C-0", book([30, 10], [50, 10])]]) }]]);

test("the totals read with the fixture's own numbers", () => {
  const html = render(sportOf(wholeRows, wholeEvents), wholeRead, 10_000, "widest");
  expect(html).toContain("Money tied up: $90.00 of $10,000");
  expect(html).toContain("Worst loss: $55.00");
  expect(html).toContain("Least credit: $5.00 a day");
  expect(html).toContain("Pools quoted: 1 of 1 read (1 on the list, by the list's own pool ids)");
});

test("Gemini's text sits directly beside the least credit", () => {
  const html = render(sportOf(wholeRows, wholeEvents), wholeRead);
  expect(html).toContain("Least credit: $5.00 a day</p>");
  expect(html).not.toContain(GEMINI_TEXT); // the screen's footnote carries it
});

test("the assumption sentence appears exactly once", () => {
  const html = render(sportOf(wholeRows, wholeEvents), wholeRead);
  expect(html.split(ASSUMPTION).length - 1).toBe(1);
});

test("a quote row shows uneven sizes as '{qty} at {cents}¢'", () => {
  // A penny contract with a lot resting: the cheap bid side grows far past the ask side.
  const rows = [row("B", 2, 1, { poolMicrosADay: 20 * USD })];
  const evs = [ev("B", [[1, 3]])];
  const books = new Map([["B-0", book([1, 5_000], [3, 300])]]);
  const readPools: ReadonlyMap<string, Read> = new Map([["id:2", { events: evs, books }]]);
  const html = render(sportOf(rows, evs), readPools, 300, "join");

  const ok = toAllocPool(S, { key: "id:2", name: "Pool 2", microsADay: 20 * USD, eventCount: 1 },
    evs.map((e) => ({ live: e.live, contracts: e.contracts, unread: e.unread }) as ReadEvent), books) as AllocPool;
  const q = allocate(S, [ok], 300 * USD, "join").quotes[0];
  expect(q.pair.bid.qty).not.toBe(q.pair.ask.qty); // the sizes are uneven
  expect(html).toContain(q.pair.bid.qty.toLocaleString("en-US") + " at " + q.pair.bid.cents + "¢");
  expect(html).toContain(q.pair.ask.qty + " at " + q.pair.ask.cents + "¢");
});

test("more than twenty quotes show twenty rows and a line for the rest", () => {
  const rows: ReturnType<typeof row>[] = [];
  const evs: ListedEvent[] = [];
  const entries: [string, Read][] = [];
  for (let i = 0; i < 25; i++) {
    rows.push(row("C" + i, i + 1, 1, { poolMicrosADay: 5 * USD }));
    const e = ev("C" + i, [[30, 50]]);
    evs.push(e);
    entries.push(["id:" + (i + 1), { events: [e], books: new Map([["C" + i + "-0", book([30, 10], [50, 10])]]) }]);
  }
  const html = render(sportOf(rows, evs), new Map(entries), 100_000, "widest");
  expect((html.match(/data-quote/g) ?? []).length).toBe(20);
  expect(html).toContain("5 more quotes");
});

test("a refused pool appears under Left out with its reason", () => {
  const rows = [row("A", 1, 1, { poolMicrosADay: 10 * USD }), row("E", 2, 1, { poolMicrosADay: 10 * USD })];
  const evs = [ev("A", [[40, 44]]), ev("E", [[40, 44]])];
  const readPools: ReadonlyMap<string, Read> = new Map([
    ["id:1", { events: [evs[0]], books: new Map([["A-0", book([40, 200], [44, 200])]]) }],
    ["id:2", { events: [evs[1]], books: new Map() }], // read, but the book of E-0 is missing
  ]);
  const html = render(sportOf(rows, evs), readPools, 1_000, "join");
  expect(html).toContain("Left out");
  expect(html).toContain("Pool 2: the book of E-0 was not read");
});

test("pools not read are summarised in one line", () => {
  const rows = [row("A", 1, 1, { poolMicrosADay: 10 * USD }), row("B", 2, 1), row("C", 3, 1)];
  const evs = [ev("A", [[40, 44]]), ev("B", [[40, 44]]), ev("C", [[40, 44]])];
  const readPools: ReadonlyMap<string, Read> = new Map([["id:1", { events: [evs[0]], books: new Map([["A-0", book([40, 200], [44, 200])]]) }]]);
  const html = render(sportOf(rows, evs), readPools, 1_000, "join");
  expect(html).toContain("2 pools not read yet");
  expect(html).not.toContain("Pool 2: not read");
});

test("the empty state shows only the heading, the sentence and the prompt to read", () => {
  const rows = [row("A", 1, 1)];
  const evs = [ev("A", [[40, 44]])];
  const html = render(sportOf(rows, evs), new Map());
  expect(html).toContain("ALLOCATOR");
  expect(html).toContain("No pool has been read yet. Open a pool, or read every pool.");
  expect(html).not.toContain("Money tied up");
  expect(html).not.toContain(ASSUMPTION);
});

// Gemini's rules page (read 2026-11-18): a day's total under the least payment is not paid. The least payment arrives in the settings; none is typed here.
test("a least credit under the least payment carries the rule about it, and one at or over it does not", () => {
  const smallRows = [row("C", 1, 1, { poolMicrosADay: USD / 2 })];
  const small = render(sportOf(smallRows, wholeEvents), wholeRead);
  expect(small).toContain("Under Gemini's least payment of $1.00 a day: a day's total below it is not distributed.");
  expect(render(sportOf(wholeRows, wholeEvents), wholeRead)).not.toContain("Under Gemini's least payment");
});

// Audit of 2026-11-18, the screen, finding 2.
test("a budget over the box's ceiling, or not a number, is worked out at the ceiling or at nothing, and says so", () => {
  const huge = render(sportOf(wholeRows, wholeEvents), wholeRead, 1e12);
  expect(huge).toContain("Worked out for $1,000,000, the most this box takes.");
  expect(huge).toContain("of $1,000,000</p>");
  expect(render(sportOf(wholeRows, wholeEvents), wholeRead, Number.NaN)).toContain("Money tied up: $0.00 of $0.00");
});

test("the one page's short layout: the same figures, the next step, and the detail folded but present", () => {
  const html = decode(renderToStaticMarkup(
    <Allocator settings={S} sport={sportOf(wholeRows, wholeEvents)} readPools={wholeRead} budgetUsd={10_000} stance="widest" onBudget={() => {}} onStance={() => {}} compact nextHref="#fund" />,
  ));
  expect(html).toContain("<dt>Least credit</dt><dd>$5.00 <span>a day</span></dd>");
  expect(html).toContain("<dt>Money tied up</dt><dd>$90.00 <span>of $10,000</span></dd>");
  expect(html).toContain("<dt>Worst loss</dt><dd>$55.00</dd>");
  expect(html).toContain("by the list's own pool ids");
  expect(html).toContain('href="#fund"');
  expect(html).toContain("The 1 quote behind it");
  expect(html.split("<details").length).toBe(3);
  expect(html).toContain("A floor when the books were read, not a forecast");
  expect(html).not.toContain("ALLOCATOR");
});
