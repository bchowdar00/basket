// The vault's recent rounds, read from its own events: what the operator drew, what it sent back,
// and what that did for depositors. The public node answers eth_getLogs for at most 10,000 blocks
// (its own refusal, read 2026-11-20), so this is the recent rounds, not the whole history; the page
// says "recent". Nothing here is a posted value: every figure is an amount the contract moved.
import { parseAbi, type Address, type Hex, type PublicClient } from "viem";

const EVENTS = parseAbi([
  "event EpochStarted(uint256 indexed epochId, bytes32 plan, uint256 draw, uint64 deadline, uint256 bond, uint256 assets)",
  "event EpochClosed(uint256 indexed epochId, uint256 drawn, uint256 returned, uint256 fee, uint256 fromBond, uint256 assets, uint256 totalShares)",
  "event DefaultDeclared(uint256 indexed epochId, address indexed by, uint256 drawn, uint256 moved, uint256 assets, uint256 totalShares)",
]);

const SPAN = 9_990n; // blocks asked for, under the node's limit

export type Round = {
  id: bigint;
  startedAt: bigint; // unix seconds, from the deadline the contract set and the round's length
  plan: Hex;
  draw: bigint;
  assetsAtStart: bigint; // the depositors' assets when the round opened
  /** How it ended, or null while it is open. */
  end:
    | null
    | { kind: "closed"; returned: bigint; fee: bigint; fromBond: bigint; tx: Hex }
    | { kind: "default"; moved: bigint; tx: Hex };
};

export type RoundLog = { eventName: string; args: Record<string, unknown>; transactionHash: Hex | null };

/** Joins the events into rounds, newest first. A close or default whose start is older than the
 * blocks read is left out: without the start there is no draw or time to show beside it. */
export function joinRounds(logs: readonly RoundLog[], epochSeconds0: bigint | number): Round[] {
  // The round length is a uint32 on the contract, and viem hands a uint32 back as a number, not a
  // bigint: taken from a bigint it throws (the empty list on the public page, 2026-11-20).
  const epochSeconds = BigInt(epochSeconds0);
  const byId = new Map<string, Round>();
  const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(v as number));
  for (const l of logs) {
    if (l.eventName !== "EpochStarted") continue;
    const id = big(l.args.epochId);
    byId.set(id.toString(), {
      id, startedAt: big(l.args.deadline) - epochSeconds, plan: l.args.plan as Hex, draw: big(l.args.draw),
      assetsAtStart: big(l.args.assets) + big(l.args.draw), // the event carries the assets left after the draw
      end: null,
    });
  }
  for (const l of logs) {
    const r = byId.get(String(l.args.epochId));
    if (r === undefined || l.transactionHash === null) continue;
    if (l.eventName === "EpochClosed") r.end = { kind: "closed", returned: big(l.args.returned), fee: big(l.args.fee), fromBond: big(l.args.fromBond), tx: l.transactionHash };
    if (l.eventName === "DefaultDeclared") r.end = { kind: "default", moved: big(l.args.moved), tx: l.transactionHash };
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** What a closed round did for depositors, in USDC units: the gain after the operator's fee, or the
 * loss left after the bond paid its part (negative). */
export function depositorsResult(r: Round): bigint | null {
  if (r.end === null || r.end.kind !== "closed") return null;
  const e = r.end;
  return e.returned >= r.draw ? e.returned - r.draw - e.fee : -(r.draw - e.returned - e.fromBond);
}

/** A result as a signed percentage of the depositors' assets at the round's start, two decimals. */
export function pctOf(result: bigint, assets: bigint): string {
  if (assets <= 0n) return "";
  const neg = result < 0n;
  const bp100 = ((neg ? -result : result) * 1_000_000n) / assets; // hundredths of a basis point
  const hundredths = (bp100 + 50n) / 100n; // hundredths of a percent, rounded
  return (neg ? "−" : "+") + (hundredths / 100n).toString() + "." + (hundredths % 100n).toString().padStart(2, "0") + "%";
}

export type RoundsReader = Pick<PublicClient, "getBlockNumber" | "getContractEvents">;

/** `head` is the latest block's number when the caller already has it: the public node counts every
 * request against a rate, and one fewer is one less refusal. */
export async function readRounds(reader: RoundsReader, vault: Address, epochSeconds: bigint | number, head0?: bigint): Promise<Round[]> {
  const head = head0 ?? (await reader.getBlockNumber());
  const logs = await reader.getContractEvents({ address: vault, abi: EVENTS, fromBlock: head > SPAN ? head - SPAN : 0n, toBlock: head } as never);
  return joinRounds(logs as unknown as RoundLog[], epochSeconds);
}
