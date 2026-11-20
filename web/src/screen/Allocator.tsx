// The allocator (the lead of the screen): for a budget, the quotes across the pools read this
// session that Gemini's published score would credit most, at the least. Pure: it reads only its
// props and the `alloc` library; every figure of the exchange's arrives in `settings`. What it
// shows is a floor at the moment the books were read, never a forecast of fills or of rewards.
// The words that go with every reward figure stand once, at the foot of the screen this sits in
// (decided 2026-11-19: one footnote).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import type { Book, Settings } from "@app/score";
import { allocate, toAllocPool, type AllocPool, type ReadEvent, type Stance } from "../alloc.ts";
import { count, dollars, dollarsFine, dollarsFineLeast, pctLeast, score } from "./format.ts";
import type { PoolView } from "../pools.ts";
import type { ListedEvent } from "../../../services/engine/src/gemini.ts";

type Props = {
  settings: Settings;
  sport: PoolView[];
  // Every pool read this session: its events and the books read with them, by pool key.
  readPools: ReadonlyMap<string, { events: ListedEvent[]; books: ReadonlyMap<string, Book> }>;
  budgetUsd: number;
  stance: Stance;
  onBudget: (n: number) => void;
  onStance: (s: Stance) => void;
  controls?: ReactNode; // the read-every-pool controls; App drives them, so they pass through here
  /** On invented markets (the public demo): the minute now, so each snapshot can be scored as it passes. */
  simMinute?: number;
  /** On the one page: the short layout, with the detail folded away, and where its next step leads. */
  compact?: boolean;
  nextHref?: string;
};

const SENTENCE =
  "For a budget, the quotes Gemini's published score would credit most, at the least. A floor when the books were read, not a forecast: it says nothing of fills or of what other makers do next.";
const ASSUMPTION = "Assumes each order is paid for in full when placed. Gemini's margin rules were not read.";
const MAX_QUOTES = 20;

// The most the budget box takes. The allocation is worked out a block at a time, so a budget
// without a ceiling could hold the page (audit of 2026-11-18, the screen, finding 2).
export const MAX_BUDGET_USD = 1_000_000;

/** The allocation for what was read, and the pools no floor can be worked out for. */
function work(settings: Settings, sport: PoolView[], readPools: Props["readPools"], budget: number, stance: Stance) {
  // Each pool as the allocator takes it: its read events mapped to `ReadEvent`, its read books. A
  // pool not read is passed with no events, so `toAllocPool` returns it "not read".
  const okPools: AllocPool[] = [];
  const refused: { key: string; name: string; why: string }[] = [];
  for (const pool of sport) {
    const got = readPools.get(pool.key);
    const events: ReadEvent[] = got ? got.events.map((e) => ({ live: e.live, contracts: e.contracts, unread: e.unread })) : [];
    const books: ReadonlyMap<string, Book> = got ? got.books : new Map();
    const out = toAllocPool(settings, { key: pool.key, name: pool.name, microsADay: pool.microsADay, eventCount: pool.count.eventCount }, events, books);
    if ("why" in out) refused.push(out);
    else okPools.push(out);
  }

  return { alloc: allocate(settings, okPools, budget * 1_000_000, stance), refused };
}

/** The public demo's running tally: at each one-minute snapshot the quotes as they stand are
 * credited their least share of that minute, and the sum since the page was opened is shown. It is
 * arithmetic on invented books, said so beside it; nothing is placed and nothing is earned. */
const SIM_RUN_NOTE = "At each snapshot the quotes above are credited their least share of that minute. Change the budget or the stance and the next snapshot scores the new quotes. Invented markets: nothing is placed and nothing is earned.";

function SimRun({ minute, leastMicrosADay, compact }: { minute: number; leastMicrosADay: number; compact?: boolean }) {
  const [tally, setTally] = useState({ snapshots: 0, micros: 0 });
  const least = useRef(leastMicrosADay);
  least.current = leastMicrosADay;
  const first = useRef(minute);
  useEffect(() => {
    if (minute === first.current) return; // the minute the page opened in has not reached its snapshot
    setTally((t) => ({ snapshots: t.snapshots + 1, micros: t.micros + least.current / 1440 }));
  }, [minute]);
  if (compact === true) {
    return <p className="plan-run" role="status">{"Simulated run: " + tally.snapshots + (tally.snapshots === 1 ? " snapshot" : " snapshots") + " scored since you opened this page, least credit so far $" + (tally.micros / 1_000_000).toFixed(4)}</p>;
  }
  return (
    <div className="alloc-simrun" role="status">
      <p className="alloc-figure">{"Simulated run: " + tally.snapshots + (tally.snapshots === 1 ? " snapshot" : " snapshots") + " scored since you opened this page"}</p>
      <p className="alloc-figure">{"Least credit so far: $" + (tally.micros / 1_000_000).toFixed(4)}</p>
      <p className="alloc-assumption">{SIM_RUN_NOTE}</p>
    </div>
  );
}

export function Allocator({ settings, sport, readPools, budgetUsd, stance, onBudget, onStance, controls, simMinute, compact, nextHref }: Props) {
  const header = (
    <header className="alloc-head">
      <h2 className="alloc-name">ALLOCATOR</h2>
      {controls !== undefined && <div className="alloc-controls-slot">{controls}</div>}
    </header>
  );
  const sentence = <p className="alloc-sentence">{SENTENCE}</p>;

  const budget = Number.isFinite(budgetUsd) ? Math.min(Math.max(budgetUsd, 0), MAX_BUDGET_USD) : 0;
  // `sport` is made afresh at every tick of the clock; the allocation is worked out again only
  // when what it rests on changes.
  const sportKey = sport.map((p) => p.key + "\u0001" + p.name + "\u0001" + p.microsADay + "\u0001" + p.count.eventCount).join("\u0002");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const worked = useMemo(() => work(settings, sport, readPools, budget, stance), [settings, sportKey, readPools, budget, stance]);

  const read = sport.filter((p) => readPools.has(p.key)).length;
  // How old the oldest of the books worked from is: the read of every pool takes many minutes, so
  // the floors mix books of different ages and the screen says how far back they go.
  const oldestMin = Math.floor(Math.max(0, ...sport.filter((p) => readPools.has(p.key)).map((p) => p.pricesAgeMs)) / 60_000);
  if (read === 0 && compact === true) {
    return (
      <section className="alloc plan" aria-label="allocator">
        {controls !== undefined && <div className="plan-pass">{controls}</div>}
        <p className="alloc-empty">No pool has been read yet. The invented markets work meanwhile.</p>
      </section>
    );
  }
  if (read === 0) {
    return (
      <section className="alloc" aria-label="allocator">
        {header}
        {sentence}
        <p className="alloc-empty">No pool has been read yet. Open a pool, or read every pool.</p>
      </section>
    );
  }

  const { alloc, refused } = worked;

  const leftOut = [...alloc.leftOut, ...refused];
  const notRead = leftOut.filter((x) => x.why === "not read").length; // summarised in one line
  const named = leftOut.filter((x) => x.why !== "not read");

  const pools = [...alloc.pools].sort((a, b) => b.leastMicrosADay - a.leastMicrosADay);
  const quotes = [...alloc.quotes].sort((a, b) => b.tiedMicros - a.tiedMicros);
  const shownQuotes = quotes.slice(0, MAX_QUOTES);
  const moreQuotes = quotes.length - shownQuotes.length;

  const underNotes = (
    <>
      {budgetUsd > MAX_BUDGET_USD && (
        <p className="alloc-under" role="note">{"Worked out for $" + dollars(MAX_BUDGET_USD * 1_000_000) + ", the most this box takes."}</p>
      )}
      {alloc.leastMicrosADay > 0 && alloc.leastMicrosADay < settings.minPayoutMicros && (
        <p className="alloc-under" role="note">{(simMinute !== undefined ? "Under the least payment of $" + dollars(settings.minPayoutMicros) + " a day (an invented setting here)" : "Under Gemini's least payment of $" + dollars(settings.minPayoutMicros) + " a day") + ": a day's total below it is not distributed."}</p>
      )}
    </>
  );
  const poolsTable = (rows: typeof pools) => (
    <>
      <div className="alloc-table-scroll">
        <table className="alloc-pools">
          <thead>
            <tr>
              <th scope="col">pool</th>
              <th scope="col">dollars a day</th>
              <th scope="col">least share</th>
              <th scope="col">least dollars a day</th>
              <th scope="col">tied up</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.key} data-pool="">
                <th scope="row" className="alloc-pool-name">{p.name}</th>
                <td className="alloc-num">${dollarsFine(p.microsADay)}</td>
                <td className="alloc-num"><span className="weft" style={{ "--share": p.share } as CSSProperties} aria-hidden="true" />{pctLeast(p.share)}%</td>
                <td className="alloc-num">${dollarsFineLeast(p.leastMicrosADay)}</td>
                <td className="alloc-num">${dollars(p.tiedMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </>
  );
  const quotesAndLeftOut = (
    <>
      <div className="alloc-table-scroll">
        <table className="alloc-quotes">
          <thead>
            <tr>
              <th scope="col">contract</th>
              <th scope="col">bid</th>
              <th scope="col">ask</th>
              <th scope="col">score</th>
              <th scope="col">tied up</th>
              <th scope="col">worst loss</th>
            </tr>
          </thead>
          <tbody>
            {shownQuotes.map((q) => (
              <tr key={q.pool + "/" + q.symbol} data-quote="">
                <th scope="row" className="alloc-sym">{q.symbol}</th>
                <td className="alloc-num">{count(q.pair.bid.qty) + " at " + q.pair.bid.cents + "¢"}</td>
                <td className="alloc-num">{count(q.pair.ask.qty) + " at " + q.pair.ask.cents + "¢"}</td>
                <td className="alloc-num">{score(q.score)}</td>
                <td className="alloc-num">${dollars(q.tiedMicros)}</td>
                <td className="alloc-num">${dollars(q.worstLossMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {moreQuotes > 0 && <p className="alloc-more">{moreQuotes + " more quotes"}</p>}
      </div>

      {(named.length > 0 || notRead > 0) && (
        <div className="alloc-leftout">
          <h3 className="alloc-leftout-head">Left out</h3>
          <ul className="alloc-leftout-list">
            {named.map((x) => <li key={x.key}>{x.name + ": " + x.why}</li>)}
            {notRead > 0 && <li key="not-read">{notRead + " pools not read yet, by the list's own pool ids"}</li>}
          </ul>
        </div>
      )}
    </>
  );

  // The one page's layout: the two things to set, the four figures, where the budget goes and the
  // next step. Everything else is one press away, folded.
  if (compact === true) {
    const SHOWN = 6;
    return (
      <section className="alloc plan" aria-label="allocator">
        <div className="plan-inputs">
          <label className="plan-budget">
            <span className="plan-label">Your budget</span>
            <span className="plan-money">
              <span aria-hidden="true">$</span>
              <input type="number" inputMode="decimal" min={0} step={50} max={MAX_BUDGET_USD} value={budgetUsd} onChange={(e) => onBudget(Number(e.target.value))} />
            </span>
          </label>
          <fieldset className="plan-stance">
            <legend className="plan-label">How to quote</legend>
            <label><input type="radio" name="stance" checked={stance === "widest"} onChange={() => onStance("widest")} /><span>Widest <small>least likely to fill</small></span></label>
            <label><input type="radio" name="stance" checked={stance === "join"} onChange={() => onStance("join")} /><span>Join the best prices</span></label>
          </fieldset>
        </div>
        {controls !== undefined && <div className="plan-pass">{controls}</div>}

        <dl className="plan-stats">
          <div className="plan-stat plan-stat-main"><dt>Least credit</dt><dd>{"$" + dollarsFineLeast(alloc.leastMicrosADay)} <span>a day</span></dd></div>
          <div className="plan-stat"><dt>Money tied up</dt><dd>{"$" + dollars(alloc.tiedMicros)} <span>{"of $" + dollars(alloc.budgetMicros)}</span></dd></div>
          <div className="plan-stat"><dt>Worst loss</dt><dd>{"$" + dollars(alloc.worstLossMicros)}</dd></div>
          <div className="plan-stat"><dt>Pools quoted</dt><dd>{alloc.pools.length} <span>{simMinute !== undefined ? "of " + sport.length : "of " + read + " read; " + sport.length + " on the list, by the list's own pool ids"}</span></dd></div>
        </dl>
        {underNotes}
        {simMinute !== undefined && <SimRun minute={simMinute} leastMicrosADay={alloc.leastMicrosADay} compact />}

        {pools.length > 0 && (
          <>
            <h3 className="plan-sub">Where the budget goes</h3>
            {poolsTable(pools.slice(0, SHOWN))}
            {pools.length > SHOWN && (
              <details className="plan-more plan-rest">
                <summary>{"The other " + (pools.length - SHOWN) + " pools quoted"}</summary>
                {poolsTable(pools.slice(SHOWN))}
              </details>
            )}
          </>
        )}
        {pools.length === 0 && <p className="alloc-empty">No pool takes a quote at this budget. Try a larger one.</p>}

        {nextHref !== undefined && (
          <p className="plan-next">
            <a className="site-go" href={nextHref}>Next: fund the vault</a>
            <span>The contract an operator would draw this budget from.</span>
          </p>
        )}

        <details className="plan-more">
          <summary>{"The " + quotes.length + (quotes.length === 1 ? " quote" : " quotes") + " behind it"}</summary>
          {quotesAndLeftOut}
        </details>
        <details className="plan-more">
          <summary>How to read these figures</summary>
          <p className="plan-read">{SENTENCE}</p>
          <p className="plan-read">Money tied up is what the quotes cost to place. Worst loss is what is gone if every one of them fills and settles the wrong way. Least credit is the floor of a day’s rewards at these books, counting every order already resting as a rival.</p>
          <p className="plan-read">{ASSUMPTION}</p>
          {simMinute !== undefined && <p className="plan-read">{SIM_RUN_NOTE}</p>}
          {read > 0 && <p className="plan-read">The oldest books worked from here were read {oldestMin < 1 ? "under a minute" : oldestMin + " min"} ago.</p>}
        </details>
      </section>
    );
  }


  return (
    <section className="alloc" aria-label="allocator">
      {header}
      <div className="alloc-grid">
      <div className="alloc-side">
      {sentence}

      <div className="alloc-inputs">
        <label className="alloc-budget">
          <span className="alloc-budget-label">Budget, dollars</span>
          <input type="number" min={0} step={50} max={MAX_BUDGET_USD} value={budgetUsd} onChange={(e) => onBudget(Number(e.target.value))} />
        </label>
        <fieldset className="alloc-stance">
          <label><input type="radio" name="stance" checked={stance === "widest"} onChange={() => onStance("widest")} /> Widest (least likely to fill)</label>
          <label><input type="radio" name="stance" checked={stance === "join"} onChange={() => onStance("join")} /> Join the best prices</label>
        </fieldset>
      </div>

      <div className="alloc-figures">
        <p className="alloc-figure">{"Money tied up: $" + dollars(alloc.tiedMicros) + " of $" + dollars(alloc.budgetMicros)}</p>
        <p className="alloc-figure">{"Worst loss: $" + dollars(alloc.worstLossMicros)}</p>
        <p className="alloc-figure">{"Least credit: $" + dollarsFineLeast(alloc.leastMicrosADay) + " a day"}</p>
        <p className="alloc-figure">{simMinute !== undefined ? "Pools quoted: " + alloc.pools.length + " of " + sport.length : "Pools quoted: " + alloc.pools.length + " of " + read + " read (" + sport.length + " on the list, by the list's own pool ids)"}</p>
      </div>
      {budgetUsd > MAX_BUDGET_USD && (
        <p className="alloc-under" role="note">{"Worked out for $" + dollars(MAX_BUDGET_USD * 1_000_000) + ", the most this box takes."}</p>
      )}
      {alloc.leastMicrosADay > 0 && alloc.leastMicrosADay < settings.minPayoutMicros && (
        <p className="alloc-under" role="note">{(simMinute !== undefined ? "Under the least payment of $" + dollars(settings.minPayoutMicros) + " a day (an invented setting here)" : "Under Gemini's least payment of $" + dollars(settings.minPayoutMicros) + " a day") + ": a day's total below it is not distributed."}</p>
      )}
      {(
        <p className="alloc-assumption alloc-legend">Money tied up is what the quotes cost to place. Worst loss is what is gone if every one of them fills and settles the wrong way. Least credit is the floor of a day’s rewards at these books, counting every order already resting as a rival.</p>
      )}
      <p className="alloc-assumption">{ASSUMPTION}</p>
      {simMinute !== undefined && <SimRun minute={simMinute} leastMicrosADay={alloc.leastMicrosADay} />}
      {read > 0 && <p className="alloc-assumption">The oldest books worked from here were read {oldestMin < 1 ? "under a minute" : oldestMin + " min"} ago.</p>}
      </div>

      <div className="alloc-main">
      {poolsTable(pools)}
      {quotesAndLeftOut}
      </div>
      </div>
    </section>
  );
}
