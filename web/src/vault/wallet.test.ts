// Every value in this file is invented. None is a reading of any market.
// Every key in this file is a publicly known test key or made for the test; none holds anything.
import { parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";

import { deviceId, loadOrMakeKey, type KeyStore } from "./wallet.ts";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN = 5042002;

function memory(): KeyStore & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return { held, getItem: (k) => held.get(k) ?? null, setItem: (k, v) => void held.set(k, v) };
}

test("the first visit makes a key in this browser and keeps it; the next visit finds the same wallet", () => {
  const store = memory();
  const first = loadOrMakeKey(store, CHAIN, () => KEY);
  expect(first.made).toBe(true);
  expect(first.wallet.address).toBe(privateKeyToAccount(KEY).address);
  const again = loadOrMakeKey(store, CHAIN, () => { throw new Error("a second key must not be made"); });
  expect(again.made).toBe(false);
  expect(again.wallet.address).toBe(first.wallet.address);
});

test("the key is kept under this chain's number, so a key for test dollars is never used elsewhere", () => {
  const store = memory();
  const test1 = loadOrMakeKey(store, CHAIN, () => KEY);
  const other = loadOrMakeKey(store, 5042, () => ("0x" + "11".repeat(32)) as Hex);
  expect(other.wallet.address).not.toBe(test1.wallet.address);
  expect([...store.held.keys()].some((k) => k.includes(String(CHAIN)))).toBe(true);
});

test("a stored key that does not read as one is never replaced; the page stops and says so", () => {
  const store = memory();
  store.setItem("basket:vault:key:" + CHAIN, "0x1234");
  expect(() => loadOrMakeKey(store, CHAIN, () => KEY)).toThrow(/damaged/);
  expect(store.getItem("basket:vault:key:" + CHAIN)).toBe("0x1234");
});

test("a browser that will not keep the key gives no wallet", () => {
  const refusing: KeyStore = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  expect(() => loadOrMakeKey(refusing, CHAIN, () => KEY)).toThrow(/cannot keep/);
  const forgetful: KeyStore = { getItem: () => null, setItem: () => {} };
  expect(() => loadOrMakeKey(forgetful, CHAIN, () => KEY)).toThrow(/cannot keep/);
});

test("the wallet signs one of its own calls into a zero-value type-2 transaction for this chain", async () => {
  const { wallet } = loadOrMakeKey(memory(), CHAIN, () => KEY);
  const raw = await wallet.signCall({
    chainId: CHAIN, to: "0x3600000000000000000000000000000000000000", data: "0xabcdef12",
    nonce: 0, gas: 400_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
  });
  const tx = parseTransaction(raw as `0x02${string}`);
  expect(tx.type).toBe("eip1559");
  expect(tx.chainId).toBe(CHAIN);
  expect(tx.value ?? 0n).toBe(0n);
  expect(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toBe(wallet.address);
});

test("the wallet refuses to sign for another chain", async () => {
  const { wallet } = loadOrMakeKey(memory(), CHAIN, () => KEY);
  await expect(wallet.signCall({
    chainId: 5042, to: "0x3600000000000000000000000000000000000000", data: "0x",
    nonce: 0, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
  })).rejects.toThrow(/own network/);
});

test("a device id is made once, kept in this browser, within the relayer's shape", () => {
  const store = memory();
  const id = deviceId(store, () => "abcdefghijklmnop");
  expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  const again = deviceId(store, () => "zzzzzzzzzzzzzzzz");
  expect(again).toBe(id); // kept, not remade
});
