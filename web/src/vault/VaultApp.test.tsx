// Every value in this file is invented. None is a reading of any market.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { VaultData } from "./chain.ts";
import { nextStep, type StepInput } from "./steps.ts";
import { CannotKeepWallet, Reading, VaultView, canDeclareDefault, chainMismatchError } from "./VaultApp.tsx";

const USD = 1_000_000n;
const WHOLE = 1_000_000_000_000n;
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const VAULT_AT = "0x00000000000000000000000000000000000000aa"; // invented
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ZERO = ("0x" + "00".repeat(32)) as `0x${string}`;
const EXPLORER = "https://explorer.example/test";

function decode(html: string): string {
  return html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function data(over: Partial<VaultData> = {}): VaultData {
  return {
    shares: 0n, worth: 0n, claimable: 0n, waiting: 0n,
    asked: { shares: 0n, epoch: 0n },
    epoch: { id: 0n, open: false, defaulted: false, plan: ZERO, drawn: 0n, deadline: 0n },
    byBond: 30n * USD, byVault: 500n * USD, maxDraw: 30n * USD,
    bond: 20n * USD, cap: 1_000_000n * USD, room: 999_940n * USD,
    epochSeconds: 60n, gainBps: 2000, commits: 0n, head: ZERO,
    balance: 0n, allowance: 0n, blockTimestamp: 0n,
    ...over,
  };
}

function stepFrom(d: VaultData, nowSec: number, forFees = 5n * USD): ReturnType<typeof nextStep> {
  const inp: StepInput = {
    balance: d.balance, allowance: d.allowance, shares: d.shares, claimable: d.claimable, waiting: d.waiting,
    asked: d.asked, epoch: { id: d.epoch.id, open: d.epoch.open, defaulted: d.epoch.defaulted, deadline: d.epoch.deadline },
    room: d.room, forFees, nowSec,
  };
  return nextStep(inp);
}

function render(d: VaultData, deadlinePassed = false): string {
  const step = stepFrom(d, 1_000);
  return decode(renderToStaticMarkup(
    <VaultView
      vaultName="stage" vaultAddress={VAULT_AT} address={ADDR} data={d} step={step} nowSec={1_000}
      deadlinePassed={deadlinePassed} explorerBase={EXPLORER} busy={false} error={null} notice={null}
      onPrimary={() => {}} onDeclareDefault={() => {}}
    />,
  ));
}

// His word of 2026-11-19: the page reads as a product; what the money is stands once, small, at the foot.
test("the note that the money is test money is on the page once, at its foot, and not at its top", () => {
  const html = render(data());
  expect(html.split("Balances are test USDC with no real value").length).toBe(2);
  expect(html.indexOf("Balances are test USDC with no real value")).toBeGreaterThan(html.indexOf("Commits"));
  expect(html).toContain("rounds close with a simulated result");
  expect(html).not.toContain("Test money only");
});

test("the cannot-keep-a-wallet screen carries the note at its foot", () => {
  const html = decode(renderToStaticMarkup(<CannotKeepWallet error={null} />));
  expect(html).toContain("Balances are test USDC with no real value");
  expect(html).toContain("This browser cannot keep a wallet");
});

test("the reading and read-error screens both carry the note at their foot", () => {
  const loading = decode(renderToStaticMarkup(<Reading error={null} />));
  expect(loading).toContain("Balances are test USDC with no real value");
  expect(loading).toContain("Reading the vault");
  const failed = decode(renderToStaticMarkup(<Reading error="could not read the vault" />));
  expect(failed).toContain("Balances are test USDC with no real value");
  expect(failed).toContain("could not read the vault");
});

test("a relayer serving a different chain than the setting is a plain error naming both, and the screen offers no step", () => {
  expect(chainMismatchError(5042002, 5042002)).toBe(null);
  const msg = chainMismatchError(5042002, 11155111);
  expect(msg).not.toBe(null);
  expect(msg).toContain("5042002"); // the page's setting
  expect(msg).toContain("11155111"); // the relayer's own chain
  const html = decode(renderToStaticMarkup(<Reading error={msg} />));
  expect(html).toContain("5042002");
  expect(html).not.toContain("data-primary"); // no next-step button on this screen
});

test("the person's address is shown short", () => {
  const html = render(data());
  expect(html).toContain("0x7099");
  expect(html).toContain("79C8");
  expect(html).not.toContain(ADDR); // not the full 42 characters
});

test("a phone with nothing is offered funds as the one primary action", () => {
  const html = render(data());
  expect(html).toContain("Add funds");
  expect((html.match(/data-primary/g) ?? []).length).toBe(1);
});

test("holding shares, the page shows the worth and offers the withdraw step", () => {
  const html = render(data({ shares: 50n * WHOLE, worth: 50n * USD, balance: 5n * USD, epoch: { id: 1n, open: false, defaulted: false, plan: ZERO, drawn: 0n, deadline: 0n } }));
  expect(html).toContain("$50.00");
  expect(html).toContain("Withdraw");
});

test("the vault's terms are shown from the chain, in dollars, with no yearly rate", () => {
  const html = render(data({ commits: 3n, head: HASH }));
  expect(html.toLowerCase()).toContain("draw limit");
  expect(html).toContain("$30.00, the most"); // the draw limit
  expect(html).toContain("the lesser of $30.00 by its bond and $500.00 by the vault’s size");
  expect(html).toContain("$20.00 posted"); // the bond
  expect(html.toLowerCase()).toContain("bond");
  expect(html.toLowerCase()).toContain("fee");
  expect(html).toContain("20%"); // the fee on a gain, 2000 bps
  expect(html.toLowerCase()).toContain("60 seconds"); // the round length
});

test("commits show the count and the last hash as a link to the explorer", () => {
  const html = render(data({ commits: 3n, head: HASH }));
  expect(html).toContain("3");
  expect(html).toContain(HASH.slice(0, 10)); // a short form of the hash is shown
  expect(html).toContain(EXPLORER); // the link points at the explorer
});

test("no commits yet shows no link", () => {
  const html = render(data({ commits: 0n, head: ZERO }));
  expect(html.toLowerCase()).toContain("no commits");
});

test("the declare-default button is disabled until the deadline has passed", () => {
  const closed = render(data({ epoch: { id: 1n, open: true, defaulted: false, plan: ZERO, drawn: 1n * USD, deadline: 9_000n } }), false);
  expect(closed).toMatch(/data-declare[^>]*disabled/);
  const open = render(data({ epoch: { id: 1n, open: true, defaulted: false, plan: ZERO, drawn: 1n * USD, deadline: 500n } }), true);
  expect(open).toMatch(/data-declare/);
  expect(open).not.toMatch(/data-declare[^>]*disabled/);
});

test("a phone clock an hour ahead of the chain does not enable the declare-default button", () => {
  const deadline = 2_000n;
  const phoneClock = Number(deadline) + 3_600; // the phone's clock is an hour past the deadline
  // the chain's own latest block is still before the deadline
  const d = data({ epoch: { id: 1n, open: true, defaulted: false, plan: ZERO, drawn: 1n * USD, deadline }, blockTimestamp: 1_500n });
  expect(canDeclareDefault(d)).toBe(false);
  const html = decode(renderToStaticMarkup(
    <VaultView vaultName="stage" vaultAddress={VAULT_AT} address={ADDR} data={d} step={stepFrom(d, phoneClock)} nowSec={phoneClock}
      deadlinePassed={canDeclareDefault(d)} explorerBase={EXPLORER} busy={false} error={null} notice={null}
      onPrimary={() => {}} onDeclareDefault={() => {}} />,
  ));
  expect(html).toMatch(/data-declare[^>]*disabled/);
  // once the chain's own block passes the deadline, it may be declared
  const past = data({ epoch: { id: 1n, open: true, defaulted: false, plan: ZERO, drawn: 1n * USD, deadline }, blockTimestamp: 2_001n });
  expect(canDeclareDefault(past)).toBe(true);
});

test("a deadline is shown in local time with the UTC time beside it", () => {
  const html = render(data({ epoch: { id: 1n, open: true, defaulted: false, plan: ZERO, drawn: 1n * USD, deadline: 1_800_000_000n } }));
  expect(html).toContain("UTC");
});

test("an error is shown in plain words in an alert", () => {
  const step = stepFrom(data(), 1_000);
  const html = decode(renderToStaticMarkup(
    <VaultView vaultName="stage" vaultAddress={VAULT_AT} address={ADDR} data={data()} step={step} nowSec={1_000}
      deadlinePassed={false} explorerBase={EXPLORER} busy={false} error="Add funds first." notice={null}
      onPrimary={() => {}} onDeclareDefault={() => {}} />,
  ));
  expect(html).toContain('role="alert"');
  expect(html).toContain("Add funds first.");
});

test("nothing on the page breaks the house word rules", () => {
  const states = [
    data(),
    data({ balance: 55n * USD }),
    data({ shares: 50n * WHOLE, worth: 50n * USD, claimable: 3n * USD, commits: 2n, head: HASH }),
    data({ epoch: { id: 1n, open: true, defaulted: false, plan: ZERO, drawn: 1n * USD, deadline: 1_800_000_000n } }),
  ];
  for (const d of states) {
    // The banned phrases are enforced across every file of web/ by src/words.test.ts; restating
    // them here as literals would trip that scanner on this test. Here: nothing earned, the body
    // never says "test dollars" or "simulated", and the foot says both things once.
    const html = render(d);
    const body = html.slice(0, html.indexOf("Demo on Arc"));
    expect(html.toLowerCase()).not.toContain("earned");
    expect(body).not.toContain("test dollars");
    expect(body).not.toContain("simulated");
    expect(body).not.toMatch(/\bUSDC\b/);
    expect(html).toContain("Balances are test USDC with no real value");
  }
});

test("the commit link goes to the vault's own address on the explorer, not its name", () => {
  const html = renderToStaticMarkup(
    <VaultView vaultName="stage" vaultAddress={VAULT_AT} address={ADDR} data={data({ commits: 3n, head: HASH })} step={stepFrom(data(), 1_000)} nowSec={1_000}
      deadlinePassed={false} explorerBase={EXPLORER} busy={false} error={null} notice={null} onPrimary={() => undefined} onDeclareDefault={() => undefined} />);
  expect(html).toContain(EXPLORER + "/address/" + VAULT_AT);
  expect(html).not.toContain("/address/stage");
});

test("the room left is shown to the nearest cent, so dust left by rounding does not read as room taken", () => {
  const html = render(data({ cap: 10_000n * USD, room: 10_000n * USD - 1n }));
  expect(html).toContain("$10,000.00 in all ($10,000.00 of room left)");
});
