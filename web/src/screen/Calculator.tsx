// One pool's calculator (T11 on the screen): what a qualifying quote in each of the pool's
// contracts would take, and the least it would be credited, all from the `calc` library. Pure: it
// reads only its props. No book is read here, so `least` is always "not known yet"; the figures are
// a floor by the text of Gemini's rules, never a reading of any account. Every dollar figure is a
// reward figure, so each carries Gemini's text beside it.

import type { Book } from "@app/score";
import { calcPool, type CalcContract } from "../calc.ts";
import { dollars, dollarsFine, dollarsFineLeast, pctLeast, score } from "./format.ts";
import type { PoolView } from "../pools.ts";
import type { Settings } from "@app/score";

type Props = {
  extra?: CalcContract[]; // contracts the list could not price, known from their books alone
  unreadLeft?: number; // contracts of the pool neither the list nor a book has given; absent: judged from the events' states
  pending?: boolean; // the pool is being read from the exchange
  books?: ReadonlyMap<string, Book>; // books read whole for this pool's contracts, by symbol; absent where none was read
  settings: Settings;
  pool: PoolView;
  steps: ReadonlyMap<string, number>; // a contract's price step by symbol; a symbol not in it uses 1
  qty: number;
  spreadCents: number;
  onQty: (n: number) => void;
  onSpread: (n: number) => void;
};

const ASSUMPTION = "Assumes each order is paid for in full when placed. Gemini's margin rules were not read.";
const MAX_ROWS = 12;

function priceWords(cents: number | null): string {
  return cents === null ? "—" : cents + "¢";
}

export function Calculator({ settings, pool, steps, qty, spreadCents, onQty, onSpread, books, pending, extra, unreadLeft }: Props) {
  // The list's count of qualifying makers, largest across the pool's events (the pool is counted as
  // a whole; a disagreement between events never lowers it).
  const makers = pool.makers;
  const playable = pool.events.filter((e) => e.state !== "in-play");

  const head = (
    <header className="calc-head">
      <h3 className="calc-name">{pool.name}</h3>
      <p className="calc-makers">{makers + " qualifying makers counted by the list on its last scored day"}</p>
    </header>
  );

  if (pool.events.length === 0 || playable.length === 0) {
    return (
      <section className="calc" aria-label={"calculator for " + pool.name}>
        {head}
        <p className="calc-empty">{pending ? "Reading this pool's events and books from Gemini, 1.2 seconds a request\u2026" : pool.read ? "Nothing to quote in this pool in this read" : "This pool's events have not been read"}</p>
      </section>
    );
  }

  // Every contract of every event not in play, no book attached: `least` stays null until books are read.
  const contracts: CalcContract[] = playable.flatMap((e) =>
    e.contracts.map((c) => ({ symbol: c.symbol, top: c.top, stepCents: steps.get(c.symbol) ?? 1, ...(books?.has(c.symbol) ? { book: books.get(c.symbol)! } : {}) })),
  );
  // No floor is claimed for a pool not seen whole: an event the list did not give, one in play, or
  // one with a contract that could not be read may hold a maker's score.
  const noneUnread = unreadLeft !== undefined ? unreadLeft === 0 : pool.events.every((e) => e.state !== "unread");
  const whole = playable.length === pool.events.length && noneUnread && pool.count.listed === pool.count.eventCount;
  if (extra !== undefined) contracts.push(...extra);
  const calc = calcPool(settings, pool.microsADay, contracts, qty, spreadCents, whole);

  const shown = calc.rows.length > MAX_ROWS
    ? [...calc.rows].sort((a, b) => (b.quote?.score ?? 0) - (a.quote?.score ?? 0)).slice(0, MAX_ROWS)
    : calc.rows;
  const more = calc.rows.length - shown.length;

  return (
    <section className="calc" aria-label={"calculator for " + pool.name}>
      {head}

      <div className="calc-controls">
        <label className="calc-range">
          <span className="calc-range-label">Contracts a side</span>
          <input type="range" min={settings.minSize} max={settings.minSize * 20} step={settings.minSize} value={qty} onChange={(e) => onQty(Number(e.target.value))} />
          <span className="calc-range-value">{qty}</span>
        </label>
        <label className="calc-range">
          <span className="calc-range-label">Spread, cents</span>
          <input type="range" min={1} max={settings.maxSpreadCents} step={1} value={spreadCents} onChange={(e) => onSpread(Number(e.target.value))} />
          <span className="calc-range-value">{spreadCents}</span>
        </label>
      </div>

      <div className="calc-figures">
        <p className="calc-figure">{"Contracts quoted: " + calc.quoted + " of " + calc.rows.length}</p>
        <p className="calc-figure">{"Money tied up: $" + dollars(calc.tiedMicros)}</p>
        <p className="calc-figure">{"Worst loss: $" + dollars(calc.worstLossMicros)}</p>
        <p className="calc-figure">{"The pool's minute: $" + dollarsFine(calc.aloneMicrosAMinute)}</p>
      </div>
      <p className="calc-assumption">{ASSUMPTION}</p>
      <p className="calc-least">
        {calc.least === null
          ? (whole ? "Least share: not known until this pool's books are read" : "Least share: not known. Some of this pool's contracts could not be read, or an event of it is in play")
          : <>{"Least share: " + pctLeast(calc.least.share) + "%, at least $" + dollarsFineLeast(calc.least.microsAMinute) + " a minute"}<span className="calc-least-note">A floor when the books were read: every resting order is counted as another maker's score.</span></>}
      </p>

      <div className="calc-table-scroll">
        <table className="calc-rows">
          <thead>
            <tr>
              <th scope="col">contract</th>
              <th scope="col">best bid</th>
              <th scope="col">best ask</th>
              <th scope="col">our bid</th>
              <th scope="col">our ask</th>
              <th scope="col">score</th>
              <th scope="col">tied up</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.symbol} data-row="">
                <th scope="row" className="calc-sym">{r.symbol}</th>
                <td className="calc-px">{priceWords(r.top.bidCents)}</td>
                <td className="calc-px">{priceWords(r.top.askCents)}</td>
                {r.quote === null
                  ? <td className="calc-norest" colSpan={4}>no pair can rest here</td>
                  : (
                    <>
                      <td className="calc-px">{r.quote.pair.bid.cents}¢</td>
                      <td className="calc-px">{r.quote.pair.ask.cents}¢</td>
                      <td className="calc-score">{score(r.quote.score)}</td>
                      <td className="calc-tied">${dollars(r.quote.tiedMicros)}</td>
                    </>
                  )}
              </tr>
            ))}
          </tbody>
        </table>
        {more > 0 && <p className="calc-more">{more + " more contracts"}</p>}
      </div>
    </section>
  );
}
