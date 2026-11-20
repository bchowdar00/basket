// The operator's screen, drawn from a `Screen` value. Pure: it reads only its props, so the same
// component renders on the server's recorded answers (the operator) and in a visitor's own browser.
// The look is the departure board (chosen 2026-11-17): the words and the figures; the ground,
// type and the one move are in the stylesheets. Every dollar figure here is a reward figure, so each
// carries Gemini's text beside it or in its column header; no figure is a reading of any account.

import type { ReactNode } from "react";
import { msToMark } from "../clock.ts";
import { NAME } from "../name.ts";
import { GEMINI_TEXT } from "../words.ts";
import type { Book } from "@app/score";
import { Allocator } from "./Allocator.tsx";
import { Calculator } from "./Calculator.tsx";
import type { CalcContract } from "../calc.ts";
import type { Stance } from "../alloc.ts";
import { dollars } from "./format.ts";
import type { EventView, PoolView, Screen as ScreenData, StripCell } from "../pools.ts";
import type { ListedEvent } from "../../../services/engine/src/gemini.ts";
import type { Settings, State } from "@app/score";

type Props = {
  books?: ReadonlyMap<string, Book>; // the opened pool's books, where the feed read them
  pending?: boolean; // the opened pool is being read from the exchange
  extra?: CalcContract[]; unreadLeft?: number; // see Calculator
  screen: ScreenData;
  nowMs: number;
  openKey: string | null;
  onOpen: (key: string) => void;
  changed: ReadonlySet<string>;
  settings: Settings;
  steps: ReadonlyMap<string, number>; // a contract's price step by symbol, for the calculator
  qty: number;
  spreadCents: number;
  onQty: (n: number) => void;
  onSpread: (n: number) => void;
  // The allocator's props (it leads the page, above the board).
  readPools: ReadonlyMap<string, { events: ListedEvent[]; books: ReadonlyMap<string, Book> }>;
  budgetUsd: number;
  stance: Stance;
  onBudget: (n: number) => void;
  onStance: (s: Stance) => void;
  controls?: ReactNode; // the read-every-pool controls, placed in the allocator's section header
  compact?: boolean; // the one page's short layout: one status line, the pool table folded
  nextHref?: string;
  sim?: boolean; // the markets are invented (the public demo): the snapshot line and the footnote say so
};

const STATE_WORDS: Record<State, string> = {
  "none-prices": "prices hold no qualifying pair",
  "none-sizes": "books too thin",
  may: "a maker may qualify",
};

const STALE_MS = 10 * 60_000;

function eventWords(s: EventView["state"]): string {
  if (s === "in-play") return "in play";
  if (s === "unread") return "unread";
  return STATE_WORDS[s];
}

function ageWords(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + "m " + (s < 10 ? "0" + s : s) + "s";
}

function priceWords(cents: number | null): string {
  return cents === null ? "—" : cents + "¢";
}

export function Screen({ screen, nowMs, openKey, onOpen, changed, settings, steps, qty, spreadCents, onQty, onSpread, books, pending, extra, unreadLeft, readPools, budgetUsd, stance, onBudget, onStance, controls, sim, compact, nextHref }: Props) {
  const { now, program } = screen;
  const seconds = Math.ceil(msToMark(nowMs) / 1_000);
  const open = openKey === null ? undefined : screen.sport.find((p) => p.key === openKey);

  const poolsBody = (
      <div className="body">
        <div className="table-scroll">
          <table className="pools">
            <thead>
              <tr>
                <th scope="col">pool</th>
                <th scope="col">state</th>
                <th scope="col" className="col-money">dollars a day</th>
                <th scope="col" className="col-makers">makers <span className="head-note">counted by the list</span></th>
                <th scope="col">age of prices</th>
                <th scope="col">the week, hour by hour</th>
              </tr>
            </thead>
            <tbody>
              {screen.sport.map((p) => (
                <PoolRow key={p.key} pool={p} open={p.key === openKey} flip={changed.has(p.key)} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        </div>
        {open !== undefined && (
          <Opened pool={open} settings={settings} steps={steps} qty={qty} spreadCents={spreadCents} onQty={onQty} onSpread={onSpread} books={books} pending={pending} extra={extra} unreadLeft={unreadLeft} />
        )}
      </div>
  );

  return (
    <div className="screen">
      {compact === true ? (
        <p className="plan-status">
          <span>{sim === true ? program.pools + " invented reward pools, $" + dollars(program.microsADay) + " a day between them" : program.pools + " pools, $" + dollars(program.microsADay) + " a day in all, each counted once, by the list's own pool ids"}</span>
          <span className="plan-tick">{"next snapshot in " + seconds + " s"}</span>
        </p>
      ) : (
      <header className="topbar">
          <h1 className="name">{NAME}</h1>
          <p className="countdown">
            <span className="digits" key={seconds}>{seconds}</span>
            <span className="count-label">{sim === true ? " seconds to the next snapshot" : " seconds to Gemini's next snapshot"}</span>
          </p>
          <p className="figure f3">
            {sim === true ? program.pools + " invented reward pools, $" + dollars(program.microsADay) + " a day between them" : program.pools + " pools, $" + dollars(program.microsADay) + " a day in all, each counted once, by the list's own pool ids"}
          </p>
          {now.of + now.live > 0 && <p className="figure f2">
            {sim === true ? "In " + now.none + " of " + now.of + " events nobody is quoting close enough to the middle to qualify right now" : "In " + now.none + " of " + now.of + " events read, the listed prices hold no qualifying pair at this read"}
            {(sim !== true || now.live > 0) && <span className="live-note">{". " + now.live + " in play, not scored from the list"}</span>}
          </p>}
        </header>
      )}
      <Allocator
        settings={settings} sport={screen.sport} readPools={readPools}
        budgetUsd={budgetUsd} stance={stance} onBudget={onBudget} onStance={onStance} controls={controls} simMinute={sim === true ? Math.floor(nowMs / 60_000) : undefined} compact={compact} nextHref={nextHref}
      />

      {compact === true ? (
        <details className="plan-more plan-all">
          <summary>{"All " + screen.sport.length + " pools" + (sim === true ? "" : ", by the list's own pool ids") + ": open one to try your own size and spread"}</summary>
          {now.of + now.live > 0 && <p className="plan-read">
            {sim === true ? "In " + now.none + " of " + now.of + " events nobody is quoting close enough to the middle to qualify right now" : "In " + now.none + " of " + now.of + " events read, the listed prices hold no qualifying pair at this read"}
            {(sim !== true || now.live > 0) && ". " + now.live + " in play, not scored from the list"}
          </p>}
          {poolsBody}
        </details>
      ) : poolsBody}
      {/* The one footnote (decided 2026-11-19): what every reward figure on the screen rests on. */}
      <footer className="screen-foot" role="note">{sim === true ? "Every market, price, book and reward amount on this page is invented, and so are the program's settings; only the scoring rule is real. Least figures are floors under that rule for the books shown, not forecasts. Nothing here places an order." : "Every reward figure on this screen is " + GEMINI_TEXT + ". Least figures are floors at the moment the books were read, not forecasts. Gemini's rules shut out contracts in post-only mode and members under a market-maker agreement; this screen reads neither. Nothing here places an order."}</footer>
    </div>
  );
}

/** The list's count of qualifying makers for a pool: largest across its events. */
function poolMakers(pool: PoolView): number {
  return pool.events.reduce((n, e) => Math.max(n, e.makers), 0);
}

function PoolRow({ pool, open, flip, onOpen }: { pool: PoolView; open: boolean; flip: boolean; onOpen: (key: string) => void }) {
  const stale = pool.pricesAgeMs > STALE_MS;
  return (
    <tr className={open ? "open" : undefined} aria-expanded={open}>
      <th scope="row" className="pool-name">
        <button type="button" onClick={() => onOpen(pool.key)}>{pool.name}</button>
      </th>
      <td key={pool.count.state} className={"state s-" + pool.count.state + (flip ? " flip" : "")}>{pool.read ? STATE_WORDS[pool.count.state] : "not read; open to read"}</td>
      <td className="money">${dollars(pool.microsADay)}</td>
      <td className="makers">{pool.makers}</td>
      <td className={"age" + (pool.read && stale ? " stale" : "")}>{pool.read ? ageWords(pool.pricesAgeMs) + (stale ? " stale" : "") : "\u2013"}</td>
      <td className="strip-col"><Strip strip={pool.strip} /></td>
    </tr>
  );
}

function cellKind(c: StripCell): string {
  if (c.passes === 0) return "empty";
  return c.may > 0 ? "cream" : "amber"; // amber: every pass that hour read nobody able to qualify
}

function Strip({ strip }: { strip: StripCell[] }) {
  let read = 0;
  let amber = 0;
  for (const c of strip) {
    if (c.passes > 0) {
      read++;
      if (c.may === 0) amber++;
    }
  }
  return (
    <span className="strip" role="img" aria-label={amber + " of " + read + " hours with no maker able to qualify"}>
      {strip.map((c, i) => <i key={i} data-cell="" aria-hidden="true" className={"cell c-" + cellKind(c)} />)}
    </span>
  );
}

function Opened({ pool, settings, steps, qty, spreadCents, onQty, onSpread, books, pending, extra, unreadLeft }: {
  books?: ReadonlyMap<string, Book>;
  pending?: boolean;
  extra?: CalcContract[]; unreadLeft?: number;
  pool: PoolView;
  settings: Settings;
  steps: ReadonlyMap<string, number>;
  qty: number;
  spreadCents: number;
  onQty: (n: number) => void;
  onSpread: (n: number) => void;
}) {
  return (
    <aside className="opened" aria-label={"events of " + pool.name}>
      <Calculator settings={settings} pool={pool} steps={steps} qty={qty} spreadCents={spreadCents} onQty={onQty} onSpread={onSpread} books={books} pending={pending} extra={extra} unreadLeft={unreadLeft} />
      <div className="events">
      {pool.events.map((e) => (
        <article key={e.ticker} className="event">
          <h3 className="event-title">{e.title}</h3>
          <p className="event-state">{eventWords(e.state)}</p>
          <p className="event-makers">the list counted {e.makers} qualifying makers on its last scored day</p>
          <ul className="contracts">
            {e.contracts.map((c) => (
              <li key={c.symbol} className="contract">
                <span className="symbol">{c.symbol}</span>
                <span className="bid">{priceWords(c.top.bidCents)}</span>
                <span className="ask">{priceWords(c.top.askCents)}</span>
                {c.none && <span className="none">cannot hold a qualifying pair</span>}
              </li>
            ))}
          </ul>
        </article>
      ))}
      </div>
    </aside>
  );
}
