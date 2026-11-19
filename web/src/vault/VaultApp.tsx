// The vault's phone page. `VaultView` is pure markup — it draws the test-money banner, the phone's
// own address, what it holds, the one next step as a single primary button with its sentence, the
// quiet terms read from the chain, the commit log, and the declare-default control — so it is
// rendered and read in tests. `VaultApp` is the container: it makes the browser wallet, talks to
// the relayer and reads the vault, works out the one next step, and runs it.
//
// Word rules (his word of 2026-11-19, which replaces the house rule of 2026-11-18 for this page): the
// page reads as a product would, with amounts in dollars; that the money is test USDC with no real
// value and that a round closes with a simulated result is said once, small, at the foot of every
// screen (`DEMO_NOTE` in VaultApp.tsx). Still: no yearly rate, and nothing said to be earned or
// paid by an exchange. Deadlines are shown in the
// person's local time with the UTC time beside it.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";

import { relayerApi, NoAnswer, RelayerError, type RelayerApi } from "./api.ts";
import { vaultChain, type Quote, type VaultChain, type VaultData } from "./chain.ts";
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
 * (his word, 2026-11-19: a small note at the bottom, the rest as a product would read). */
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
};

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
  return (
    <main className="vault">
      <header className="vault-head">
        <h1 className="vault-name">BASKET</h1>
        <p className="vault-who">{p.vaultName !== "" && <>Vault: <span className="vault-addr">{p.vaultName}</span> · </>}Wallet: <span className="vault-addr">{short(p.address)}</span></p>
      </header>

      {p.error !== null && <p className="error" role="alert">{p.error}</p>}
      {p.notice !== null && <p className="vault-notice" role="status">{p.notice}</p>}

      <section className="vault-hold" aria-label="what you hold">
        <p className="vault-figure f1"><span className="vault-amount">${fmtUsd(d.worth)}</span> <span className="vault-amount-of">in the vault</span></p>
        {d.claimable > 0n && <p className="vault-figure">Ready to claim: ${fmtUsd(d.claimable)}</p>}
        {d.waiting > 0n && <p className="vault-figure">Waiting in this round: ${fmtUsd(d.waiting)} (becomes shares at the round’s end)</p>}
        {d.epoch.open && d.epoch.drawn > 0n && (
          <p className="vault-figure vault-out">Out with the operator this round: ${fmtUsd(d.epoch.drawn)} of the vault’s. The figure above leaves it out until the round ends; the bond stands behind it.</p>
        )}
        <p className="vault-figure f3">In your wallet: ${fmtUsd(d.balance)}</p>
      </section>

      {urgent && (
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
      )}
      {d.epoch.defaulted && (
        <section className="vault-default vault-default-done" aria-label="the operator is in default">
          <h2 className="vault-terms-head">The operator is in default</h2>
          <p className="vault-figure">
            A default was declared in round {d.epoch.id.toString()}. The operator’s whole bond moved
            to the vault for depositors, and the vault is closed: nothing more can be deposited, and
            what you hold can be withdrawn.
          </p>
        </section>
      )}

      <section className="vault-step" aria-label="your next step">
        <p className="vault-step-sentence">{p.step.sentence}</p>
        {label !== null && (
          <button type="button" className="vault-primary" data-primary="" disabled={p.busy} onClick={p.onPrimary}>
            {p.busy ? "Working…" : label}
          </button>
        )}
      </section>

      <section className="vault-terms" aria-label="the vault's terms">
        <h2 className="vault-terms-head">The vault’s terms</h2>
        <dl className="vault-terms-list">
          <dt>Draw limit</dt>
          <dd>${fmtUsd(d.maxDraw)}, the most the operator may draw for one round</dd>
          <dt>Bond</dt>
          <dd>${fmtUsd(d.bond)} posted by the operator, first to take a loss</dd>
          <dt>Cap</dt>
          <dd>${fmtUsd(d.cap)} in all (${fmtUsd(d.room)} of room left)</dd>
          <dt>Round length</dt>
          <dd>{d.epochSeconds.toString()} seconds{d.epoch.open ? ", " + timeLeft(d.epoch.deadline, p.nowSec) : ", no round open now"}</dd>
          {d.epoch.open && (
            <>
              <dt>This round ends</dt>
              <dd>{whenLocalUtc(d.epoch.deadline)}</dd>
            </>
          )}
          <dt>Fee on a gain</dt>
          <dd>{feePct}% of any gain goes to the operator; the rest stays with the vault</dd>
        </dl>
      </section>

      <section className="vault-commits" aria-label="commits">
        <h2 className="vault-terms-head">Commits</h2>
        {hasCommits ? (
          <p className="vault-figure">
            {d.commits.toString()} so far. Last hash:{" "}
            <a className="vault-hash" href={p.explorerBase + "/address/" + p.vaultAddress} target="_blank" rel="noreferrer">
              {d.head.slice(0, 10)}…{d.head.slice(-6)}
            </a>
          </p>
        ) : (
          <p className="vault-figure">No commits yet.</p>
        )}
      </section>

      {!urgent && !d.epoch.defaulted && quietDefault}

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

/** The container: wires one browser wallet, the relayer and a vault reader together, works out the
 * one next step and runs it. */
export function VaultApp({ settings }: { settings: VaultSettings }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [data, setData] = useState<VaultData | null>(null);
  const [vaultName, setVaultName] = useState<string | null>(null);
  const [forFees, setForFees] = useState<bigint>(0n);

  // Made once, kept across renders: the wallet, the relayer client, the network reader and the device
  // id. The vault reader waits for the relayer's info to learn USDC's address (never hard-coded here).
  const kit = useRef<{ wallet: VaultWallet; api: RelayerApi; client: ReturnType<typeof createPublicClient>; device: string } | null>(null);
  const chainRef = useRef<VaultChain | null>(null);
  // The vault this page works with: the one in its settings, or, where the address carries
  // `?vault=<name>`, the relayer's vault of that name (so one page can show a second stage vault).
  const vaultRef = useRef<Address>(settings.vault);
  const usdcRef = useRef<Address | null>(null);
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
      setError(e instanceof Error ? e.message : String(e));
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
    void (async () => {
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
        if (on) setVaultName(mine.name);
      } catch (e) {
        if (on) setError(e instanceof NoAnswer ? "the relayer did not answer" : e instanceof Error ? e.message : String(e));
        return;
      }
      if (on) await reload();
    })();
    const read = setInterval(() => { if (!document.hidden) void reload(); }, 12_000); // a page nobody is looking at asks nothing
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
        setNotice("Sent. It takes a moment to land.");
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

  if (kit.current === null) return <CannotKeepWallet error={error} />;
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
    />
  );
}
