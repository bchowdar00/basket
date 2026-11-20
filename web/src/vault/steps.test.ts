// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";

import { fmtUsd, nextStep, type StepInput } from "./steps.ts";

const USD = 1_000_000n;
const FOR_FEES = 5n * USD;

// A base input: a handed phone with the handout split still whole, no shares, no epoch.
function base(over: Partial<StepInput> = {}): StepInput {
  return {
    balance: 0n,
    allowance: 0n,
    shares: 0n,
    claimable: 0n,
    waiting: 0n,
    asked: { shares: 0n, epoch: 0n },
    epoch: { id: 0n, open: false, defaulted: false, deadline: 0n },
    room: 1_000_000n * USD,
    forFees: FOR_FEES,
    nowSec: 1_000,
    ...over,
  };
}

test("fmtUsd writes six-decimal units as plain dollars-and-cents with no sign for a currency", () => {
  expect(fmtUsd(0n)).toBe("0.00");
  expect(fmtUsd(50n * USD)).toBe("50.00");
  expect(fmtUsd(1_234n * USD + 560_000n)).toBe("1,234.56");
  expect(fmtUsd(1n)).toBe("0.00"); // one unit rounds down below a cent
});

test("a phone with nothing is offered funds", () => {
  const step = nextStep(base());
  expect(step.kind).toBe("handout");
  expect(step.sentence).toBe("Add funds to your wallet to start.");
});

test("a handed phone that has not allowed the vault is offered the allowance, capped by keeping the fee part back", () => {
  const step = nextStep(base({ balance: 55n * USD })); // 50 to deposit + 5 fees
  expect(step.kind).toBe("approve");
  expect(step.amount).toBe(50n * USD);
  expect(step.sentence).toContain("$50.00");
});

test("once the allowance covers the deposit, the deposit is offered and keeps the fee part back", () => {
  const step = nextStep(base({ balance: 55n * USD, allowance: 50n * USD }));
  expect(step.kind).toBe("deposit");
  expect(step.amount).toBe(50n * USD);
  expect(step.sentence).toContain("$50.00");
  expect(step.sentence.toLowerCase()).toContain("fee");
});

test("the cap limits how much is offered to deposit", () => {
  const step = nextStep(base({ balance: 1_000n * USD, allowance: 1_000n * USD, room: 7n * USD }));
  expect(step.kind).toBe("deposit");
  expect(step.amount).toBe(7n * USD);
});

test("when the balance is only the fee part, nothing is offered to deposit", () => {
  // shares held, no epoch: the next step is to ask to withdraw, not to deposit
  const step = nextStep(base({ balance: FOR_FEES, shares: 10n * USD * USD }));
  expect(step.kind).toBe("ask");
});

test("a sub-fee amount left after a fee is fee money, not a deposit, so the step is to withdraw", () => {
  // Reproduced: balance 1.99 with forFees 1 and shares held, no withdrawal pending. The old rule
  // kept exactly the fee part back and offered the 0.99 remainder as a deposit; the rule now is that
  // a deposit is offered only when the depositable amount is at least the fee money.
  const step = nextStep(base({ balance: 1_990_000n, forFees: 1n * USD, shares: 1n * USD * USD }));
  expect(step.kind).toBe("ask");
});

test("a balance just after a handout still offers the deposit part", () => {
  const step = nextStep(base({ balance: 55n * USD })); // 50 to deposit + 5 fees, depositable 50 >= 5
  expect(step.kind).toBe("approve");
  expect(step.amount).toBe(50n * USD);
  const next = nextStep(base({ balance: 55n * USD, allowance: 50n * USD }));
  expect(next.kind).toBe("deposit");
  expect(next.amount).toBe(50n * USD);
});

test("a balance of exactly twice the fee money deposits one fee part's worth", () => {
  const step = nextStep(base({ balance: 2n * FOR_FEES, allowance: 2n * FOR_FEES }));
  expect(step.kind).toBe("deposit");
  expect(step.amount).toBe(FOR_FEES); // 2*forFees - forFees = forFees, which is >= forFees
});

test("a balance one unit under twice the fee money offers no deposit and nothing else to do", () => {
  // depositable = (2*forFees - 1) - forFees = forFees - 1, below the fee money, so no deposit; with
  // no shares and nothing in the vault, the step is done.
  const step = nextStep(base({ balance: 2n * FOR_FEES - 1n }));
  expect(step.kind).not.toBe("approve");
  expect(step.kind).not.toBe("deposit");
  expect(step.kind).toBe("done");
});

test("holding shares with no epoch open, the step is to withdraw now", () => {
  const step = nextStep(base({ balance: FOR_FEES, shares: 12n * USD * USD, epoch: { id: 3n, open: false, defaulted: false, deadline: 0n } }));
  expect(step.kind).toBe("ask");
  expect(step.amount).toBe(12n * USD * USD);
  expect(step.sentence.toLowerCase()).toContain("now");
});

test("holding shares with an epoch open, the ask settles when the round ends", () => {
  const step = nextStep(base({ balance: FOR_FEES, shares: 9n * USD * USD, epoch: { id: 4n, open: true, defaulted: false, deadline: 2_000n } }));
  expect(step.kind).toBe("ask");
  expect(step.sentence.toLowerCase()).toContain("round");
});

test("money ready to claim comes before everything else", () => {
  const step = nextStep(base({ balance: 55n * USD, allowance: 50n * USD, claimable: 3n * USD, shares: 5n * USD * USD }));
  expect(step.kind).toBe("claim");
  expect(step.amount).toBe(3n * USD);
  expect(step.sentence).toContain("$3.00");
});

test("an asked withdrawal still in the open epoch is a wait, not a new action", () => {
  const step = nextStep(base({
    balance: FOR_FEES, shares: 0n,
    asked: { shares: 4n * USD * USD, epoch: 6n },
    epoch: { id: 6n, open: true, defaulted: false, deadline: 2_000n },
  }));
  expect(step.kind).toBe("waiting");
  expect(step.sentence.toLowerCase()).toContain("withdrawal");
});

test("a wait says so when the round's deadline has already passed", () => {
  const step = nextStep(base({
    shares: 0n, nowSec: 5_000,
    asked: { shares: 4n * USD * USD, epoch: 6n },
    epoch: { id: 6n, open: true, defaulted: false, deadline: 2_000n },
  }));
  expect(step.kind).toBe("waiting");
  expect(step.sentence.toLowerCase()).toContain("deadline");
});

test("a deposit waiting in the open epoch is a wait that becomes shares at the round's end", () => {
  const step = nextStep(base({ balance: FOR_FEES, waiting: 8n * USD, epoch: { id: 7n, open: true, defaulted: false, deadline: 2_000n } }));
  expect(step.kind).toBe("waiting");
  expect(step.sentence.toLowerCase()).toContain("deposit");
});

test("after a default, money to claim is claimed first, then the remaining shares are withdrawn now", () => {
  const claim = nextStep(base({ claimable: 60n * USD, epoch: { id: 2n, open: false, defaulted: true, deadline: 0n } }));
  expect(claim.kind).toBe("claim");
  const ask = nextStep(base({ balance: FOR_FEES, shares: 20n * USD * USD, epoch: { id: 2n, open: false, defaulted: true, deadline: 0n } }));
  expect(ask.kind).toBe("ask");
  expect(ask.sentence.toLowerCase()).toContain("now");
});

test("a handed phone with only its fee part and nothing in the vault has nothing to do", () => {
  const step = nextStep(base({ balance: FOR_FEES }));
  expect(step.kind).toBe("done");
});

test("no sentence breaks the house word rules", () => {
  const inputs: StepInput[] = [
    base(),
    base({ balance: 55n * USD }),
    base({ balance: 55n * USD, allowance: 50n * USD }),
    base({ balance: FOR_FEES, shares: 10n * USD * USD, epoch: { id: 1n, open: true, defaulted: false, deadline: 9n } }),
    base({ balance: FOR_FEES, shares: 10n * USD * USD }),
    base({ claimable: 3n * USD }),
    base({ shares: 0n, asked: { shares: 1n, epoch: 1n }, epoch: { id: 1n, open: true, defaulted: false, deadline: 9n } }),
    base({ waiting: 8n * USD, epoch: { id: 1n, open: true, defaulted: false, deadline: 9n } }),
    base({ balance: FOR_FEES }),
  ];
  for (const inp of inputs) {
    // The banned phrases are enforced across every file of web/ by src/words.test.ts, so they are
    // not restated here as literals (that would trip that scanner on this test file). Here: no
    // bare "USDC", nothing earned, and (decided 2026-11-19) no "test dollars" or "simulated"
    // in a step: the page says both once, at its foot.
    const s = nextStep(inp).sentence;
    expect(s, s).not.toMatch(/\bUSDC\b/);
    expect(s.toLowerCase(), s).not.toContain("earned");
    expect(s.toLowerCase(), s).not.toContain("per year");
    expect(s, s).not.toContain("test dollars");
    expect(s, s).not.toContain("simulated");
  }
});

// Audit round 2: the test dollars are handed out once, so the last step never offers more of them.
test("the last step says why nothing is offered, and never offers more funds", () => {
  const small = nextStep(base({ balance: 2n * FOR_FEES - 1n }));
  const full = nextStep(base({ balance: 100n * USD, room: 0n }));
  const tight = nextStep(base({ balance: 100n * USD, room: FOR_FEES - 1n }));
  const ended = nextStep(base({ balance: 100n * USD, epoch: { id: 1n, open: false, defaulted: true, deadline: 0n } }));
  for (const s of [small, full, tight, ended]) {
    expect(s.kind).toBe("done");
    expect(s.sentence).not.toMatch(/get more/i);
  }
  expect(small.sentence).toMatch(/under the smallest deposit/);
  expect(nextStep(base({ epoch: { id: 1n, open: false, defaulted: true, deadline: 0n } })).kind).toBe("done"); // an ended vault hands nothing out
  expect(nextStep(base({ asked: { shares: 1n, epoch: 0n }, epoch: { id: 1n, open: false, defaulted: false, deadline: 0n } })).sentence).toBe("Nothing to do right now. Your wallet is empty.");
  expect(full.sentence).toMatch(/vault is full/);
  expect(tight.sentence).toMatch(/room for less than the smallest deposit/);
  expect(ended.sentence).toMatch(/has ended/);
});

// Review of 2026-11-19: a round left open past its deadline took a fresh wallet's handout and deposit.
test("a round open past its deadline is offered no funds, no allowance and no deposit", () => {
  const late = { id: 1n, open: true, defaulted: false, deadline: 900n }; // nowSec is 1,000
  const fresh = nextStep(base({ epoch: late }));
  expect(fresh.kind).toBe("waiting");
  expect(fresh.sentence).toBe("This round is past its deadline. Nothing can be deposited until it is settled or a default is declared.");
  const funded = nextStep(base({ epoch: late, balance: 55n * USD }));
  expect(funded.kind).toBe("waiting");
  const allowed = nextStep(base({ epoch: late, balance: 55n * USD, allowance: 50n * USD }));
  expect(allowed.kind).toBe("waiting");
});

test("a round open before its deadline still takes a deposit, and a holder past the deadline can still ask to withdraw", () => {
  const inTime = nextStep(base({ epoch: { id: 1n, open: true, defaulted: false, deadline: 2_000n }, balance: 55n * USD, allowance: 50n * USD }));
  expect(inTime.kind).toBe("deposit");
  const holder = nextStep(base({ epoch: { id: 1n, open: true, defaulted: false, deadline: 900n }, shares: 10n }));
  expect(holder.kind).toBe("ask");
});
