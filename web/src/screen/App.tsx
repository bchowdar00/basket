// The live screen. It reads /feed/screen (the engine's recorded answers, through the dev-server
// route) on load and every minute, and works the clock and the ages out every second from the last
// input it holds. When a read fails it shows a plain red line and keeps the last good screen up.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Book } from "@app/score";
import type { CalcContract } from "../calc.ts";
import type { Stance } from "../alloc.ts";
import type { ListedEvent } from "../../../services/engine/src/gemini.ts";
import { screenOf, type ScreenIn } from "../pools.ts";
import { eventsToRead, poolsToRead, SKIP_CATEGORIES } from "./readall.ts";
import { Screen } from "./Screen.tsx";

/** Each sport pool's state, so two reads can be compared for what changed. */
function statesOf(input: ScreenIn): Map<string, State> {
  return new Map(screenOf(input, Date.now()).sport.map((p) => [p.key, p.count.state]));
}
type State = ReturnType<typeof screenOf>["sport"][number]["count"]["state"];

type Read = { events: ListedEvent[]; books: Map<string, Book> };

/** One read of /feed/pool, parsed: its events and the books read with them, or the reason it failed. */
async function readPool(key: string): Promise<(Read & { errors: string[] }) | { error: string }> {
  try {
    const res = await fetch("/feed/pool?pool=" + encodeURIComponent(key));
    const got = (await res.json()) as { events?: ListedEvent[]; books?: Record<string, { book: Book | null }>; errors?: string[]; error?: string };
    if (!res.ok || got.events === undefined) return { error: got.error ?? "the feed answered " + res.status };
    const books = new Map<string, Book>();
    for (const [symbol, a] of Object.entries(got.books ?? {})) if (a.book !== null) books.set(symbol, a.book);
    return { events: got.events, books, errors: got.errors ?? [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function App() {
  const [input, setInput] = useState<ScreenIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The calculator's two controls. Null until the first read gives Gemini's settings; then the least
  // size and the widest spread, so the first quote shown is the widest a maker could rest.
  const [qty, setQty] = useState<number | null>(null);
  const [spreadCents, setSpreadCents] = useState<number | null>(null);
  // The allocator's two controls: a budget in whole dollars and the stance.
  const [budgetUsd, setBudgetUsd] = useState(1000);
  const [stance, setStance] = useState<Stance>("widest");
  const last = useRef<ScreenIn | null>(null);
  // Every pool read this session, by key: its events and the books read with them. Filled both when a
  // single pool is opened and by the "read every pool" run. `shown` merges all of it into the input.
  const [readPools, setReadPools] = useState<Map<string, Read>>(() => new Map());
  // The live feed reads a pool when it is opened: its events by ticker, then their books. The
  // events are merged into the input so the same `screenOf` draws them; the recorded feed answers 404.
  const [opened, setOpened] = useState<{ key: string; events: ListedEvent[]; books: Map<string, Book>; errors: string[] } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // The read-every-pool run: a confirm step, then one request at a time. Null when idle.
  const [run, setRun] = useState<
    | { phase: "confirm"; keys: string[]; events: number }
    | { phase: "running"; keys: string[]; done: number }
    | null
  >(null);
  const [runError, setRunError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const source = (input as { source?: string } | null)?.source;
  useEffect(() => {
    if (openKey === null || source !== "live") return;
    let on = true;
    setPending(openKey);
    void (async () => {
      const got = await readPool(openKey);
      if (!on) return;
      if ("error" in got) { setOpened({ key: openKey, events: [], books: new Map(), errors: [got.error] }); setPending(null); return; }
      setOpened({ key: openKey, events: got.events, books: got.books, errors: got.errors });
      setReadPools((prev) => new Map(prev).set(openKey, { events: got.events, books: got.books }));
      setPending(null);
    })();
    return () => { on = false; };
  }, [openKey, source]);
  // The input the screen is drawn from: the feed's, with every read pool's events in place of any
  // older copy (newest copy of a ticker wins).
  const readEvents: ListedEvent[] = [];
  for (const r of readPools.values()) readEvents.push(...r.events);
  const readTickers = new Set(readEvents.map((e) => e.ticker));
  const shown: ScreenIn | null = input === null ? null
    : { ...input, events: [...input.events.filter((e) => !readTickers.has(e.ticker)), ...readEvents], eventsAtMs: input.eventsAtMs };
  const screen = shown === null ? null : screenOf(shown, nowMs);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const res = await fetch("/feed/screen");
        if (!res.ok) throw new Error("the feed answered " + res.status);
        const next = (await res.json()) as ScreenIn;
        if (!live) return;
        const prev = last.current;
        const diff = new Set<string>();
        if (prev !== null) {
          const before = statesOf(prev);
          for (const [k, st] of statesOf(next)) if (before.get(k) !== st) diff.add(k);
        }
        last.current = next;
        setInput(next);
        setChanged(diff);
        setError(null);
        if (prev === null) {
          // First good read: open the first sport pool, and start the calculator at the widest quote.
          // Only from the recorded feed: opening a pool of the live feed sends requests, so that waits for a click.
          if ((next as { source?: string }).source !== "live") setOpenKey((cur) => cur ?? (screenOf(next, Date.now()).sport[0]?.key ?? null));
          setQty((cur) => cur ?? next.settings.minSize);
          setSpreadCents((cur) => cur ?? next.settings.maxSpreadCents);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void load();
    const feed = setInterval(() => void load(), 60_000);
    const tick = setInterval(() => { if (live) setNowMs(Date.now()); }, 1_000);
    return () => { live = false; clearInterval(feed); clearInterval(tick); };
  }, []);

  // The read-every-pool run, driven from here: strictly one request to /feed/pool at a time, 1.2
  // seconds apart, in the order `poolsToRead` gives, stoppable before the next pool. It never starts
  // itself; the Start button below runs it. A "pause" in an answer's errors, or a request that is not
  // 200, stops it and shows the error.
  function askRun() {
    if (screen === null) return;
    const queue = poolsToRead(screen.sport, new Set(readPools.keys()), SKIP_CATEGORIES);
    setRunError(null);
    setRun({ phase: "confirm", keys: queue.map((p) => p.key), events: eventsToRead(queue) });
  }
  async function startRun(keys: string[]) {
    stopRef.current = false;
    setRunError(null);
    setRun({ phase: "running", keys, done: 0 });
    for (let i = 0; i < keys.length; i++) {
      if (stopRef.current) break;
      const got = await readPool(keys[i]);
      if ("error" in got) { setRunError("could not read a pool: " + got.error); break; }
      setReadPools((prev) => new Map(prev).set(keys[i], { events: got.events, books: got.books }));
      setRun((r) => (r !== null && r.phase === "running" ? { ...r, done: i + 1 } : r));
      if (got.errors.some((e) => e.includes("pause"))) { setRunError("Gemini asked to pause: " + got.errors.join("; ")); break; }
      if (i + 1 < keys.length) {
        if (stopRef.current) break;
        // The spacing is for Gemini's sake; replaying kept answers asks nothing, so it does not wait.
        await new Promise((res) => setTimeout(res, (input as { kept?: boolean } | null)?.kept === true ? 40 : 1_200));
      }
    }
    setRun(null);
  }
  function stopRun() { stopRef.current = true; }

  const controls: ReactNode = source !== "live" ? undefined : (
    <div className="alloc-run">
      {run === null && <button type="button" onClick={askRun}>Read every pool for the allocator</button>}
      {run !== null && run.phase === "confirm" && (
        <div className="alloc-confirm">
          <p className="alloc-confirm-line">{(input as { kept?: boolean } | null)?.kept === true ? "This replays the kept answers for about " + run.events + " events and their books; nothing is asked of Gemini. Start?" : "This asks Gemini for about " + run.events + " events and their books, one request every 1.2 seconds. Start?"}</p>
          <button type="button" onClick={() => void startRun(run.keys)}>Start</button>
          <button type="button" onClick={() => setRun(null)}>Cancel</button>
        </div>
      )}
      {run !== null && run.phase === "running" && (
        <div className="alloc-running">
          <span>{"Read " + run.done + " of " + run.keys.length + " pools"}</span>
          <button type="button" onClick={stopRun}>Stop</button>
        </div>
      )}
      {runError !== null && <p className="error" role="alert">{runError}</p>}
    </div>
  );

  // The opened pool's contracts the list could not price: with a book read whole they join the
  // calculator, their best prices taken from the book (the step is not known for them; 1 is used).
  let extra: CalcContract[] | undefined, unreadLeft: number | undefined;
  if (opened !== null && opened.key === openKey && source === "live") {
    extra = []; unreadLeft = 0;
    for (const e of opened.events) for (const symbol of e.unread) {
      const b = opened.books.get(symbol);
      if (b === undefined || b.depth !== undefined) { unreadLeft++; continue; }
      extra.push({ symbol, stepCents: 1, book: b, top: { bidCents: b.bids[0]?.cents ?? null, askCents: b.asks[0]?.cents ?? null } });
    }
  }

  // A contract's price step by symbol, from the fetched events (the screen's own `EventView` carries
  // no step). A symbol not in it uses 1 in the calculator.
  const steps = new Map<string, number>();
  if (shown !== null) for (const e of shown.events) for (const c of e.contracts) steps.set(c.symbol, c.stepCents);

  return (
    <main className={"board" + ((input as { kept?: boolean } | null)?.kept === true ? " kept" : "")}>
      {input !== null && <p className="source">{(input as { kept?: boolean }).kept === true ? "From the answers Gemini's public API gave this Mac earlier; nothing is asked of Gemini now" : source === "live" ? "Read from Gemini's public API by this Mac" : "From the forward run's recorded answers on this Mac; nothing is asked of Gemini"}</p>}
      {opened !== null && opened.key === openKey && opened.errors.length > 0 && <p className="error" role="alert">not everything in this pool could be read: {opened.errors.join("; ")}</p>}
      {error !== null && <p className="error" role="alert">could not read the feed: {error}</p>}
      {input !== null
        ? <Screen
            screen={screen!} nowMs={nowMs} openKey={openKey}
            onOpen={(k) => setOpenKey((cur) => (cur === k ? null : k))} changed={changed}
            settings={input.settings} steps={steps}
            qty={qty ?? input.settings.minSize} spreadCents={spreadCents ?? input.settings.maxSpreadCents}
            onQty={setQty} onSpread={setSpreadCents}
            readPools={readPools} budgetUsd={budgetUsd} stance={stance} onBudget={setBudgetUsd} onStance={setStance} controls={controls}
            books={opened !== null && opened.key === openKey ? opened.books : undefined} pending={pending !== null && pending === openKey} extra={extra} unreadLeft={unreadLeft}
          />
        : error === null && <p className="waiting">reading the feed…</p>}
    </main>
  );
}
