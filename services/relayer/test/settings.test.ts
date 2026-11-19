// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { test } from "node:test";

import { settings } from "../src/main.ts";

// The well-known first key of local chains, used only for its shape (brief's limits).
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USDC = "0x3600000000000000000000000000000000000000";
const VAULT_URL = "https://relayer-keys.vault.azure.net";
const SECRET = "relayer-key";
const CLIENT = "11111111-2222-3333-4444-555555555555";

/** A full, valid environment with a raw key. */
const base = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  VAULT_KEY: KEY,
  VAULT_CHAIN_ID: "5042002",
  VAULT_RPC: "https://rpc.example.test",
  VAULT_USDC: USDC,
  VAULT_ADDRESSES: "/var/lib/vault/addresses.json",
  VAULT_DB: "/var/lib/vault/relayer.db",
  VAULT_PORT: "8788",
  VAULT_HANDOUT_DEPOSIT: "100000000",
  VAULT_HANDOUT_FEES: "1000000",
  VAULT_HANDOUTS_MOST: "300",
  ...over,
});

test("a full environment with a raw key is read into the ten settings", () => {
  const s = settings(base());
  assert.deepEqual(s.keyConfig, { kind: "raw", key: KEY });
  assert.equal(s.chainId, 5042002);
  assert.equal(s.rpc, "https://rpc.example.test");
  assert.equal(s.usdc.toLowerCase(), USDC);
  assert.equal(s.addresses, "/var/lib/vault/addresses.json");
  assert.equal(s.db, "/var/lib/vault/relayer.db");
  assert.equal(s.port, 8788);
  assert.equal(s.forDeposit, 100_000_000n);
  assert.equal(s.forFees, 1_000_000n);
  assert.equal(s.most, 300);
});

test("the three Key Vault settings are read as a trio when no raw key is given", () => {
  const env = base({ VAULT_KEY: undefined, VAULT_KEY_VAULT: VAULT_URL, VAULT_KEY_SECRET: SECRET, VAULT_IDENTITY_CLIENT_ID: CLIENT });
  const s = settings(env);
  assert.deepEqual(s.keyConfig, { kind: "vault", keyVault: VAULT_URL, secret: SECRET, clientId: CLIENT });
});

test("a raw key and the trio together are refused, and neither names the key's value", () => {
  const env = base({ VAULT_KEY_VAULT: VAULT_URL, VAULT_KEY_SECRET: SECRET, VAULT_IDENTITY_CLIENT_ID: CLIENT });
  assert.throws(() => settings(env), (e: Error) => /exactly one/i.test(e.message) && !e.message.includes(KEY) && !e.message.includes(SECRET));
});

test("neither a raw key nor the trio is refused", () => {
  const env = base({ VAULT_KEY: undefined });
  assert.throws(() => settings(env), /exactly one/i);
});

test("a partial trio is refused and the missing setting is named", () => {
  const env = base({ VAULT_KEY: undefined, VAULT_KEY_VAULT: VAULT_URL, VAULT_KEY_SECRET: SECRET });
  assert.throws(() => settings(env), /VAULT_IDENTITY_CLIENT_ID/);
});

test("each Key Vault setting's shape is checked", () => {
  const trio = { VAULT_KEY: undefined, VAULT_KEY_VAULT: VAULT_URL, VAULT_KEY_SECRET: SECRET, VAULT_IDENTITY_CLIENT_ID: CLIENT };
  assert.throws(() => settings(base({ ...trio, VAULT_KEY_VAULT: "https://keys.example.com" })), /VAULT_KEY_VAULT/);
  assert.throws(() => settings(base({ ...trio, VAULT_KEY_VAULT: "http://keys.vault.azure.net" })), /VAULT_KEY_VAULT/);
  assert.throws(() => settings(base({ ...trio, VAULT_KEY_SECRET: "bad secret!" })), /VAULT_KEY_SECRET/);
  assert.throws(() => settings(base({ ...trio, VAULT_IDENTITY_CLIENT_ID: "not-a-uuid" })), /VAULT_IDENTITY_CLIENT_ID/);
});

test("a wrong raw key is named and its value never appears in the message", () => {
  assert.throws(() => settings(base({ VAULT_KEY: "0xdeadbeef" })), (e: Error) => /VAULT_KEY/.test(e.message) && !e.message.includes("deadbeef"));
});

test("chain 5042 (Arc's main network) is refused; only 5042002 is served", () => {
  assert.throws(() => settings(base({ VAULT_CHAIN_ID: "5042" })), /VAULT_CHAIN_ID/);
  assert.throws(() => settings(base({ VAULT_CHAIN_ID: "1" })), /VAULT_CHAIN_ID/);
});

test("each remaining setting is named when missing or wrong", () => {
  assert.throws(() => settings(base({ VAULT_RPC: "not-a-url" })), /VAULT_RPC/);
  assert.throws(() => settings(base({ VAULT_USDC: "0x12" })), /VAULT_USDC/);
  assert.throws(() => settings(base({ VAULT_ADDRESSES: "relative/path" })), /VAULT_ADDRESSES/);
  assert.throws(() => settings(base({ VAULT_DB: "relative/path" })), /VAULT_DB/);
  assert.throws(() => settings(base({ VAULT_PORT: "80" })), /VAULT_PORT/);
  assert.throws(() => settings(base({ VAULT_PORT: "70000" })), /VAULT_PORT/);
});

test("a fee part or a deposit part of none is refused", () => {
  assert.throws(() => settings(base({ VAULT_HANDOUT_DEPOSIT: "0" })), /VAULT_HANDOUT_DEPOSIT/);
  assert.throws(() => settings(base({ VAULT_HANDOUT_FEES: "0" })), /VAULT_HANDOUT_FEES/);
  assert.throws(() => settings(base({ VAULT_HANDOUTS_MOST: "0" })), /VAULT_HANDOUTS_MOST/);
});
