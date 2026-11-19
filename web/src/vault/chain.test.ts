// Every value in this file is invented. None is a reading of any market.
// Every key here is made for the test and throws away; none holds anything.
import { decodeFunctionData, parseAbi, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { expect, test } from "vitest";

import { assetsForShares, vaultChain } from "./chain.ts";
import { loadOrMakeKey, type KeyStore } from "./wallet.ts";

const USDC = "0x3600000000000000000000000000000000000000";
const VAULT = "0x1111111111111111111111111111111111111111";
const CHAIN = 5042002;
const VS = 1_000_000n; // VIRTUAL_SHARES
const WHOLE = 1_000_000_000_000n; // one whole share = 1e12 share units

const CALLS = parseAbi([
  "function deposit(uint256 amount)",
  "function requestWithdraw(uint256 shares)",
  "function claim()",
  "function approve(address spender, uint256 amount)",
]);

function memory(): KeyStore {
  const held = new Map<string, string>();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => void held.set(k, v) };
}

// A reader stand-in is not needed for the pure helpers; vaultChain is built only to reach `encode*`
// and `sign`. Its `reader` is never called by those.
const chain = vaultChain({ reader: {} as never, vault: VAULT, usdc: USDC, chainId: CHAIN });

test("assetsForShares is the contract's virtual-share price: a whole share is one test dollar in an empty vault", () => {
  expect(assetsForShares(WHOLE, 0n, 0n)).toBe(1_000_000n);
  expect(assetsForShares(2n * WHOLE, 0n, 0n)).toBe(2_000_000n);
});

test("assetsForShares rounds down against the seller and never pays out more than the vault holds", () => {
  const assets = 5_000_000n;
  const totalShares = 5n * WHOLE;
  const out = assetsForShares(3n * WHOLE, assets, totalShares);
  expect(out).toBeLessThanOrEqual(assets + 1n); // the contract's bound: at most assets + 1
  expect(out).toBeLessThanOrEqual(3_000_000n); // never more than the par figure
  // a share count below one virtual share's worth pays nothing
  expect(assetsForShares(1n, 1n, VS)).toBe(0n);
});

test("the four calls encode to exactly their selector and arguments", () => {
  for (const [data, fn, args] of [
    [chain.encodeApprove(VAULT, 50_000_000n), "approve", [VAULT, 50_000_000n]],
    [chain.encodeDeposit(50_000_000n), "deposit", [50_000_000n]],
    [chain.encodeRequestWithdraw(9n * WHOLE), "requestWithdraw", [9n * WHOLE]],
    [chain.encodeClaim(), "claim", []],
  ] as const) {
    const decoded = decodeFunctionData({ abi: CALLS, data: data as Hex });
    expect(decoded.functionName).toBe(fn);
    expect(decoded.args ?? []).toEqual(args);
  }
});

// A reader stand-in that answers each view call and the latest block, to prove `read` carries the
// chain's own block timestamp. `blockTs` is the chain's clock; it has no notion of any phone clock.
function fullReader(over: { deadline?: bigint; blockTs?: bigint } = {}) {
  const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
  const vals: Record<string, unknown> = {
    owed: [0n, 0n, 0n],
    epoch: [1n, true, false, ZERO32, 0n, over.deadline ?? 2_000n],
    limits: [0n, 0n, 0n],
    askedOf: [0n, 0n],
    bond: 0n, assets: 0n, totalShares: 0n, depositCap: 0n, room: 0n,
    epochSeconds: 60n, gainBps: 2000, commits: 0n, head: ZERO32,
    balanceOf: 0n, allowance: 0n,
  };
  return {
    readContract: async ({ functionName }: { functionName: string }) => vals[functionName],
    getBlock: async () => ({ timestamp: over.blockTs ?? 1_500n }),
  } as never;
}

test("the read carries the chain's own latest block timestamp, so a phone clock ahead cannot enable a default", async () => {
  const c = vaultChain({ reader: fullReader({ deadline: 2_000n, blockTs: 1_500n }), vault: VAULT, usdc: USDC, chainId: CHAIN });
  const d = await c.read(VAULT);
  expect(d.blockTimestamp).toBe(1_500n); // the chain's block, not Date.now()
  // The chain's block (1500) is before the deadline (2000); a phone clock an hour ahead would be past
  // it, but the contract's comparison is against the chain, so the button must not enable.
  expect(d.blockTimestamp > d.epoch.deadline).toBe(false);
});

test("sign builds a zero-value type-2 transaction to the given recipient, recoverable to the wallet", async () => {
  const { wallet } = loadOrMakeKey(memory(), CHAIN, () => generatePrivateKey());
  const data = chain.encodeDeposit(50_000_000n);
  const raw = await chain.sign(wallet, { to: VAULT, data }, { nonce: 0, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const tx = parseTransaction(raw as `0x02${string}`);
  expect(tx.type).toBe("eip1559");
  expect(tx.to?.toLowerCase()).toBe(VAULT.toLowerCase());
  expect(tx.value ?? 0n).toBe(0n);
  expect((tx.gas ?? 0n) <= 500_000n).toBe(true); // under the relayer's gas ceiling
  expect(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toBe(wallet.address);
});
