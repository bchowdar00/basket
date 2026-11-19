// The relayer's side of the chain: the USDC it reads and transfers for its own key, the
// `declareDefault()` it sends for a phone that asks, the dry run it does before passing a phone's
// own signed call on, and the raw send itself. The relayer's key is used only for the transfers
// and the default (routes 2, 3, 4); passing a signed transaction on (route 6) uses no key.
import {
  BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError, encodeFunctionData, parseAbi,
  type Account, type Address, type Chain as ViemChain, type Hex, type PublicClient, type Transport, type WalletClient,
} from "viem";

export type ChainAccount = { nonce: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; balance: bigint };

/** A transaction that was broadcast and then mined as a revert: its outcome is known, it failed on chain. */
export class Reverted extends Error {
  readonly hash: Hex;
  constructor(what: string, hash: Hex) {
    super(`${what} reverted: ${hash}`);
    this.name = "Reverted";
    this.hash = hash;
  }
}

/** A send the node never answered (a timeout, or the request itself failed): it may or may not have been broadcast. */
export class SendUnknown extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SendUnknown";
  }
}

/** What the relayer needs of the chain. A stand-in that counts calls stands in for this in tests. */
export type RelayerChain = {
  chainId: number;
  usdc: Address;
  relayer: Address;
  /** An address's USDC balance. */
  balanceOf(who: Address): Promise<bigint>;
  /** What a phone needs to sign a call: its next number, the chain's fees, and its balance. */
  account(who: Address): Promise<ChainAccount>;
  /**
   * One ERC-20 transfer of `amount` from the relayer to `to`. The send and the wait for its receipt
   * are separate: this resolves with the broadcast transaction's hash, throws `SendUnknown` if the node
   * never answered the send (it may have been broadcast), or throws another error if nothing was broadcast. `wait` then resolves on a mined success, throws `Reverted` if
   * it was mined as a revert, and throws any other error if the outcome is unknown (the wait threw).
   */
  transfer(to: Address, amount: bigint): Promise<{ hash: Hex; wait: () => Promise<void> }>;
  /** `declareDefault()` on a vault, tried as a dry run first. Throws with the contract's word if turned back. */
  tryDefault(vault: Address): Promise<Hex>;
  /** A dry run of a phone's own call. Throws with the chain's reason if it would be turned back. */
  dryRun(call: { from: Address; to: Address; data: Hex; value: bigint }): Promise<void>;
  /** Passes a signed transaction on. Uses no key. */
  sendRaw(raw: Hex): Promise<Hex>;
};

const ERC20 = parseAbi(["function balanceOf(address who) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);
// declareDefault plus the errors it can revert with, so viem decodes the revert to the name.
const VAULT = parseAbi(["function declareDefault()", "error NoEpoch()", "error NotYet()", "error Defaulted()"]);

/** The contract's own word for a refusal where there is one; otherwise the short form of the error. */
export function why(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? e.shortMessage;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export function relayerChain(a: {
  reader: Pick<PublicClient, "readContract" | "simulateContract" | "waitForTransactionReceipt" | "getTransactionCount" | "estimateFeesPerGas" | "call" | "sendRawTransaction">;
  wallet: WalletClient<Transport, ViemChain | undefined, Account>;
  chainId: number;
  usdc: Address;
}): RelayerChain {
  const relayer = a.wallet.account.address;
  const mined = async (hash: Hex, what: string): Promise<Hex> => {
    const receipt = await a.reader.waitForTransactionReceipt({ hash, timeout: 45_000 }); // held in the key's lane, so not for long
    if (receipt.status !== "success") throw new Error(`${what} was mined and failed: ${hash}`);
    return hash;
  };
  // Waits for a broadcast transfer's receipt, apart from the send. A revert is a known outcome
  // (`Reverted`); a wait that throws leaves the outcome unknown, so its error is passed up as-is.
  const confirmed = async (hash: Hex, what: string): Promise<void> => {
    let receipt;
    try {
      receipt = await a.reader.waitForTransactionReceipt({ hash });
    } catch (e) {
      throw new Error(why(e));
    }
    // Another transaction mined in this one's place (the same number): this one's outcome is not known from that receipt.
    if (receipt.transactionHash !== undefined && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error(`${what} was replaced: ${hash}`);
    if (receipt.status !== "success") throw new Reverted(what, hash);
  };
  return {
    chainId: a.chainId,
    usdc: a.usdc,
    relayer,
    balanceOf: (who) => a.reader.readContract({ address: a.usdc, abi: ERC20, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
    async account(who) {
      const nonce = await a.reader.getTransactionCount({ address: who, blockTag: "pending" });
      const fees = await a.reader.estimateFeesPerGas();
      const balance = (await a.reader.readContract({ address: a.usdc, abi: ERC20, functionName: "balanceOf", args: [who] })) as bigint;
      return { nonce: BigInt(nonce), maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n, balance };
    },
    async transfer(to, amount) {
      // Everything before the broadcast (the dry run, the number, the gas, the fees, the signature)
      // is in one block: a failure there, of any kind, means nothing was sent (audit round 3).
      let raw: Hex;
      try {
        await a.reader.simulateContract({ address: a.usdc, abi: ERC20, functionName: "transfer", args: [to, amount], account: a.wallet.account } as never);
        const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] });
        // The service's key is held here ("local"), so the transaction is signed here and only the
        // broadcast is left. An account the node holds (the local test chain's) cannot sign here: its
        // send is one request, and all of it is sorted below.
        raw = "0x";
        if (a.wallet.account.type === "local") {
          const prepared = await a.wallet.prepareTransactionRequest({ to: a.usdc, data, account: a.wallet.account, chain: a.wallet.chain } as never);
          raw = (await a.wallet.signTransaction(prepared as never)) as Hex;
        }
      } catch (e) {
        throw new Error(why(e));
      }
      let hash: Hex;
      try {
        hash = raw !== "0x"
          ? await a.wallet.sendRawTransaction({ serializedTransaction: raw })
          : await a.wallet.sendTransaction({ to: a.usdc, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }), account: a.wallet.account, chain: a.wallet.chain } as never);
      } catch (e) {
        // The node answering the broadcast with an error means it did not take it. No answer at all
        // (a timeout, a request that failed on the way) may be a transaction the node took: unknown.
        const noAnswer = e instanceof BaseError && e.walk((x) => x instanceof TimeoutError || x instanceof HttpRequestError) !== null;
        if (noAnswer) throw new SendUnknown(why(e));
        throw new Error(why(e));
      }
      return { hash, wait: () => confirmed(hash, "transfer") };
    },
    async tryDefault(vault) {
      try {
        const { request } = await a.reader.simulateContract({ address: vault, abi: VAULT, functionName: "declareDefault", account: a.wallet.account } as never);
        const tx = await a.wallet.writeContract(request as never);
        return await mined(tx, "declareDefault");
      } catch (e) {
        throw new Error(why(e));
      }
    },
    async dryRun(call) {
      try {
        await a.reader.call({ account: call.from, to: call.to, data: call.data, value: call.value } as never);
      } catch (e) {
        throw new Error(why(e));
      }
    },
    sendRaw: (raw) => a.reader.sendRawTransaction({ serializedTransaction: raw }),
  };
}
