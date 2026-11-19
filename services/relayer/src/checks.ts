// Reading a signed transaction and deciding whether the relayer may pass it on. Pure: no chain
// call and no store; everything it needs (the chain id, USDC's address, the served vaults, and
// whether a signer was handed dollars) is given to it. The relayer does the I/O around it.
import {
  decodeFunctionData, encodeFunctionData, isHex, parseAbi, parseTransaction, recoverTransactionAddress,
  type Address, type Hex,
} from "viem";

import { Refused } from "./refused.ts";

/** The only four calls the relayer passes on. */
const CALLS = parseAbi([
  "function deposit(uint256 amount)",
  "function requestWithdraw(uint256 shares)",
  "function claim()",
  "function approve(address spender, uint256 amount)",
]);
const GAS_MOST = 500_000n;

export type Checked = { signer: Address; to: Address; data: Hex };

export type CheckCtx = {
  chainId: number;
  usdc: Address;
  /** The served vaults' addresses, lower-cased. */
  vaults: ReadonlySet<string>;
  /** Was this signer handed test dollars? */
  handed: (who: Address) => boolean;
};

/**
 * Throws `Refused(403, "not-a-vault-call")` unless the transaction parses, is type 2 or a legacy
 * with this chain's id, moves no value, creates no contract, carries no access list, keeps its gas
 * under the most, and is exactly one of the four allowed calls to a served vault or to USDC.
 * Throws `Refused(403, "not-handed")` when the recovered signer was not handed dollars.
 */
export async function check(raw: unknown, ctx: CheckCtx): Promise<Checked> {
  const no = (): never => { throw new Refused(403, "not-a-vault-call"); };
  if (typeof raw !== "string" || !isHex(raw)) return no();

  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch {
    return no();
  }

  if (tx.type !== "eip1559" && tx.type !== "legacy") return no();
  if (typeof tx.chainId !== "number" || tx.chainId !== ctx.chainId) return no(); // a legacy tx with no chain id is refused here
  if ((tx.value ?? 0n) !== 0n) return no();
  if (!tx.to) return no(); // a contract creation has no recipient
  if ("accessList" in tx && Array.isArray(tx.accessList) && tx.accessList.length > 0) return no();
  if ((tx.gas ?? 0n) > GAS_MOST) return no();

  const data = (tx.data ?? "0x") as Hex;
  let signer: Address;
  try {
    signer = await recoverTransactionAddress({ serializedTransaction: raw });
  } catch {
    return no();
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof CALLS>>;
  try {
    decoded = decodeFunctionData({ abi: CALLS, data });
  } catch {
    return no();
  }
  const fn = decoded.functionName;
  // exactly the selector and the arguments' bytes, nothing after them
  if (encodeFunctionData({ abi: CALLS, functionName: fn, args: decoded.args } as never).toLowerCase() !== data.toLowerCase()) return no();

  const to = tx.to.toLowerCase();
  if (ctx.vaults.has(to)) {
    if (fn !== "deposit" && fn !== "requestWithdraw" && fn !== "claim") return no();
  } else if (to === ctx.usdc.toLowerCase()) {
    if (fn !== "approve") return no();
    const spender = String((decoded.args as readonly unknown[])[0]).toLowerCase();
    if (!ctx.vaults.has(spender)) return no(); // the vaults come from the deployment record, never from the request
  } else {
    return no();
  }

  if (!ctx.handed(signer)) throw new Refused(403, "not-handed");
  return { signer, to: tx.to as Address, data };
}
