// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { check } from "../src/checks.ts";
import { Refused } from "../src/refused.ts";

const CHAIN = 5042002;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const VAULT = "0x00000000000000000000000000000000000000a1" as Address;
const OTHER_VAULT = "0x00000000000000000000000000000000000000b2" as Address;
const THIRD = "0x00000000000000000000000000000000000000c3" as Address;

const CALLS = parseAbi([
  "function deposit(uint256 amount)",
  "function requestWithdraw(uint256 shares)",
  "function claim()",
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function startEpoch(bytes32 plan, uint256 draw)",
  "function closeEpoch(uint256 returned)",
  "function postBond(uint256 amount)",
  "function withdrawBond(uint256 amount)",
  "function commit(bytes32 hash)",
  "function declareDefault()",
]);
const data = (fn: string, args: readonly unknown[] = []): Hex => encodeFunctionData({ abi: CALLS, functionName: fn, args } as never);

const account = privateKeyToAccount(generatePrivateKey());
const vaults = new Set<string>([VAULT.toLowerCase(), OTHER_VAULT.toLowerCase()]);
const handed = (a: Address) => a.toLowerCase() === account.address.toLowerCase();
const ctx = { chainId: CHAIN, usdc: USDC, vaults, handed };

type TxOver = { to?: Address | null; value?: bigint; data?: Hex; gas?: bigint; chainId?: number; type?: "eip1559" | "legacy"; accessList?: { address: Address; storageKeys: Hex[] }[] };
async function sign(over: TxOver = {}, signer = account): Promise<Hex> {
  const type = over.type ?? "eip1559";
  const common = { nonce: 0, to: (over.to === undefined ? VAULT : over.to) as Address, value: over.value ?? 0n, data: over.data ?? data("claim"), gas: over.gas ?? 120_000n, chainId: over.chainId ?? CHAIN };
  if (type === "legacy") return signer.signTransaction({ ...common, type: "legacy", gasPrice: 1_000_000_000n } as never);
  return signer.signTransaction({ ...common, type: "eip1559", maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, accessList: over.accessList ?? [] } as never);
}
async function refused(raw: Hex, code: string): Promise<void> {
  await assert.rejects(check(raw, ctx), (e: unknown) => e instanceof Refused && e.code === code, `expected ${code}`);
}

test("each of the four vault/USDC calls passes and names its signer", async () => {
  for (const d of [data("deposit", [5n]), data("requestWithdraw", [7n]), data("claim")]) {
    const r = await check(await sign({ to: VAULT, data: d }), ctx);
    assert.equal(r.signer.toLowerCase(), account.address.toLowerCase());
    assert.equal(r.to.toLowerCase(), VAULT.toLowerCase());
  }
  const approve = await check(await sign({ to: USDC, data: data("approve", [OTHER_VAULT, 9n]) }), ctx);
  assert.equal(approve.to.toLowerCase(), USDC.toLowerCase());
});

test("a legacy transaction with a chain id also passes", async () => {
  const r = await check(await sign({ to: VAULT, data: data("deposit", [1n]), type: "legacy" }), ctx);
  assert.equal(r.signer.toLowerCase(), account.address.toLowerCase());
});

test("another chain id is refused", async () => {
  await refused(await sign({ chainId: 5042, data: data("claim") }), "not-a-vault-call");
});

test("a value above none is refused", async () => {
  await refused(await sign({ to: VAULT, value: 1n, data: data("claim") }), "not-a-vault-call");
});

test("a contract creation (no recipient) is refused", async () => {
  await refused(await sign({ to: null, data: data("claim") }), "not-a-vault-call");
});

test("an access list entry is refused", async () => {
  await refused(await sign({ to: VAULT, data: data("claim"), accessList: [{ address: VAULT, storageKeys: [] }] }), "not-a-vault-call");
});

test("a gas limit over the most is refused; the most itself passes", async () => {
  await refused(await sign({ to: VAULT, data: data("claim"), gas: 500_001n }), "not-a-vault-call");
  const r = await check(await sign({ to: VAULT, data: data("claim"), gas: 500_000n }), ctx);
  assert.equal(r.to.toLowerCase(), VAULT.toLowerCase());
});

test("a vault call with another selector is refused", async () => {
  for (const fn of ["startEpoch", "closeEpoch", "postBond", "withdrawBond", "commit", "declareDefault"]) {
    const args = fn === "startEpoch" ? [("0x" + "11".repeat(32)) as Hex, 1n] : fn === "commit" ? [("0x" + "22".repeat(32)) as Hex] : fn === "declareDefault" ? [] : [1n];
    await refused(await sign({ to: VAULT, data: data(fn, args) }), "not-a-vault-call");
  }
});

test("deposit with extra bytes after its argument is refused", async () => {
  await refused(await sign({ to: VAULT, data: (data("deposit", [3n]) + "ab") as Hex }), "not-a-vault-call");
});

test("approve whose spender is not a served vault is refused", async () => {
  await refused(await sign({ to: USDC, data: data("approve", [THIRD, 1n]) }), "not-a-vault-call");
});

test("transfer and transferFrom on USDC are refused", async () => {
  await refused(await sign({ to: USDC, data: data("transfer", [VAULT, 1n]) }), "not-a-vault-call");
  await refused(await sign({ to: USDC, data: data("transferFrom", [account.address, VAULT, 1n]) }), "not-a-vault-call");
});

test("deposit sent to USDC, and approve sent to a vault, are refused", async () => {
  await refused(await sign({ to: USDC, data: data("deposit", [1n]) }), "not-a-vault-call");
  await refused(await sign({ to: VAULT, data: data("approve", [VAULT, 1n]) }), "not-a-vault-call");
});

test("a call to a third address is refused", async () => {
  await refused(await sign({ to: THIRD, data: data("claim") }), "not-a-vault-call");
});

test("text that is not a transaction is refused", async () => {
  await refused("not a transaction" as Hex, "not-a-vault-call");
  await refused("0x1234" as Hex, "not-a-vault-call");
});

test("a transaction signed by another key is not handed", async () => {
  const other = privateKeyToAccount(generatePrivateKey());
  await refused(await sign({ to: VAULT, data: data("claim") }, other), "not-handed");
});
