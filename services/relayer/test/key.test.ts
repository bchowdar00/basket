// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address } from "viem";

import { keyFromVault } from "../src/key.ts";
import { run } from "../src/main.ts";

// An invented 32-byte key, used only as the value Key Vault would return and the value a raw
// setting would carry. It must never show up in a request, a log line or an error.
const KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const USDC = "0x3600000000000000000000000000000000000000";
const VAULT_URL = "https://relayer-keys.vault.azure.net";
const SECRET = "relayer-key";
const CLIENT = "11111111-2222-3333-4444-555555555555";

/** A fetch that answers the identity token then the secret, recording every request. */
function fakeFetch(secretValue: unknown, tokenBody: unknown = { access_token: "a-token" }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    calls.push({ url: u, headers: init?.headers ?? {} });
    if (u.includes("169.254.169.254")) return { json: async () => tokenBody } as Response;
    return { status: 200, json: async () => secretValue } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("keyFromVault reads the secret over an injected fetch, with no network", async () => {
  const { f, calls } = fakeFetch({ value: KEY });
  const key = await keyFromVault({ clientId: CLIENT, keyVault: VAULT_URL, secret: SECRET, fetch: f });
  assert.equal(key, KEY);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes("169.254.169.254") && calls[0].headers.Metadata === "true");
  assert.ok(calls[1].url === VAULT_URL + "/secrets/" + SECRET + "?api-version=7.4");
  assert.ok(calls[1].headers.authorization === "Bearer a-token");
});

test("an identity that gives no token fails without leaking anything", async () => {
  const { f } = fakeFetch({ value: KEY }, {});
  await assert.rejects(keyFromVault({ clientId: CLIENT, keyVault: VAULT_URL, secret: SECRET, fetch: f }), /token/);
});

test("a secret that is not a key is refused and the body is never echoed", async () => {
  const { f } = fakeFetch({ value: "not-a-key" });
  await assert.rejects(keyFromVault({ clientId: CLIENT, keyVault: VAULT_URL, secret: SECRET, fetch: f }), (e: Error) => /not a key/.test(e.message) && !e.message.includes("not-a-key"));
});

test("starting the service never writes the raw key to a log line", async () => {
  const lines: string[] = [];
  const env = {
    VAULT_KEY: KEY, VAULT_CHAIN_ID: "5042002", VAULT_RPC: "https://rpc.example.test", VAULT_USDC: USDC,
    VAULT_ADDRESSES: "/var/lib/vault/addresses.json", VAULT_DB: "/var/lib/vault/relayer.db", VAULT_PORT: "8788",
    VAULT_HANDOUT_DEPOSIT: "100000000", VAULT_HANDOUT_FEES: "1000000", VAULT_HANDOUTS_MOST: "300",
  };
  const stop = await run(env, {
    connect: async () => ({
      chain: { chainId: 5042002, usdc: USDC as Address, relayer: "0x00000000000000000000000000000000000000e0" as Address } as never,
      relayer: "0x00000000000000000000000000000000000000e0" as Address,
    }),
    readAddresses: () => [{ name: "stage", vault: "0x00000000000000000000000000000000000000a1" as Address }],
    openStore: () => ({ close: () => {} }) as never,
    serve: async () => ({ close: () => {} }),
    log: (line) => lines.push(JSON.stringify(line)),
  });
  await stop();
  assert.ok(lines.some((l) => l.includes("started")));
  for (const l of lines) assert.ok(!l.includes(KEY) && !l.toLowerCase().includes("1111111111"), "a log line leaked the key");
});
