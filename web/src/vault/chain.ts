// The phone reading the vault through viem's public client (the transport is injected, so the page
// gives it the network's RPC and a test gives it the local chain). It reads, for one phone, what it
// holds and what that is worth, the round's state and deadline, the vault's terms, and the commit
// log; and it builds and signs the four calls a phone sends itself (approve, deposit,
// requestWithdraw, claim), which the relayer then passes on. Nothing here signs the relayer's own
// work; the phone's key signs only its own calls.
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";

import type { VaultWallet } from "./wallet.ts";

const VS = 1_000_000n; // VIRTUAL_SHARES
const VA = 1n; // VIRTUAL_ASSETS
const DEFAULT_GAS = 400_000n; // under the relayer's 500,000 ceiling; the four calls are far smaller

/** The contract's `_toAssets`: test dollars paid for `shares` at a vault state of `assets`/`totalShares`,
 * priced through the virtual share and rounding down against the seller. The page's "worth now". */
export function assetsForShares(shares: bigint, assets: bigint, totalShares: bigint): bigint {
  return (shares * (assets + VA)) / (totalShares + VS);
}

/** Everything the page reads for one phone, all in six-decimal test-dollar units (shares in their own
 * twelve-decimal units). */
export type VaultData = {
  shares: bigint; // shares held after settling a credited deposit
  worth: bigint; // what those shares would pay now, at the virtual-share price (simulated)
  claimable: bigint; // test dollars the vault is holding for the phone, ready now
  waiting: bigint; // a deposit still waiting in the open round
  asked: { shares: bigint; epoch: bigint };
  epoch: { id: bigint; open: boolean; defaulted: boolean; plan: Hex; drawn: bigint; deadline: bigint };
  byBond: bigint;
  byVault: bigint;
  maxDraw: bigint;
  bond: bigint;
  cap: bigint;
  room: bigint;
  epochSeconds: bigint;
  gainBps: number;
  commits: bigint;
  head: Hex;
  balance: bigint; // the phone's test-dollar balance
  allowance: bigint; // what the phone has allowed the vault to take
  blockTimestamp: bigint; // the chain's own latest block time, unix seconds (never the phone's clock)
};

const VAULT_ABI = parseAbi([
  "function owed(address who) view returns (uint256 shares, uint256 claimable, uint256 waiting)",
  "function epoch() view returns (uint256 id, bool isOpen, bool isDefaulted, bytes32 plan, uint256 drawn, uint64 deadline)",
  "function limits() view returns (uint256 byBond, uint256 byVault, uint256 maxDraw)",
  "function askedOf(address who) view returns (uint256 shares, uint256 epoch)",
  "function bond() view returns (uint256)",
  "function assets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function room() view returns (uint256)",
  "function epochSeconds() view returns (uint32)",
  "function gainBps() view returns (uint16)",
  "function commits() view returns (uint256)",
  "function head() view returns (bytes32)",
  "function deposit(uint256 amount)",
  "function requestWithdraw(uint256 shares)",
  "function claim()",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address who) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount)",
]);

export type VaultReader = Pick<PublicClient, "readContract" | "getBlock">;

/** What a signed call needs from the account, got from the relayer's /accounts route. */
export type Quote = { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas?: bigint };

export function vaultChain(a: { reader: VaultReader; vault: Address; usdc: Address; chainId: number }) {
  const read = <T>(address: Address, abi: typeof VAULT_ABI | typeof ERC20_ABI, functionName: string, args: readonly unknown[]): Promise<T> =>
    a.reader.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  return {
    async read(who: Address): Promise<VaultData> {
      const [owed, epoch, limits, asked, bond, assets, totalShares, cap, room, epochSeconds, gainBps, commits, head, balance, allowance, block] = await Promise.all([
        read<[bigint, bigint, bigint]>(a.vault, VAULT_ABI, "owed", [who]),
        read<[bigint, boolean, boolean, Hex, bigint, bigint]>(a.vault, VAULT_ABI, "epoch", []),
        read<[bigint, bigint, bigint]>(a.vault, VAULT_ABI, "limits", []),
        read<[bigint, bigint]>(a.vault, VAULT_ABI, "askedOf", [who]),
        read<bigint>(a.vault, VAULT_ABI, "bond", []),
        read<bigint>(a.vault, VAULT_ABI, "assets", []),
        read<bigint>(a.vault, VAULT_ABI, "totalShares", []),
        read<bigint>(a.vault, VAULT_ABI, "depositCap", []),
        read<bigint>(a.vault, VAULT_ABI, "room", []),
        read<bigint>(a.vault, VAULT_ABI, "epochSeconds", []),
        read<number>(a.vault, VAULT_ABI, "gainBps", []),
        read<bigint>(a.vault, VAULT_ABI, "commits", []),
        read<Hex>(a.vault, VAULT_ABI, "head", []),
        read<bigint>(a.usdc, ERC20_ABI, "balanceOf", [who]),
        read<bigint>(a.usdc, ERC20_ABI, "allowance", [who, a.vault]),
        a.reader.getBlock(), // the chain's own latest block, for its timestamp
      ]);
      return {
        shares: owed[0],
        worth: assetsForShares(owed[0], assets, totalShares),
        claimable: owed[1],
        waiting: owed[2],
        asked: { shares: asked[0], epoch: asked[1] },
        epoch: { id: epoch[0], open: epoch[1], defaulted: epoch[2], plan: epoch[3], drawn: epoch[4], deadline: epoch[5] },
        byBond: limits[0],
        byVault: limits[1],
        maxDraw: limits[2],
        bond,
        cap,
        room,
        epochSeconds,
        gainBps: Number(gainBps),
        commits,
        head,
        balance,
        allowance,
        blockTimestamp: block.timestamp,
      };
    },

    balanceOf: (who: Address) => read<bigint>(a.usdc, ERC20_ABI, "balanceOf", [who]),

    encodeApprove: (spender: Address, amount: bigint): Hex => encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
    encodeDeposit: (amount: bigint): Hex => encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [amount] }),
    encodeRequestWithdraw: (shares: bigint): Hex => encodeFunctionData({ abi: VAULT_ABI, functionName: "requestWithdraw", args: [shares] }),
    encodeClaim: (): Hex => encodeFunctionData({ abi: VAULT_ABI, functionName: "claim", args: [] }),

    /** Signs one of the phone's own calls with the wallet, for the relayer's pass-on route. */
    sign: (wallet: VaultWallet, call: { to: Address; data: Hex }, quote: Quote): Promise<Hex> =>
      wallet.signCall({
        chainId: a.chainId,
        to: call.to,
        data: call.data,
        nonce: quote.nonce,
        gas: quote.gas ?? DEFAULT_GAS,
        maxFeePerGas: quote.maxFeePerGas,
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      }),
  };
}

export type VaultChain = ReturnType<typeof vaultChain>;
