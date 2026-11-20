// The vault's phone page. `VaultView` is pure markup — it draws the test-money banner, the phone's
// own address, what it holds, the one next step as a single primary button with its sentence, the
// quiet terms read from the chain, the commit log, and the declare-default control — so it is
// rendered and read in tests. `VaultApp` is the container: it makes the browser wallet, talks to
// the relayer and reads the vault, works out the one next step, and runs it.
//
// Word rules (decided 2026-11-19, replacing the house rule of 2026-11-18 for this page): the
// page reads as a product would, with amounts in dollars; that the money is test USDC with no real
// value and that a round closes with a simulated result is said once, small, at the foot of every
// screen (`DEMO_NOTE` in VaultApp.tsx). Still: no yearly rate, and nothing said to be earned or
// paid by an exchange. Deadlines are shown in the
// person's local time with the UTC time beside it.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";

import { relayerApi, NoAnswer, RelayerError, type RelayerApi } from "./api.ts";
import { vaultChain, type Quote, type VaultChain, type VaultData } from "./chain.ts";
import { depositorsResult, pctOf, readRounds, type Round } from "./rounds.ts";
import { fmtUsd, nextStep, type Step, type StepInput } from "./steps.ts";
import type { VaultSettings } from "./main.tsx";
import { deviceId, loadOrMakeKey, type VaultWallet } from "./wallet.ts";

const short = (a: Address): string => a.slice(0, 6) + "…" + a.slice(-4);

/** A unix-seconds moment in the person's local time with the UTC time beside it. */
function whenLocalUtc(sec: bigint): string {
  const d = new Date(Number(sec) * 1000);
  return d.toLocaleString() + " (" + d.toISOString().slice(0, 19).replace("T", " ") + " UTC)";
}

/** How long is left on the open round, in plain words. */
function timeLeft(deadline: bigint, nowSec: number): string {
  const left = Number(deadline) - nowSec;
  if (left <= 0) return "the deadline has passed";
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (m > 0 ? m + "m " : "") + s + "s left";
}

/** Whether a default may be declared now. The contract (BondedVault.declareDefault) allows it on an
 * open, not-yet-defaulted round once the chain's own latest block has passed the deadline — it
 * reverts while `block.timestamp <= deadline`. The phone's clock is never used for this. */
export function canDeclareDefault(data: VaultData): boolean {
  return data.epoch.open && !data.epoch.defaulted && data.blockTimestamp > data.epoch.deadline;
}

/** The one line that says what the money is. It stands small at the foot of every screen of the page
 * (decided 2026-11-19: a small note at the bottom, the rest as a product would read). */
export const DEMO_NOTE = "Demo on Arc’s test network. Balances are test USDC with no real value; rounds close with a simulated result.";

const PRIMARY_LABEL: Record<Step["kind"], string | null> = {
  handout: "Add funds",
  approve: "Allow the vault",
  deposit: "Deposit",
  ask: "Withdraw",
  claim: "Claim",
  waiting: null,
  done: null,
};

export type VaultViewProps = {
  vaultName: string;
  vaultAddress: Address; // where the vault's commits are on the explorer (the name is the relayer's, not the chain's)
  address: Address;
  data: VaultData;
  step: Step;
  nowSec: number;
  deadlinePassed: boolean;
  explorerBase: string;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onPrimary: () => void;
  onDeclareDefault: () => void;
  /** The vault's recent rounds, newest first; null while they have not been read. */
  rounds?: Round[] | null;
  /** About how often a round opens on this deployment, in seconds, when the page was told. */
  roundEverySec?: number | null;
  /** Where the source is, when the page was told. */
  sourceUrl?: string | null;
  /** Where the operator's screen on invented markets is, when the page was told. */
  screenUrl?: string | null;
  /** Laid out as steps two to four of the one-page site, without the page's own name and opening. */
  site?: boolean;
};

/** A unix-seconds moment as a short UTC clock time. */
const clockUtc = (sec: bigint): string => new Date(Number(sec) * 1000).toISOString().slice(11, 16) + " UTC";

/** A small amount to four places, signed: a round's result on a small vault is under a cent. */
function fmtSmall(units: bigint): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  return (neg ? "−$" : "+$") + (u / 1_000_000n).toLocaleString("en-US") + "." + ((u % 1_000_000n) / 100n).toString().padStart(4, "0");
}

/** The line that says where the rounds stand now. */
export function roundStatus(d: VaultData, rounds: Round[] | null, everySec: number | null, nowSec: number): string {
  if (d.epoch.defaulted) return "The vault is closed: a default was declared in round " + d.epoch.id.toString() + ".";
  if (d.epoch.open) return "Round " + d.epoch.id.toString() + " is open: $" + fmtUsd(d.epoch.drawn) + " is out with the operator, " + timeLeft(d.epoch.deadline, nowSec) + ".";
  const last = rounds !== null && rounds.length > 0 ? rounds[0] : null;
  if (last !== null && everySec !== null) {
    const left = Number(last.startedAt) + everySec - nowSec;
    if (left > 45) return "No round is open. The next opens in about " + Math.ceil(left / 60) + " min.";
    if (left > -180) return "No round is open. The next opens any moment.";
  }
  return "No round is open now.";
}

function RoundRow({ r, explorerBase }: { r: Round; explorerBase: string }) {
  const result = depositorsResult(r);
  return (
    <li className="vault-round">
      <span className="vault-round-id">Round {r.id.toString()} · {clockUtc(r.startedAt)} · plan {r.plan.slice(0, 8)}…{r.plan.slice(-4)}</span>
      {r.end === null ? (
        <span>Drew ${fmtUsd(r.draw)}; open</span>
      ) : r.end.kind === "default" ? (
        <span>Drew ${fmtUsd(r.draw)}, did not settle. <a className="vault-hash" href={explorerBase + "/tx/" + r.end.tx} target="_blank" rel="noreferrer">Default declared</a>: ${fmtUsd(r.end.moved)} of bond moved to depositors</span>
      ) : (
        <>
          <span>Drew ${fmtUsd(r.draw)}, <a className="vault-hash" href={explorerBase + "/tx/" + r.end.tx} target="_blank" rel="noreferrer">returned ${fmtUsd(r.end.returned)}</a></span>
          {result !== null && (
            <span className="vault-round-result">
              Depositors {fmtSmall(result)} ({pctOf(result, r.assetsAtStart)})
              {r.end.fromBond > 0n ? "; $" + fmtUsd(r.end.fromBond) + " of the loss came out of the bond" : r.end.fee > 0n ? "; operator’s fee " + fmtSmall(r.end.fee).slice(1) : ""}
            </span>
          )}
        </>
      )}
    </li>
  );
}

export function VaultView(p: VaultViewProps) {
  const d = p.data;
  const label = p.step.kind === "ask" && d.epoch.open ? "Ask to withdraw" : PRIMARY_LABEL[p.step.kind];
  const feePct = (d.gainBps / 100).toString();
  const hasCommits = d.commits > 0n && d.head !== ("0x" + "00".repeat(32));

  // The default's section: quiet at the foot while it cannot be declared; at the top, and loud, once
  // the deadline has passed with the round still open; replaced by what happened once it is declared.
  const urgent = p.deadlinePassed && d.epoch.open && !d.epoch.defaulted;
  const quietDefault = (
    <section className="vault-default" aria-label="if the operator misses the deadline">
        <h2 className="vault-terms-head">If the operator misses the deadline</h2>
        <p className="vault-figure">
          If the operator does not settle this round in time, anyone may declare a default. The whole
          bond moves to the vault for depositors, and the vault closes.
        </p>
        <button
          type="button" className="vault-declare" data-declare=""
          disabled={!p.deadlinePassed || p.busy} onClick={p.onDeclareDefault}
        >
          Declare the operator in default
        </button>
      </section>
  );
  const who = (
    <p className="vault-who">{p.vaultName !== "" && <>Vault: <span className="vault-addr">{p.vaultName}</span> · </>}Wallet: <span className="vault-addr">{short(p.address)}</span></p>
  );
  const alerts = (
    <>
      {p.error !== null && <p className="error" role="alert">{p.error}</p>}
      {p.notice !== null && <p className="vault-notice" role="status">{p.notice}</p>}
    </>
  );
  const hold = (
    <section className="vault-hold" aria-label="what you hold">
      <p className="vault-figure f1"><span className="vault-amount">${fmtUsd(d.worth)}</span> <span className="vault-amount-of">in the vault</span></p>
      {d.claimable > 0n && <p className="vault-figure">Ready to claim: ${fmtUsd(d.claimable)}</p>}
      {d.waiting > 0n && <p className="vault-figure">Waiting in this round: ${fmtUsd(d.waiting)} (becomes shares at the round’s end)</p>}
      {d.epoch.open && d.epoch.drawn > 0n && (
        <p className="vault-figure vault-out">Out with the operator this round: ${fmtUsd(d.epoch.drawn)} of the vault’s. The figure above leaves it out until the round ends; the bond stands behind it.</p>
      )}
      <p className="vault-figure f3">In your wallet: ${fmtUsd(d.balance)}</p>
    </section>
  );
  const urgentBlock = urgent && (
    <section className="vault-default vault-default-live" aria-label="the operator missed the deadline">
      <h2 className="vault-terms-head">The operator missed the deadline</h2>
      <p className="vault-figure">
        This round’s deadline has passed and the operator has not settled. Anyone may declare a
        default now: the whole bond of ${fmtUsd(d.bond)} moves to the vault for
        depositors, and the vault closes.
      </p>
      <button type="button" className="vault-declare" data-declare="" disabled={p.busy} onClick={p.onDeclareDefault}>
        Declare the operator in default
      </button>
    </section>
  );
  const doneBlock = d.epoch.defaulted && (
    <section className="vault-default vault-default-done" aria-label="the operator is in default">
      <h2 className="vault-terms-head">The operator is in default</h2>
      <p className="vault-figure">
        A default was declared in round {d.epoch.id.toString()}. The operator’s whole bond moved
        to the vault for depositors, and the vault is closed: nothing more can be deposited, and
        what you hold can be withdrawn.
      </p>
    </section>
  );
  const stepBlock = (
    <section className="vault-step" aria-label="your next step">
      <p className="vault-step-sentence">{p.step.sentence}</p>
      {label !== null && (
        <button type="button" className="vault-primary" data-primary="" disabled={p.busy} onClick={p.onPrimary}>
          {p.busy ? "Working…" : label}
        </button>
      )}
    </section>
  );
  const closedRounds = (p.rounds ?? []).filter((r) => r.end !== null);
  const roundsBody = (
    <>
      <p className="vault-round-sim" role="note">
        Demo rounds. The stand-in operator sends back what it drew with a small made-up gain, so
        the mechanics can be seen. No order was placed on any exchange and no reward was received.
      </p>
      <p className="vault-figure vault-round-now" data-round-now="">{roundStatus(d, p.rounds ?? null, p.roundEverySec ?? null, p.nowSec)}</p>
      {closedRounds.length > 0 && (
        <ol className="vault-round-list" aria-label="recent rounds">
          {closedRounds.slice(0, 5).map((r) => <RoundRow key={r.id.toString()} r={r} explorerBase={p.explorerBase} />)}
        </ol>
      )}
    </>
  );
  const howList = (
    <ol className="vault-how-list">
      <li>You deposit. Your money sits in the contract, not with the operator.</li>
      <li>To open a round the operator puts the hash of its plan on chain, then may draw up to the draw limit, and no more.</li>
      <li>It must send the money back before the deadline. A gain lifts what you hold; a loss comes out of the operator’s bond first.</li>
      <li>If the deadline passes unsettled, anyone may declare a default. The whole bond moves to depositors.</li>
    </ol>
  );
  const termsList = (
    <dl className="vault-terms-list">
      <dt>Draw limit</dt>
      <dd>${fmtUsd(d.maxDraw)}, the most the operator may draw for one round: the lesser of ${fmtUsd(d.byBond)} by its bond and ${fmtUsd(d.byVault)} by the vault’s size</dd>
      <dt>Bond</dt>
      <dd>${fmtUsd(d.bond)} posted by the operator, first to take a loss</dd>
      <dt>Cap</dt>
      <dd>${fmtUsd(d.cap)} in all (${fmtUsd(d.room + 5_000n)} of room left)</dd>
      <dt>Round length</dt>
      <dd>{Number(d.epochSeconds) % 60 === 0 && Number(d.epochSeconds) >= 120 ? (Number(d.epochSeconds) / 60).toString() + " minutes" : d.epochSeconds.toString() + " seconds"}{d.epoch.open ? ", " + timeLeft(d.epoch.deadline, p.nowSec) : ", no round open now"}</dd>
      {d.epoch.open && (
        <>
          <dt>This round ends</dt>
          <dd>{whenLocalUtc(d.epoch.deadline)}</dd>
        </>
      )}
      <dt>Fee on a gain</dt>
      <dd>{feePct}% of any gain goes to the operator; the rest stays with the vault</dd>
    </dl>
  );
  const commitsBody = hasCommits ? (
    <p className="vault-figure">
      {d.commits.toString()} so far. Last hash:{" "}
      <a className="vault-hash" href={p.explorerBase + "/address/" + p.vaultAddress} target="_blank" rel="noreferrer">
        {d.head.slice(0, 10)}…{d.head.slice(-6)}
      </a>
    </p>
  ) : (
    <p className="vault-figure">No commits yet.</p>
  );
  const links = (
    <p className="vault-links">
      <a className="vault-hash" href={p.explorerBase + "/address/" + p.vaultAddress} target="_blank" rel="noreferrer">The contract on Arc’s explorer</a>
      {p.sourceUrl != null && <> · <a className="vault-hash" href={p.sourceUrl} target="_blank" rel="noreferrer">Source</a></>}
    </p>
  );

  // On the one-page site the same pieces are laid out as its steps two to four, each under its own
  // heading; the page's own name, opening paragraph and step one stand above them.
  if (p.site === true) {
    return (
      <div className="vault vault-site">
        <section id="fund" className="site-section" aria-labelledby="fund-h">
          <h2 id="fund-h" className="site-h">2. Fund the vault</h2>
          <div className="site-cols">
            <div className="site-col">
              <p className="site-say">
                Depositors put money into a contract, and the operator may only borrow from it
                under the limits on the right. Try it with test dollars in three taps. No wallet
                app is needed: this page keeps a test wallet in your browser and a relayer pays the
                network fees.
              </p>
              {alerts}
              {urgentBlock}
              {doneBlock}
              <div className="site-panel">
                <ol className="site-taps" aria-label="the three taps">
                  {(["Add funds", "Allow the vault", "Deposit"] as const).map((name, i) => {
                    const at = p.step.kind === "handout" ? 0 : p.step.kind === "approve" ? 1 : p.step.kind === "deposit" ? 2 : d.shares > 0n || d.waiting > 0n ? 3 : -1;
                    return <li key={name} className={at === i ? "now" : at > i ? "done" : ""} aria-current={at === i ? "step" : undefined}>{name}</li>;
                  })}
                </ol>
                {who}
                {hold}
                {stepBlock}
              </div>
            </div>
            <div className="site-col">
              <h3 className="vault-terms-head">The limits the contract holds the operator to</h3>
              {termsList}
            </div>
          </div>
        </section>

        <section id="rounds" className="site-section" aria-labelledby="rounds-h">
          <h2 id="rounds-h" className="site-h">3. Watch a round</h2>
          <div className="site-cols">
            <div className="site-col">
              <p className="site-say">
                The operator works in rounds. Your holding in step 2 moves when a round closes, and
                each closed round is listed here with its transaction.
              </p>
              {howList}
            </div>
            <div className="site-col vault-rounds">
              {roundsBody}
            </div>
          </div>
        </section>

        <section id="safety" className="site-section" aria-labelledby="safety-h">
          <h2 id="safety-h" className="site-h">4. The safety net</h2>
          <div className="site-cols">
            <div className="site-col">
              <p className="site-say">
                The operator has ${fmtUsd(d.bond)} of its own money posted as a bond. A loss comes
                out of that first. If a round passes its deadline unsettled, nobody has to ask
                permission: anyone, from this page, can declare a default, and the whole bond moves
                to depositors.
              </p>
              {!urgent && !d.epoch.defaulted && (
                <>
                  <button type="button" className="vault-declare" data-declare="" disabled={!p.deadlinePassed || p.busy} onClick={p.onDeclareDefault}>
                    Declare the operator in default
                  </button>
                  <p className="site-quiet">This button wakes only when a round is open past its deadline.</p>
                </>
              )}
              {urgent && <p className="site-quiet">The deadline has passed: the button is at the top of step 2.</p>}
            </div>
            <div className="site-col">
              <h3 className="vault-terms-head">The record on chain</h3>
              <p className="site-say">Before each round the operator names the hash of its plan on chain, so what it said it would do cannot be rewritten afterwards.</p>
              {(p.rounds ?? []).length > 0 && <p className="vault-figure">Plan named for round {(p.rounds ?? [])[0].id.toString()}: <span className="vault-addr">{(p.rounds ?? [])[0].plan.slice(0, 14)}…{(p.rounds ?? [])[0].plan.slice(-8)}</span></p>}
              {hasCommits && commitsBody}
              {links}
            </div>
          </div>
        </section>

        <TestMoneyBanner />
      </div>
    );
  }

  return (
    <main className="vault">
      <header className="vault-head">
        <h1 className="vault-name">BASKET</h1>
        <p className="vault-lede">
          A vault built for an operator that would quote one budget across the reward pools of
          Gemini’s prediction markets. Depositors fund it. The contract caps what the operator may
          take, sets its deadline, and puts the operator’s own bond first in line for a loss. In
          this demo the operator is a stand-in that places no order anywhere.
        </p>
        {p.screenUrl != null && (
          <p className="vault-lede vault-try"><a className="vault-hash" href={p.screenUrl}>Try the operator’s allocator on invented markets</a></p>
        )}
        {who}
      </header>

      {alerts}

      {hold}

      {urgentBlock}
      {doneBlock}

      {stepBlock}

      <section className="vault-rounds" aria-label="rounds">
        <h2 className="vault-terms-head">Rounds</h2>
        {roundsBody}
      </section>

      <section className="vault-how" aria-label="how it works">
        <h2 className="vault-terms-head">How it works</h2>
        {howList}
      </section>

      <section className="vault-terms" aria-label="the vault's terms">
        <h2 className="vault-terms-head">The vault’s terms</h2>
        {termsList}
      </section>

      <section className="vault-commits" aria-label="commits">
        <h2 className="vault-terms-head">Commits</h2>
        {commitsBody}
      </section>

      {!urgent && !d.epoch.defaulted && quietDefault}

      {links}

      <TestMoneyBanner />
    </main>
  );
}

/** When the relayer serves a different chain than this page is set for, the plain error that names
 * both numbers; otherwise null. The page offers no step while this holds. */
export function chainMismatchError(want: number, got: number): string | null {
  if (want === got) return null;
  return `This page is set for chain ${want}, but the relayer serves chain ${got}. Point the page at the matching relayer.`;
}

/** The test-money banner, shown on every screen the app can render. */
export function TestMoneyBanner() {
  return <p className="vault-foot" role="note">{DEMO_NOTE}</p>;
}

/** The screen for a browser that cannot keep a wallet key. */
export function CannotKeepWallet({ error }: { error: string | null }) {
  return (
    <main className="vault">
      <h1 className="vault-name">BASKET</h1>
      <p className="error" role="alert">{error ?? "This browser cannot keep a wallet. Open the page in the phone's own browser, not a private tab."}</p>
      <TestMoneyBanner />
    </main>
  );
}

/** The screen while the vault is first being read, or when that read failed. */
export function Reading({ error }: { error: string | null }) {
  return (
    <main className="vault">
      <h1 className="vault-name">BASKET</h1>
      {error !== null ? <p className="error" role="alert">{error}</p> : <p className="vault-waiting">Reading the vault…</p>}
      <TestMoneyBanner />
    </main>
  );
}

const SENT = "Sent. It takes a moment to land.";

/** The container: wires one browser wallet, the relayer and a vault reader together, works out the
 * one next step and runs it. */
export function VaultApp({ settings, site }: { settings: VaultSettings; site?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [data, setData] = useState<VaultData | null>(null);
  const [vaultName, setVaultName] = useState<string | null>(null);
  const [forFees, setForFees] = useState<bigint>(0n);
  const [rounds, setRounds] = useState<Round[] | null>(null);

  // Made once, kept across renders: the wallet, the relayer client, the network reader and the device
  // id. The vault reader waits for the relayer's info to learn USDC's address (never hard-coded here).
  const kit = useRef<{ wallet: VaultWallet; api: RelayerApi; client: ReturnType<typeof createPublicClient>; device: string } | null>(null);
  const chainRef = useRef<VaultChain | null>(null);
  // The vault this page works with: the one in its settings, or, where the address carries
  // `?vault=<name>`, the relayer's vault of that name (so one page can show a second stage vault).
  const vaultRef = useRef<Address>(settings.vault);
  const usdcRef = useRef<Address | null>(null);
  // Why no wallet could be kept, held in a ref: setting state here, during render, would render
  // again and again until React gives the page up (a blank page where storage is blocked).
  const keyError = useRef<string | null>(null);
  if (kit.current === null) {
    try {
      const store = window.localStorage;
      const { wallet } = loadOrMakeKey(store, settings.chainId);
      const chainDef = defineChain({
        id: settings.chainId,
        name: "Arc test network",
        nativeCurrency: { name: "test dollar", symbol: "USDC", decimals: 6 },
        rpcUrls: { default: { http: [settings.rpc] } },
        // The widely deployed Multicall3, at the one address it has on every chain; its code was read on Arc's test network on 2026-11-18.
        contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
      });
      kit.current = {
        wallet,
        api: relayerApi(settings.relayer),
        // One reload is fifteen contract reads and a block. Sent apart, or as fifteen calls in one
        // request, the public node turned them back as over its rate (seen 2026-11-18): it counts each
        // call. Through Multicall3 the fifteen are one call, so a reload is two; nothing is tried again
        // on a refusal, since trying again is what keeps a phone over the rate.
        client: createPublicClient({ chain: chainDef, batch: { multicall: { wait: 20 } }, transport: http(settings.rpc, { batch: { wait: 20 }, retryCount: 0 }) }),
        device: deviceId(store),
      };
    } catch (e) {
      // A browser that cannot keep a key: the page says so and offers nothing.
      keyError.current = e instanceof Error ? e.message : String(e);
    }
  }

  const reload = useCallback(async () => {
    const k = kit.current;
    const chain = chainRef.current;
    if (k === null || chain === null) return;
    try {
      const d = await chain.read(k.wallet.address);
      setData(d);
      setError((prev) => (prev === "could not read the vault" ? null : prev));
    } catch {
      setError("could not read the vault");
    }
  }, []);

  useEffect(() => {
    const k = kit.current;
    if (k === null) return;
    let on = true;
    // Asked again at each timed read until it answers: a relayer that was down when the page
    // opened must not leave the page dead for good.
    const start = async () => {
      try {
        const info = await k.api.info();
        const mismatch = chainMismatchError(settings.chainId, info.chainId);
        if (mismatch !== null) {
          if (on) setError(mismatch);
          return; // a different chain: name both numbers and offer no step
        }
        setForFees(info.forFees);
        usdcRef.current = info.usdc;
        const asked = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("vault") : null;
        if (asked !== null && !/^[a-z][a-z0-9-]{0,30}$/.test(asked)) {
          if (on) setError("the address names no vault this page can open"); // never the build's own vault in its place (audit of the candidate)
          return;
        }
        const mine = asked !== null
          ? info.vaults.find((v) => v.name === asked)
          : info.vaults.find((v) => v.vault.toLowerCase() === settings.vault.toLowerCase());
        if (mine === undefined) {
          if (on) setError("this vault is not served by the relayer");
          return;
        }
        // Only a vault the relayer serves gets a chain reader: without one no data is read and no step is offered (audit round 2).
        vaultRef.current = mine.vault;
        chainRef.current = vaultChain({ reader: k.client, vault: mine.vault, usdc: info.usdc, chainId: settings.chainId });
        if (on) { setVaultName(mine.name); setError((prev) => (prev === "the relayer did not answer" ? null : prev)); }
      } catch (e) {
        if (on) setError(e instanceof NoAnswer ? "the relayer did not answer" : e instanceof Error ? e.message : String(e));
        return;
      }
      if (on) await reload();
    };
    void start();
    const read = setInterval(() => { if (document.hidden) return; if (chainRef.current === null) void start(); else void reload(); }, 12_000); // a page nobody is looking at asks nothing
    const tick = setInterval(() => { if (on) setNowSec(Math.floor(Date.now() / 1000)); }, 1_000);
    return () => { on = false; clearInterval(read); clearInterval(tick); };
  }, [reload, settings.vault]);

  /** The account's number and fees to sign with; tops the phone's fee money up first when it is low. */
  async function quoteWithFees(k: NonNullable<typeof kit.current>): Promise<Quote> {
    let acct = await k.api.account(k.wallet.address);
    // Low is half of the fee part, not the whole of it: a call was seen to cost about a fiftieth of it
    // on Arc's test network (2026-11-18), and asking at the whole part spent a top-up after two calls.
    // Half leaves room for what the node holds back for a call's gas when fees are high (audit of the candidate).
    if (acct.balance < forFees / 2n) {
      try {
        await k.api.topUp(k.wallet.address);
        acct = await k.api.account(k.wallet.address);
      } catch {
        // not-low, too-many, or no answer: go on with what the phone has.
      }
    }
    return { nonce: acct.nonce, maxFeePerGas: acct.maxFeePerGas, maxPriorityFeePerGas: acct.maxPriorityFeePerGas };
  }

  async function runStep(step: Step) {
    const k = kit.current;
    const chain = chainRef.current;
    const usdc = usdcRef.current;
    if (k === null || chain === null || usdc === null || data === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (step.kind === "handout") {
        await k.api.handout(k.wallet.address, k.device);
        setNotice("Funds added to your wallet.");
      } else {
        const call =
          step.kind === "approve" ? { to: usdc, data: chain.encodeApprove(vaultRef.current, step.amount ?? 0n) }
          : step.kind === "deposit" ? { to: vaultRef.current, data: chain.encodeDeposit(step.amount ?? 0n) }
          : step.kind === "ask" ? { to: vaultRef.current, data: chain.encodeRequestWithdraw(step.amount ?? 0n) }
          : step.kind === "claim" ? { to: vaultRef.current, data: chain.encodeClaim() }
          : null;
        if (call === null) return;
        const quote = await quoteWithFees(k);
        const raw: Hex = await chain.sign(k.wallet, call, quote);
        await k.api.relay(raw);
        setNotice(SENT);
      }
    } catch (e) {
      setError(e instanceof RelayerError ? e.sentence : e instanceof NoAnswer ? "the relayer did not answer" : e instanceof Error ? e.message : "something went wrong");
    } finally {
      // What was sent lands a few seconds later. The button stays held while the vault is read twice
      // more, so the step shown is the new one and the same step is not sent a second time (seen on
      // the public page, 2026-11-18: the old step stayed up until the next timed read).
      const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
      await pause(2_500);
      await reload();
      await pause(3_000);
      await reload();
      setNotice((prev) => (prev === SENT ? null : prev)); // it has had time to land and the figures above now show it
      setBusy(false);
    }
  }

  async function runDefault() {
    const k = kit.current;
    if (k === null || vaultName === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await k.api.declareDefault(vaultName);
      setNotice("Default declared. The bond moves to the vault.");
    } catch (e) {
      setError(e instanceof RelayerError ? e.sentence : e instanceof NoAnswer ? "the relayer did not answer" : "something went wrong");
    } finally {
      setBusy(false);
      await reload();
    }
  }

  // The countdown runs on the phone's clock and the button on the chain's last block: when the first
  // says the deadline has passed and the second has not caught up, the vault is read again every
  // four seconds rather than at the next timed read, so the button is not left dead beside the words.
  // This effect stands above the early returns below: a hook after them is not called on the first
  // renders, and React then refuses the page (the blank page of `front:v11`).
  const lagging = data !== null && data.epoch.open && !canDeclareDefault(data) && nowSec > Number(data.epoch.deadline);
  useEffect(() => {
    if (lagging && nowSec % 4 === 0) void reload();
  }, [lagging, nowSec, reload]);

  // The recent rounds are read when the page first has the vault and again whenever a round opens
  // or ends: one request each time, not one at every timed read. A refusal leaves the last list up.
  const headRef = useRef<bigint | null>(null);
  headRef.current = data?.blockNumber ?? headRef.current;
  const roundKey = data === null ? null : data.epoch.id.toString() + (data.epoch.open ? "o" : "c") + (data.epoch.defaulted ? "d" : "");
  const epochSeconds = data?.epochSeconds ?? null;
  useEffect(() => {
    const k = kit.current;
    if (k === null || roundKey === null || epochSeconds === null) return;
    let on = true;
    // Asked a moment after the vault's own read, and again if the node turns it back as over its
    // rate (seen on the public page, 2026-11-20: asked in the same instant, it was refused).
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    void (async () => {
      for (const wait of [1_500, 4_000, 9_000, 20_000]) {
        await pause(wait);
        if (!on) return;
        try {
          const r = await readRounds(k.client, vaultRef.current, epochSeconds, headRef.current ?? undefined);
          if (on) setRounds(r);
          // Once more a little later, with a newer block: a read that reached a node a block or
          // two behind can stop short of the round that just closed.
          await pause(15_000);
          if (!on) return;
          const again = await readRounds(k.client, vaultRef.current, epochSeconds, headRef.current ?? undefined);
          if (on) setRounds(again);
          return;
        } catch {
          // try again after the next, longer wait
        }
      }
    })();
    return () => { on = false; };
  }, [roundKey, epochSeconds]);

  if (site === true && (kit.current === null || data === null)) {
    // On the one-page site the vault's part keeps its place and heading while it is read, or says why it cannot be.
    const why = kit.current === null ? (keyError.current ?? error ?? "This browser cannot keep a wallet. Open the page in the phone's own browser, not a private tab.") : error;
    return (
      <div className="vault vault-site">
        <section id="fund" className="site-section" aria-labelledby="fund-h">
          <h2 id="fund-h" className="site-h">2. Fund the vault</h2>
          {why !== null ? <p className="error" role="alert">{why}</p> : <p className="vault-waiting">Reading the vault…</p>}
        </section>
        {/* Steps three and four keep their places, so the step bar's links always land somewhere. */}
        <section id="rounds" className="site-section" aria-labelledby="rounds-h">
          <h2 id="rounds-h" className="site-h">3. Watch a round</h2>
          <p className="vault-waiting">{why !== null ? "Shown once the vault can be read." : "Reading the vault…"}</p>
        </section>
        <section id="safety" className="site-section" aria-labelledby="safety-h">
          <h2 id="safety-h" className="site-h">4. The safety net</h2>
          <p className="vault-waiting">{why !== null ? "Shown once the vault can be read." : "Reading the vault…"}</p>
        </section>
        <TestMoneyBanner />
      </div>
    );
  }
  if (kit.current === null) return <CannotKeepWallet error={keyError.current ?? error} />;
  if (data === null) return <Reading error={error} />;

  const stepInput: StepInput = {
    balance: data.balance, allowance: data.allowance, shares: data.shares, claimable: data.claimable, waiting: data.waiting,
    asked: data.asked, epoch: { id: data.epoch.id, open: data.epoch.open, defaulted: data.epoch.defaulted, deadline: data.epoch.deadline },
    room: data.room, forFees, nowSec,
  };
  const step = nextStep(stepInput);
  const deadlinePassed = canDeclareDefault(data);
  return (
    <VaultView
      vaultName={vaultName ?? ""} vaultAddress={vaultRef.current} address={kit.current.wallet.address} data={data} step={step} nowSec={nowSec}
      deadlinePassed={deadlinePassed} explorerBase={settings.explorer} busy={busy} error={error} notice={notice}
      onPrimary={() => void runStep(step)} onDeclareDefault={() => void runDefault()}
      rounds={rounds} roundEverySec={settings.roundEverySec ?? null} sourceUrl={settings.sourceUrl ?? null} screenUrl={settings.screenUrl ?? null} site={site}
    />
  );
}
