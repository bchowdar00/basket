// Every value this file makes is invented. None is a reading of any market.
//
// Invented markets for the public demo of the operator's screen: reward pools, their events, the
// contracts' books and the reward amounts, all made up here so that anyone can try the screen
// without anything being asked of an exchange. They are made from the minute alone: every visitor
// sees the same markets in the same minute, and they move a little at each one-minute snapshot.
// The settings are invented too (they are the test fixtures' values). Only the scoring rule that
// works on them is real: it is the engine's own, in `packages/score`.
import type { Book, Level, Settings } from "@app/score";
import type { ListedEvent, PoolRow } from "../../../services/engine/src/gemini.ts";
import type { ScreenIn } from "../pools.ts";

export const SIM_SETTINGS: Settings = { minSize: 100, maxSpreadCents: 10, exponent: 2, floorCents: 0.1, minPayoutMicros: 1_000_000 };

export type SimRead = { events: ListedEvent[]; books: Map<string, Book>; atMs: number };
export type Sim = { input: ScreenIn & { source: "sim" }; read: Map<string, SimRead> };

/** A whole number from a string, the same on every machine. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A number from 0 up to 1 for a name: the same name always gives the same number. */
const unit = (name: string): number => hash(name) / 4294967296;
const pick = <T>(name: string, from: readonly T[]): T => from[Math.floor(unit(name) * from.length)];
const between = (name: string, lo: number, hi: number): number => lo + Math.floor(unit(name) * (hi - lo + 1));

const TOWNS = ["Harbor City", "Pinewood", "Saltmarsh", "Copper Hill", "Larkspur", "Eastgate", "Juniper Bay", "Stonebridge", "Fallow Creek", "Marrow Point", "Quillhaven", "Ashby Falls", "Tern Island", "Bellwether", "Greywater", "Summit Ridge"];
const NAMES = ["Gulls", "Foxes", "Herons", "Miners", "Larks", "Wardens", "Otters", "Masons", "Harriers", "Pilots", "Scribes", "Kestrels", "Terns", "Shepherds", "Pikes", "Rams"];
const team = (i: number): string => TOWNS[i % TOWNS.length] + " " + NAMES[i % NAMES.length];

/** The invented pools: a name, a category, how its events read, and how crowded it is. `crowd` 0 is
 * a pool nobody quotes inside the allowed spread; 3 is one with deep books close to the middle. */
type Kind = "game" | "season" | "award";
const POOLS: { name: string; category: string; kind: Kind; events: number; crowd: 0 | 1 | 2 | 3; usdADay: number }[] = [
  { name: "Coastal League, this week", category: "Invented Football", kind: "game", events: 5, crowd: 3, usdADay: 90 },
  { name: "Coastal League champion", category: "Invented Football", kind: "season", events: 1, crowd: 2, usdADay: 60 },
  { name: "Coastal League total wins", category: "Invented Football", kind: "season", events: 4, crowd: 1, usdADay: 35 },
  { name: "Upland Cup, round two", category: "Invented Football", kind: "game", events: 4, crowd: 2, usdADay: 45 },
  { name: "Harbor Series, tonight", category: "Invented Basketball", kind: "game", events: 6, crowd: 3, usdADay: 75 },
  { name: "Harbor Series most valuable player", category: "Invented Basketball", kind: "award", events: 1, crowd: 1, usdADay: 25 },
  { name: "Harbor Series coach of the year", category: "Invented Basketball", kind: "award", events: 1, crowd: 0, usdADay: 3 },
  { name: "Lowland Division winner", category: "Invented Basketball", kind: "season", events: 1, crowd: 2, usdADay: 30 },
  { name: "Tidewater Open, round of sixteen", category: "Invented Tennis", kind: "game", events: 8, crowd: 2, usdADay: 40 },
  { name: "Tidewater Open winner", category: "Invented Tennis", kind: "season", events: 1, crowd: 1, usdADay: 28 },
  { name: "Ridge Rally stage winners", category: "Invented Motor Racing", kind: "game", events: 3, crowd: 0, usdADay: 4 },
  { name: "Ridge Rally champion", category: "Invented Motor Racing", kind: "season", events: 1, crowd: 1, usdADay: 18 },
  { name: "Greywater Derby", category: "Invented Rowing", kind: "game", events: 2, crowd: 0, usdADay: 2 },
  { name: "Northern Ice League, this week", category: "Invented Hockey", kind: "game", events: 5, crowd: 2, usdADay: 55 },
  { name: "Northern Ice League points leader", category: "Invented Hockey", kind: "award", events: 1, crowd: 0, usdADay: 2 },
  { name: "Northern Ice League total wins", category: "Invented Hockey", kind: "season", events: 3, crowd: 1, usdADay: 24 },
  { name: "Summit Marathon podium", category: "Invented Athletics", kind: "award", events: 2, crowd: 1, usdADay: 16 },
  { name: "Quillhaven Chess Classic", category: "Invented Chess", kind: "game", events: 4, crowd: 1, usdADay: 14 },
];

const DAY = 24 * 3_600_000;

/** One side of a book, best price first: `levels` prices a cent or more apart, moving away from the
 * middle, with sizes that are larger where a pool is crowded. */
function side(name: string, bestCents: number, away: -1 | 1, levels: number, crowd: number): Level[] {
  const out: Level[] = [];
  let cents = bestCents;
  for (let i = 0; i < levels; i++) {
    if (cents < 1 || cents > 99) break;
    const qty = between(name + ":q" + i, 20, 400) * (1 + crowd * 2) + (i === 0 ? crowd * 150 : 0);
    out.push({ cents, qty });
    cents += away * between(name + ":s" + i, 1, crowd >= 2 ? 1 : 3);
  }
  return out;
}

/** A contract's book in a minute. The middle wanders slowly on two waves, and the sizes are remade
 * each minute, so a snapshot differs a little from the one before and a lot from one an hour on. */
function bookOf(symbol: string, crowd: 0 | 1 | 2 | 3, minute: number): Book {
  const base = between(symbol + ":mid", 8, 92);
  const wander = 6 * Math.sin(minute / between(symbol + ":w1", 17, 41) + unit(symbol + ":p1") * 6.28) + 3 * Math.sin(minute / between(symbol + ":w2", 5, 11) + unit(symbol + ":p2") * 6.28);
  const mid = Math.min(96, Math.max(4, Math.round(base + wander)));
  // Half the distance between the best prices: a cent in a crowded pool, wider than a maker may
  // quote (so nobody can be qualifying) in an empty one.
  const half = crowd === 3 ? 1 : crowd === 2 ? between(symbol + ":h" + (minute % 7), 1, 2) : crowd === 1 ? between(symbol + ":h" + (minute % 5), 2, 5) : between(symbol + ":h", 7, 14);
  const bid = Math.max(1, mid - half);
  const ask = Math.min(99, mid + half);
  const m = ":" + minute;
  return {
    bids: side(symbol + ":b" + m, bid, -1, between(symbol + ":bl", 3, 7), crowd),
    asks: side(symbol + ":a" + m, ask, 1, between(symbol + ":al", 3, 7), crowd),
  };
}

/** The invented markets as they stand in the minute `nowMs` falls in. */
export function simAt(nowMs: number): Sim {
  const minute = Math.floor(nowMs / 60_000);
  const atMs = minute * 60_000;
  const dayStart = Math.floor(nowMs / DAY) * DAY;
  const rows: PoolRow[] = [];
  const read = new Map<string, SimRead>();
  const all: ListedEvent[] = [];

  POOLS.forEach((p, pi) => {
    const poolKey = "id:" + (pi + 1);
    const events: ListedEvent[] = [];
    const books = new Map<string, Book>();
    for (let ei = 0; ei < p.events; ei++) {
      // A ticker that can be read: the pool's initials, its number, the event's number.
      const ticker = p.name.split(/[^A-Za-z]+/).filter((w) => w !== "").map((w) => w[0].toUpperCase()).join("") + (pi + 1) + "." + (ei + 1);
      const ai = pi * 3 + ei * 2, bi = pi * 3 + ei * 2 + 5;
      const a = team(ai), b = team(bi);
      const title = p.kind === "game" ? a + " at " + b : p.kind === "season" ? (p.events === 1 ? p.name : a + ": " + p.name) : p.name + (p.events === 1 ? "" : ", race " + (ei + 1));
      // A game has one contract for each side; a season or an award has a few named runners.
      const n = p.kind === "game" ? 2 : between(ticker + ":n", 2, 4);
      const contracts = Array.from({ length: n }, (_, ci) => {
        const symbol = ticker + "-" + (p.kind === "game" ? NAMES[(ci === 0 ? ai : bi) % NAMES.length].slice(0, 3).toUpperCase() : "R" + (ci + 1));
        const book = bookOf(symbol, p.crowd, minute);
        books.set(symbol, book);
        return { symbol, stepCents: 1, top: { bidCents: book.bids[0]?.cents ?? null, askCents: book.asks[0]?.cents ?? null } };
      });
      // One game in the busiest pools is in play for an hour in every six: it is shown and not quoted.
      const live = p.kind === "game" && p.crowd === 3 && ei === 0 && Math.floor(minute / 60) % 6 === pi % 6;
      const event: ListedEvent = { ticker, title, category: p.category, subcategory: null, startMs: live ? atMs - 20 * 60_000 : dayStart + (1 + ((pi + ei) % 6)) * DAY + 19 * 3_600_000, live, volume: between(ticker + ":v", 50, 9_000), contracts, unread: [] };
      events.push(event);
      rows.push({
        ticker, title, category: p.category, poolMicrosADay: p.usdADay * 1_000_000, source: "invented", endsAtMs: null,
        makers: p.crowd === 0 ? 0 : between(ticker + ":m", 1, 2) + p.crowd, poolId: pi + 1, poolEventCount: p.events, poolName: p.name, poolKey, raw: {},
      });
    }
    all.push(...events);
    read.set(poolKey, { events, books, atMs });
  });

  return {
    input: {
      source: "sim", settings: SIM_SETTINGS,
      pools: { lastScoreDate: new Date(dayStart - DAY).toISOString().slice(0, 10), total: rows.length, rows, twice: 0, moved: false },
      events: all, eventsAtMs: atMs, passes: [],
    },
    read,
  };
}
