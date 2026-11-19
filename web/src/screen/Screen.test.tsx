// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { S, T0, ev, pools, row } from "../fixtures.ts";
import { screenOf, type ScreenIn } from "../pools.ts";
import { GEMINI_TEXT } from "../words.ts";
import { Screen } from "./Screen.tsx";

// react-dom/server escapes & < > " ' in text; undo those so phrase assertions read plainly.
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function input(over: Partial<ScreenIn> = {}): ScreenIn {
  return {
    settings: S,
    pools: pools([
      row("A", 1, 2), row("B", 1, 2, { makers: 2 }),
      row("C", 2, 1, { poolMicrosADay: 100_000_000 }),
      row("D", 3, 1, { poolMicrosADay: 50_000_000 }),
      row("X", 9, 1, { category: "Bitcoin", poolMicrosADay: 1_000_000_000 }),
    ]),
    events: [ev("A", [[40, 60]]), ev("B", [[30, 50], [10, 90]]), ev("C", [[48, 52]]), ev("D", [[40, 60]], { live: true }), ev("Z", [[40, 60]])],
    eventsAtMs: T0 - 90_000,
    passes: [],
    ...over,
  };
}

// The calculator's and allocator's props, held fixed: these tests are about the screen's figures,
// table and panel, not those components' own numbers (which have their own test files). With no pool
// read, the allocator shows only its empty state.
const calc = { settings: S, steps: new Map<string, number>(), qty: S.minSize, spreadCents: S.maxSpreadCents, onQty: () => {}, onSpread: () => {} };
const alloc = { readPools: new Map(), budgetUsd: 1000, stance: "widest" as const, onBudget: () => {}, onStance: () => {} };

function render(over: Partial<ScreenIn> = {}, nowMs = T0, openKey: string | null = null): string {
  const screen = screenOf(input(over), nowMs);
  return decode(renderToStaticMarkup(<Screen screen={screen} nowMs={nowMs} openKey={openKey} onOpen={() => {}} changed={new Set()} {...calc} {...alloc} />));
}

test("the lead figures read with the fixture's own numbers", () => {
  const html = render();
  expect(html).toContain("4 pools, $1,450 a day in all, each counted once, by the list's own pool ids");
  expect(html).toContain("In 2 of 3 events read, the listed prices hold no qualifying pair at this read");
  expect(html).toContain("1 in play, not scored from the list");
});

// Decided 2026-11-19: one footnote, not the words beside every figure.
test("Gemini's text stands once on the screen, in the footnote at its foot", () => {
  const html = render();
  expect(html.split(GEMINI_TEXT).length - 1).toBe(1);
  expect(html).toContain("Every reward figure on this screen is " + GEMINI_TEXT + ".");
  expect(html.indexOf(GEMINI_TEXT)).toBeGreaterThan(html.lastIndexOf("</table>"));
});

test("the pool table has a makers column counted by the list", () => {
  const html = render();
  expect(html).toContain("makers");
  expect(html).toContain("counted by the list");
});

test("the removed maker sentence is gone", () => {
  const html = render();
  expect(html).not.toContain("no qualifying maker has been counted");
});

test("a pool nobody can be qualifying in from prices is listed before a may pool", () => {
  const html = render();
  expect(html.indexOf("Pool 1")).toBeGreaterThanOrEqual(0);
  expect(html.indexOf("Pool 1")).toBeLessThan(html.indexOf("Pool 2"));
});

test("a pool whose prices are over ten minutes old reads stale", () => {
  const html = render({}, T0 + 11 * 60_000);
  expect(html).toContain("stale");
});

test("an opened pool lists each contract, a dash where a price is null, and names a contract nobody can qualify in", () => {
  const over: Partial<ScreenIn> = {
    pools: pools([row("N", 7, 1)]),
    events: [ev("N", [[null, 55]])],
  };
  const screen = screenOf(input(over), T0);
  const html = decode(renderToStaticMarkup(<Screen screen={screen} nowMs={T0} openKey="id:7" onOpen={() => {}} changed={new Set()} {...calc} {...alloc} />));
  expect(html).toContain("—"); // a dash for the null bid
  expect(html).toContain("cannot hold a qualifying pair");
});

test("an opened pool shows a game in play as in play", () => {
  const screen = screenOf(input(), T0);
  const html = decode(renderToStaticMarkup(<Screen screen={screen} nowMs={T0} openKey="id:3" onOpen={() => {}} changed={new Set()} {...calc} {...alloc} />));
  expect(html).toContain("in play");
});

test("the week strip draws 168 cells", () => {
  const over: Partial<ScreenIn> = { pools: pools([row("P", 8, 1)]), events: [ev("P", [[40, 60]])] };
  const screen = screenOf(input(over), T0);
  const html = renderToStaticMarkup(<Screen screen={screen} nowMs={T0} openKey={null} onOpen={() => {}} changed={new Set()} {...calc} {...alloc} />);
  expect((html.match(/data-cell/g) ?? []).length).toBe(168);
});
