// Every value in this file is invented. None is a reading of any chain or market.
//
// A page for looking at the phone view in each of its states without a relayer or a chain: the dev
// server serves it at /states.html?s=<name>. The public build (vite.public.config.ts) takes
// vault.html alone, so this is never shipped.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Hex } from "viem";

import "../ui/weave.css";
import "./vault.css";
import type { VaultData } from "./chain.ts";
import { nextStep } from "./steps.ts";
import { VaultView } from "./VaultApp.tsx";

const USD = 1_000_000n;
const ZERO: Hex = ("0x" + "0".repeat(64)) as Hex;
const PLAN: Hex = ("0x" + "ab".repeat(32)) as Hex;
const NOW = 1_800_000_000;

const base: VaultData = {
  shares: 0n, worth: 0n, claimable: 0n, waiting: 0n, asked: { shares: 0n, epoch: 0n },
  epoch: { id: 1n, open: false, defaulted: false, plan: ZERO, drawn: 0n, deadline: 0n },
  byBond: 4_500_000n, byVault: 750_000n, maxDraw: 750_000n, bond: 3n * USD, cap: 100n * USD, room: 98n * USD,
  epochSeconds: 60n, gainBps: 2000, commits: 2n, head: PLAN, balance: 0n, allowance: 0n, blockTimestamp: BigInt(NOW),
};
const held = { shares: 1_500_000_000_000n, worth: 1_500_000n, balance: 250_000n };
const open = { id: 2n, open: true, defaulted: false, plan: PLAN, drawn: 750_000n, deadline: BigInt(NOW + 42) };

const STATES: Record<string, { d: VaultData; passed?: boolean; busy?: boolean; error?: string; notice?: string }> = {
  fresh: { d: base },
  funded: { d: { ...base, balance: 1_250_000n } },
  holding: { d: { ...base, ...held }, notice: "Deposited. The vault holds it from the next round." },
  open: { d: { ...base, ...held, worth: 750_000n, epoch: open } },
  missed: { d: { ...base, ...held, worth: 750_000n, epoch: { ...open, deadline: BigInt(NOW - 20) } }, passed: true },
  defaulted: { d: { ...base, ...held, worth: 3_750_000n, bond: 0n, epoch: { ...open, open: false, defaulted: true } } },
  busy: { d: { ...base, balance: 1_250_000n }, busy: true },
  error: { d: { ...base, balance: 1_250_000n }, error: "The relayer could not tell whether the last send went out. Wait a minute, then look again before pressing anything." },
};

const name = new URLSearchParams(location.search).get("s") ?? "fresh";
const s = STATES[name] ?? STATES.fresh;
const d = s.d;
const step = nextStep({
  balance: d.balance, allowance: d.allowance, shares: d.shares, claimable: d.claimable, waiting: d.waiting, asked: d.asked,
  epoch: { id: d.epoch.id, open: d.epoch.open, defaulted: d.epoch.defaulted, deadline: d.epoch.deadline }, room: d.room, forFees: 250_000n, nowSec: NOW,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VaultView
      vaultName="stage" vaultAddress="0x00000000000000000000000000000000000000b2" address="0x00000000000000000000000000000000000000a1"
      data={d} step={step} nowSec={NOW} deadlinePassed={s.passed === true} explorerBase="https://explorer.testnet.arc.io"
      busy={s.busy === true} error={s.error ?? null} notice={s.notice ?? null} onPrimary={() => {}} onDeclareDefault={() => {}}
    />
  </StrictMode>,
);
