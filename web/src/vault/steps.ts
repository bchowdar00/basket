// The heart of the vault page, kept pure: from what was read off the chain for one phone — its
// test-dollar balance, its allowance to the vault, its shares, what is ready to claim, a deposit
// still waiting in the open round, an asked withdrawal, the round's state and the time now — this
// gives the ONE next step to offer and the sentence that explains it. No chain call, no clock, no
// React: it reads only its argument, so it is tested exhaustively.
//
// Word rules (decided 2026-11-19, replacing the house rule of 2026-11-18 for this page): the
// page reads as a product would, with amounts in dollars; that the money is test USDC with no real
// value and that a round closes with a simulated result is said once, small, at the foot of every
// screen (`DEMO_NOTE` in VaultApp.tsx). Still: no yearly rate, and nothing said to be earned or
// paid by an exchange. The whole-of-web/
// scanner in src/words.test.ts enforces the banned phrases across every file, source and test.

/** The round, as the page needs it for the choice. `deadline` is unix seconds. */
export type EpochState = { id: bigint; open: boolean; defaulted: boolean; deadline: bigint };

/** Everything the choice reads, all for one phone, all in USDC's six-decimal units (shares in their
 * own twelve-decimal units). */
export type StepInput = {
  balance: bigint; // the phone's test-dollar balance
  allowance: bigint; // what the phone has allowed the vault to take
  shares: bigint; // shares held, after settling any credited deposit
  claimable: bigint; // test dollars the vault is holding for the phone, ready now
  waiting: bigint; // a deposit still waiting in the open round
  asked: { shares: bigint; epoch: bigint }; // an asked withdrawal, and the round it was asked in
  epoch: EpochState;
  room: bigint; // how much more the cap allows to be deposited
  forFees: bigint; // test dollars kept back to pay network fees
  nowSec: number; // the time now, unix seconds
};

export type StepKind = "handout" | "approve" | "deposit" | "ask" | "claim" | "waiting" | "done";

/** The one step: what kind, the sentence that explains it, and the amount a call needs (the test
 * dollars to allow or deposit, or the shares to withdraw). `claim`, `waiting` and `done` carry none. */
export type Step = { kind: StepKind; sentence: string; amount?: bigint };

/** Six-decimal units as plain dollars-and-cents, rounding down below a cent, grouped by thousands.
 * No currency sign: the caller writes it. */
export function fmtUsd(units: bigint): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const whole = u / 1_000_000n;
  const cents = ((u % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + "." + cents;
}

/** How much the phone can deposit now: its balance less the fee part it keeps back, never more than
 * the cap's remaining room. */
export function depositable(inp: StepInput): bigint {
  const free = inp.balance > inp.forFees ? inp.balance - inp.forFees : 0n;
  return free < inp.room ? free : inp.room;
}

export function nextStep(inp: StepInput): Step {
  // An asked withdrawal still sitting in the open round it was asked in: it is not yet claimable, so
  // the step is to wait, not to act again.
  const pendingAsk = inp.asked.shares > 0n && inp.asked.epoch === inp.epoch.id && inp.epoch.open;
  // A deposit (and the approve before it) is offered only when the depositable amount is at least the
  // fee money kept back: anything smaller is itself fee-sized and is never put up for deposit.
  const canDeposit = !inp.epoch.defaulted && depositable(inp) >= inp.forFees && depositable(inp) > 0n;

  // 1. Money ready to claim comes first: collect it before anything else.
  if (inp.claimable > 0n) {
    return { kind: "claim", amount: inp.claimable, sentence: `Claim $${fmtUsd(inp.claimable)} the vault is holding for you.` };
  }

  // 2. Test dollars in hand to put to work: allow the vault, then deposit.
  if (canDeposit) {
    const amount = depositable(inp);
    if (inp.allowance < amount) {
      return {
        kind: "approve",
        amount,
        sentence: `Allow the vault to take $${fmtUsd(amount)}.`,
      };
    }
    return {
      kind: "deposit",
      amount,
      sentence: `Deposit $${fmtUsd(amount)} into the vault. A little stays back to pay network fees.`,
    };
  }

  // 3. Shares held and no ask already in flight: offer to withdraw them.
  if (inp.shares > 0n && !pendingAsk) {
    const sentence = inp.epoch.open
      ? "Ask to withdraw all your shares. The request settles when the round ends."
      : "Withdraw all your shares now.";
    return { kind: "ask", amount: inp.shares, sentence };
  }

  // 4. Something is settling in the open round: a withdrawal asked, or a deposit waiting.
  if (pendingAsk) {
    const late = inp.nowSec > Number(inp.epoch.deadline);
    const tail = late ? " The round's deadline has passed." : "";
    return {
      kind: "waiting",
      sentence: `Your withdrawal is in. It settles when the round ends.${tail}`,
    };
  }
  if (inp.waiting > 0n) {
    return {
      kind: "waiting",
      sentence: `Your deposit of $${fmtUsd(inp.waiting)} is in this round. It becomes shares when the round ends.`,
    };
  }

  // 5. A phone with nothing anywhere: hand it test dollars to begin.
  if (!inp.epoch.defaulted && inp.balance === 0n && inp.shares === 0n && inp.claimable === 0n && inp.waiting === 0n && inp.asked.shares === 0n) {
    return { kind: "handout", sentence: "Add funds to your wallet to start." };
  }

  // 6. Nothing to offer: the phone holds only its fee part, or the vault has ended.
  // The test dollars are handed out once, so no sentence here offers more of them (audit round 2).
  if (inp.epoch.defaulted) return { kind: "done", sentence: "This vault has ended. Nothing more can be deposited." };
  const free = inp.balance > inp.forFees ? inp.balance - inp.forFees : 0n;
  if (free >= inp.forFees && inp.room === 0n) return { kind: "done", sentence: "The vault is full right now. Nothing more can be deposited until room opens." };
  if (free >= inp.forFees) return { kind: "done", sentence: "The vault has room for less than the smallest deposit right now." };
  if (inp.balance === 0n) return { kind: "done", sentence: "Nothing to do right now. Your wallet is empty." };
  return { kind: "done", sentence: "Nothing to do right now. What you hold is under the smallest deposit once network fees are kept back." };
}
