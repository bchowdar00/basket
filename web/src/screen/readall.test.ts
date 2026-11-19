// Every value in this file is invented. None is a reading of any market.
import { describe, expect, it } from "vitest";
import { eventsToRead, poolsToRead, SKIP_CATEGORIES, type Readable } from "./readall.ts";

const p = (key: string, categories: string[], eventCount: number): Readable => ({ key, categories, count: { eventCount } });

// In the order the sport list would hold them: a sport pool, a crypto-only pool, a mixed pool, a
// second crypto-only pool, another sport pool.
const sport: Readable[] = [
  p("id:1", ["Baseball"], 2),
  p("id:2", ["Bitcoin"], 3),
  p("id:3", ["Ether", "Baseball"], 1),
  p("id:4", ["Solana"], 5),
  p("id:5", ["Hockey"], 4),
];

describe("poolsToRead", () => {
  it("keeps the sport list's order", () => {
    const out = poolsToRead(sport, new Set(), SKIP_CATEGORIES);
    expect(out.map((x) => x.key)).toEqual(["id:1", "id:3", "id:5"]);
  });

  it("skips pools already read", () => {
    const out = poolsToRead(sport, new Set(["id:1"]), SKIP_CATEGORIES);
    expect(out.map((x) => x.key)).toEqual(["id:3", "id:5"]);
  });

  it("skips a pool every category of which is a short-lived crypto market, but keeps a mixed one", () => {
    const out = poolsToRead(sport, new Set(), SKIP_CATEGORIES);
    expect(out.map((x) => x.key)).not.toContain("id:2");
    expect(out.map((x) => x.key)).not.toContain("id:4");
    expect(out.map((x) => x.key)).toContain("id:3"); // Ether and Baseball: not all crypto
  });

  it("keeps a pool with no category", () => {
    const out = poolsToRead([p("id:9", [], 1)], new Set(), SKIP_CATEGORIES);
    expect(out.map((x) => x.key)).toEqual(["id:9"]);
  });
});

describe("eventsToRead", () => {
  it("sums the event counts of the pools a run would read", () => {
    const out = poolsToRead(sport, new Set(), SKIP_CATEGORIES);
    expect(eventsToRead(out)).toBe(2 + 1 + 4); // id:1, id:3, id:5
  });
});
