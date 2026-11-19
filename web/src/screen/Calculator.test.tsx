// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { S, T0, ev, pools, row } from "../fixtures.ts";
import { screenOf, type PoolView, type ScreenIn } from "../pools.ts";
import { GEMINI_TEXT } from "../words.ts";
import { Calculator } from "./Calculator.tsx";
import type { ListedEvent } from "../../../services/engine/src/gemini.ts";

// react-dom/server escapes & < > " ' in text; undo those so phrase assertions read plainly.
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function poolOf(events: ListedEvent[], rows = events.map((e) => row(e.ticker, 1, events.length, { poolMicrosADay: 144_000_000 }))): PoolView {
  const input: ScreenIn = { settings: S, pools: pools(rows), events, eventsAtMs: T0, passes: [] };
  return screenOf(input, T0).sport[0];
}

function steps(events: ListedEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) for (const c of e.contracts) m.set(c.symbol, c.stepCents);
  return m;
}

function render(pool: PoolView, evs: ListedEvent[], qty = 100, spreadCents = 10): string {
  return decode(renderToStaticMarkup(
    <Calculator settings={S} pool={pool} steps={steps(evs)} qty={qty} spreadCents={spreadCents} onQty={() => {}} onSpread={() => {}} />,
  ));
}

const ASSUMPTION = "Assumes each order is paid for in full when placed. Gemini's margin rules were not read.";

test("the four figures read with the fixture's own numbers, the minute carries Gemini's text, the least is not yet known", () => {
  const evs = [ev("A", [[40, 44], [null, 9]], { ticker: "A" })];
  const rows = [row("A", 1, 1, { poolMicrosADay: 144_000_000, makers: 5 })];
  const html = render(poolOf(evs, rows), evs);
  expect(html).toContain("5 qualifying makers counted by the list on its last scored day");
  expect(html).toContain("Contracts quoted: 1 of 2");
  expect(html).toContain("Money tied up: $90.00");
  expect(html).toContain("Worst loss: $53.00");
  expect(html).toContain("The pool's minute: $0.1000");
  expect(html).not.toContain(GEMINI_TEXT); // the screen's footnote carries it
  expect(html).toContain("Least share: not known until this pool's books are read");
  expect(html.split(ASSUMPTION).length - 1).toBe(1); // present exactly once
});

test("a null price shows a dash and its row can rest no pair", () => {
  const evs = [ev("A", [[40, 44], [null, 9]])];
  const html = render(poolOf(evs), evs);
  expect(html).toContain("—"); // the null bid
  expect(html).toContain("no pair can rest here");
});

test("a pool whose every event is in play has nothing to quote and shows no figures", () => {
  const evs = [ev("A", [[40, 44]], { live: true })];
  const html = render(poolOf(evs), evs);
  expect(html).toContain("Nothing to quote in this pool in this read");
  expect(html).not.toContain("Contracts quoted");
});

test("the contracts of an in-play event are left out of the count", () => {
  const evs = [ev("A", [[40, 44]]), ev("D", [[40, 44]], { live: true })];
  const html = render(poolOf(evs), evs);
  expect(html).toContain("Contracts quoted: 1 of 1"); // A-0 only; D-0 is in play
  expect(html).not.toContain("D-0");
});

test("more than twelve contracts show twelve rows and a line for the rest", () => {
  const tops = Array.from({ length: 14 }, () => [40, 44] as [number, number]);
  const evs = [ev("A", tops)];
  const html = render(poolOf(evs), evs);
  expect((html.match(/data-row/g) ?? []).length).toBe(12);
  expect(html).toContain("2 more contracts");
});
