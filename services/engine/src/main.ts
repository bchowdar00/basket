// The forward run's loop: a pass every `readEveryMs`, a sweep when one is due, and the files it keeps.
//
// Before its first request the loop works out the rule's hash of the build it sits in and checks it
// against the ledger's first line: a ledger made under another hash is refused and nothing is asked.
// Every answer the exchange gives is kept raw under `reads/`. Nothing here places an order.
//
// The files, under `dir` (the forward run's is `~/Data/hackathons/vault/forward/`):
//   ledger.jsonl  first line {ruleHash, settingsPath, startedAtMs}; then one {row, head} a row
//   state.json    the engine's state, written whole after each pass and each sweep
//   passes.log    one line a pass
//   commits.jsonl one line a send of the head to the vault on chain: {atMs, head, tx} or {atMs, head, error}
//   reads/<UTC date>.jsonl.gz  every request's address, status and answer: one JSON line each, each
//                line its own gzip member, so `zcat` gives back the lines exactly as they were

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { readRule } from "@app/rule";
import { ruleHashOf } from "../../../scripts/rule-hash.mjs";
import { BadAnswer, NoAnswer, Stopped, reader, type Deps, type ListedEvent, type Pools } from "./gemini.ts";
import { initialState, pass, type EngineState } from "./pass.ts";
import { addSweep, runSweep, sweepDue, sweepPlan } from "./sweep.ts";
import { committer, type CommitLine, type Sender } from "./commit.ts";

/** The one category of the event list the forward run reads (design 1.2 section 4, item 3: sport). The reward list's own categories are sub-categories ("College Football" and the like), so the check is that some listed event has a pool row (audit 2, finding 1). */
export const FORWARD_CATEGORY = "Sports";
const POOLS_EVERY_MS = 3_600_000; // the pool list and the settings, once an hour

/** Reward rows of these categories are not read by ticker: short-lived crypto markets settle too
 * fast to be worth a maker's floor. Copied from `web/src/pools.ts` `SKIP_CATEGORIES` (the screen's
 * own skip list); kept in step with it by hand, since nothing is imported from `web/`. */
export const SKIP_CATEGORIES = ["Bitcoin", "Ether", "Solana", "XRP", "HYPE", "Zcash"];


/** How many passes in a row a by-ticker read of an event a quote stands on may fail before the
 * event is taken as gone. Until then the pass is not made: `pass()` reads a standing quote with no
 * read of its contract as filled on the worse side, which is right for an event that left the
 * exchange and wrong for one answer that failed (audit of 2026-11-19, the engine, finding 2). */
export const MISSING_PASSES_MOST = 3;

/** `sender`, when given, sends each new head to the vault on chain (T16); without it nothing is committed. */
export type Io = { dir: string; buildDir: string; deps: Deps; passes?: number; sender?: Sender };

/** The ledger's first line, written when the ledger is new; otherwise checked. Throws when the ledger was made under another rule hash. */
export function checkLedger(dir: string, ruleHash: string, settingsPath: string, nowMs: number): string {
  const path = join(dir, "ledger.jsonl");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ ruleHash, settingsPath, startedAtMs: nowMs }) + "\n");
    return ruleHash;
  }
  const all = readFileSync(path, "utf8").trim().split("\n");
  const first = JSON.parse(all[0]) as { ruleHash?: unknown };
  if (first.ruleHash !== ruleHash) throw new Error("main: the build's rule hash " + ruleHash + " is not the ledger's " + String(first.ruleHash) + "; a new hash starts a new ledger (plan 1.2, T05)");
  return all.length > 1 ? (JSON.parse(all[all.length - 1]) as { head: string }).head : ruleHash; // the ledger's last head
}

function saveState(dir: string, st: EngineState): void {
  const tmp = join(dir, "state.json.next");
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, join(dir, "state.json"));
}

/** A pass given up because a read failed of an event a quote stands on. */
class Held extends Error {}

export async function main(io: Io): Promise<void> {
  const { dir, buildDir, deps } = io;
  mkdirSync(join(dir, "reads"), { recursive: true });
  const settingsPath = join(buildDir, "settings", "rule.json");
  const ruleHash: string = ruleHashOf(buildDir).hash;
  const rule = readRule(JSON.parse(readFileSync(settingsPath, "utf8")));
  const lastHead = checkLedger(dir, ruleHash, settingsPath, deps.nowMs());
  const hasState = existsSync(join(dir, "state.json"));
  if (!hasState && lastHead !== ruleHash) throw new Error("main: the ledger has rows and there is no state file; nothing is asked until the state is put back (audit 2, finding 5)");
  let state: EngineState = hasState ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) : initialState(ruleHash);
  if (state.ruleHash !== ruleHash) throw new Error("main: the state was made under rule hash " + state.ruleHash + ", not " + ruleHash);
  // The state's head must be the ledger's last: a crash between writing the two leaves them apart, and
  // carrying on would break the chain or write rows twice. Nothing is asked until a person mends it.
  if (state.chainHex !== lastHead) throw new Error("main: the state's head " + state.chainHex + " is not the ledger's last head " + lastHead);

  // Every answer kept raw, before anything reads it. Compressed: since 2026-11-17 the event list
  // nests each game's other markets, a page is up to 8.5 MB, and kept plain the answers filled
  // about 8 GB a day.
  const keep = (atMs: number, line: Record<string, unknown>) =>
    appendFileSync(join(dir, "reads", new Date(atMs).toISOString().slice(0, 10) + ".jsonl.gz"), gzipSync(JSON.stringify(line) + "\n"));
  const kept: Deps = {
    ...deps,
    async fetcher(url, timeoutMs) {
      const atMs = deps.nowMs();
      try {
        const a = await deps.fetcher(url, timeoutMs);
        keep(atMs, { atMs, url, status: a.status, json: a.json, ...(a.text !== undefined ? { text: a.text } : {}) });
        return a;
      } catch (e) {
        keep(atMs, { atMs, url, error: String(e) });
        throw e;
      }
    },
  };
  const r = reader(kept);

  // The head on chain. The first offer carries every row the ledger holds so far.
  const commits = io.sender === undefined ? null : committer(io.sender, (line: CommitLine) => {
    appendFileSync(join(dir, "commits.jsonl"), JSON.stringify(line) + "\n");
    if (process.env.VAULT_FORWARD_DIR !== undefined) console.log(JSON.stringify({ commit: line }));
  }, deps.nowMs);
  commits?.offer(state.chainHex);

  let pools: Pools | null = null;
  let settings: Awaited<ReturnType<typeof r.settings>> | null = null;
  let poolsAtMs = -Infinity;
  let sweeping: Promise<void> | null = null;
  // Tickers a by-ticker read showed to be of another category than the forward run's. An event's
  // category does not change, so such a ticker is not asked for again while this process lives. A
  // restart starts this empty, which costs one read of each.
  const notForward = new Set<string>();
  const missedInARow = new Map<string, number>(); // by ticker: by-ticker reads failed in a row
  const log = (o: Record<string, unknown>) => {
    const line = JSON.stringify(o);
    appendFileSync(join(dir, "passes.log"), line + "\n");
    if (process.env.VAULT_FORWARD_DIR !== undefined) console.log(line); // in the container, the platform's log shows each pass too
  };

  for (let n = 0; io.passes === undefined || n < io.passes; n++) {
    const startMs = deps.nowMs();
    try {
      if (pools === null || startMs - poolsAtMs >= POOLS_EVERY_MS) {
        settings = await r.settings();
        pools = await r.listPools();
        poolsAtMs = startMs;
      }
      // The pass is stamped with the time before its reads begin. The by-ticker reads take a minute
      // or two, and a pass stamped after them would credit minutes up to a time later than some of
      // its prices; stamped before them, every price is at least as new as the stamp, which can
      // only book a fill early, against us (audit of 2026-11-19, the engine, finding 1).
      const nowMs = deps.nowMs();
      const listed = await r.listEvents(FORWARD_CATEGORY);
      // The reward list names season-long markets the category list stopped giving on 2026-11-18.
      // Read each such ticker by name: every reward row whose category is not a skipped one, deduped,
      // and never one the category list already gave this pass. Each is read afresh at every pass:
      // a copy kept from the pass before would show the same prices twice, and the ledger counts a
      // minute where the same quote stood at two reads (audit of 2026-11-18, the engine, finding 1).
      // Only an event of the forward run's own category is handed to the pass: the reward list also
      // names events of other categories, and the ledger under this rule hash is sport alone
      // (finding 2). A ticker whose read is a NoAnswer or BadAnswer is left out for this pass and
      // named in `missing`; a Stopped (429) ends the pass.
      const listedTickers = new Set(listed.events.map((e) => e.ticker));
      const wanted = [...new Set(pools!.rows.filter((row) => !SKIP_CATEGORIES.includes(row.category)).map((row) => row.ticker))].filter((t) => !listedTickers.has(t) && !notForward.has(t));
      const byTicker: ListedEvent[] = [];
      const missing: string[] = [];
      for (const ticker of wanted) {
        try {
          const e = await r.event(ticker);
          const category = e.category.trim().toLowerCase();
          // An answer with no category says nothing of what the event is: it is a failed read, not
          // an event of another category (finding 3).
          if (category === "") missing.push(ticker);
          else if (category === FORWARD_CATEGORY.toLowerCase()) byTicker.push(e);
          else notForward.add(ticker);
        } catch (e) {
          if (e instanceof NoAnswer || e instanceof BadAnswer) { missing.push(ticker); continue; }
          throw e; // a Stopped (429) ends the pass as today, caught by the handler below
        }
      }
      // The count is of failures in a row: a ticker not missing at this pass (read by its ticker, given
      // by the category list, or no longer wanted) starts again from nothing (audit round 2, finding 1).
      for (const t of [...missedInARow.keys()]) if (!missing.includes(t)) missedInARow.delete(t);
      for (const t of missing) missedInARow.set(t, (missedInARow.get(t) ?? 0) + 1);
      const held = missing.filter((t) => state.standing[t] !== undefined && (missedInARow.get(t) ?? 0) <= MISSING_PASSES_MOST);
      if (held.length > 0) {
        log({ atMs: nowMs, skipped: "a read failed of an event a quote stands on", held, missing });
        throw new Held();
      }
      const events = [...listed.events, ...byTicker];
      const tickers = new Set(pools!.rows.map((row) => row.ticker));
      if (!events.some((e) => tickers.has(e.ticker))) {
        log({ atMs: deps.nowMs(), skipped: "no event read has a pool row on the reward list", listed: listed.events.length, poolRows: pools!.rows.length, byTicker: byTicker.length, notForward: notForward.size, missing });
      } else {
        const out = pass(rule, state, { events, pools: pools!, settings: settings! }, nowMs);
        state = out.state;
        if (out.lines.length > 0) appendFileSync(join(dir, "ledger.jsonl"), out.lines.join("\n") + "\n");
        saveState(dir, state);
        commits?.offer(state.chainHex);
        log({ atMs: nowMs, quoted: out.decisions.filter((d) => d.pair !== null).length, fills: out.fills.length, rows: out.rows.length, listed: listed.events.length, moved: listed.moved, byTicker: byTicker.length, notForward: notForward.size, missing, head: state.chainHex });
        if (sweeping === null && sweepDue(rule, state.sweptAtMs, nowMs) && Object.keys(state.standing).length > 0) {
          const plan = sweepPlan(settings!, state, { events, pools: pools!, settings: settings! });
          const s = settings!;
          sweeping = runSweep(r, rule, s, plan, deps).then((res) => {
            state = addSweep(state, res.atMs, res.figures);
            saveState(dir, state);
            log({ sweepAtMs: res.atMs, books: plan.symbols.length, stopped: res.stopped, figures: res.figures });
          }).finally(() => { sweeping = null; });
        }
      }
    } catch (e) {
      if (e instanceof Held) { /* logged where it was thrown; the pass is not made */ }
      else if (e instanceof Stopped || e instanceof NoAnswer || e instanceof BadAnswer) log({ atMs: deps.nowMs(), skipped: String(e) }); // the reader already waits after a 429
      else throw e;
    }
    const wait = startMs + rule.readEveryMs - deps.nowMs();
    if (wait > 0) await deps.sleep(wait);
  }
  if (sweeping !== null) await sweeping;
  await commits?.idle();
}

// Run directly (by `deploy/start-engine.sh`, and only on his word): the real network, the forward run's folder.
if (import.meta.main) {
  const { homedir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { nodeDeps } = await import("./gemini.ts");
  await main({ dir: join(homedir(), "Data", "hackathons", "vault", "forward"), buildDir: fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, ""), deps: nodeDeps() });
}
