// Every value in this file is invented. None is a reading of any market.
import { getAddress } from "viem";
import { expect, test } from "vitest";

import { NoAnswer, RelayerError, relayerApi } from "./api.ts";

const USDC = "0x3600000000000000000000000000000000000000";
const VAULT = "0x1111111111111111111111111111111111111111";
const RELAYER = "0x2222222222222222222222222222222222222222";
const ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TX = ("0x" + "ab".repeat(32)) as `0x${string}`;

/** A fetch stand-in that answers one scripted body and records the call. */
function fake(answer: { ok: boolean; status: number; body: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: answer.ok, status: answer.status, text: async () => JSON.stringify(answer.body) } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("the info route is read into the page's own types", async () => {
  const { fetcher } = fake({ ok: true, status: 200, body: { chainId: 5042002, usdc: USDC, relayer: RELAYER, forDeposit: "50000000", forFees: "1000000", vaults: [{ name: "stage", vault: VAULT }] } });
  const info = await relayerApi("/api", fetcher).info();
  expect(info.chainId).toBe(5042002);
  expect(info.usdc).toBe(getAddress(USDC));
  expect(info.relayer).toBe(getAddress(RELAYER));
  expect(info.forDeposit).toBe(50_000_000n);
  expect(info.forFees).toBe(1_000_000n);
  expect(info.vaults).toEqual([{ name: "stage", vault: getAddress(VAULT) }]);
});

test("a handout posts the address and device and reads back the split", async () => {
  const { fetcher, calls } = fake({ ok: true, status: 200, body: { tx: TX, forDeposit: "50000000", forFees: "1000000" } });
  const r = await relayerApi("/api", fetcher).handout(ADDR, "device-aaaaaaaaaaaa");
  expect(r.tx).toBe(TX);
  expect([r.forDeposit, r.forFees]).toEqual([50_000_000n, 1_000_000n]);
  expect(calls[0]).toMatchObject({ url: "/api/handouts", method: "POST", body: { address: ADDR, device: "device-aaaaaaaaaaaa" } });
});

test("account figures come back as whole numbers", async () => {
  const { fetcher, calls } = fake({ ok: true, status: 200, body: { nonce: "7", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "0", balance: "51000000" } });
  const a = await relayerApi("/api", fetcher).account(ADDR);
  expect([a.nonce, a.maxFeePerGas, a.maxPriorityFeePerGas, a.balance]).toEqual([7, 1_000_000_000n, 0n, 51_000_000n]);
  expect(calls[0].url).toBe("/api/accounts/" + ADDR);
});

test("passing a signed transaction on reads back its hash", async () => {
  const { fetcher, calls } = fake({ ok: true, status: 200, body: { tx: TX } });
  const r = await relayerApi("/api", fetcher).relay("0xdeadbeef");
  expect(r.tx).toBe(TX);
  expect(calls[0]).toMatchObject({ url: "/api/transactions", method: "POST", body: { raw: "0xdeadbeef" } });
});

test("a default ask posts to the named vault", async () => {
  const { fetcher, calls } = fake({ ok: true, status: 200, body: { tx: TX } });
  await relayerApi("/api", fetcher).declareDefault("stage");
  expect(calls[0]).toMatchObject({ url: "/api/vaults/stage/defaults", method: "POST" });
});

test("each refusal becomes a plain sentence with its code and status", async () => {
  const cases: [string, number, RegExp][] = [
    ["already-handed", 409, /already/i],
    ["too-many", 429, /too many|moment/i],
    ["none-left", 409, /no more funds/i],
    ["empty", 503, /cannot be added/i],
    ["not-handed", 403, /add funds first/i],
    ["not-low", 409, /enough/i],
    ["not-found", 404, /not served/i],
    ["not-a-vault-call", 403, /vault/i],
    ["bad-request", 400, /understood/i],
  ];
  for (const [code, status, re] of cases) {
    const { fetcher } = fake({ ok: false, status, body: { error: code } });
    await relayerApi("/api", fetcher).handout(ADDR, "device-aaaaaaaaaaaa").then(
      () => { throw new Error("should have refused " + code); },
      (e: unknown) => {
        expect(e, code).toBeInstanceOf(RelayerError);
        const err = e as RelayerError;
        expect(err.code, code).toBe(code);
        expect(err.status, code).toBe(status);
        expect(err.sentence, code).toMatch(re);
        expect(err.sentence, code).not.toContain("$");
      },
    );
  }
});

test("a refused dry run keeps the contract's word and turns it into a sentence", async () => {
  const { fetcher } = fake({ ok: false, status: 409, body: { error: "refused", why: "NotYet" } });
  await relayerApi("/api", fetcher).declareDefault("stage").then(
    () => { throw new Error("should have refused"); },
    (e: unknown) => {
      const err = e as RelayerError;
      expect(err.code).toBe("refused");
      expect(err.why).toBe("NotYet");
      expect(err.sentence.toLowerCase()).toContain("deadline");
    },
  );
});

test("no answer, or an answer that is not the relayer's own, is NoAnswer with no leaked text", async () => {
  const thrower = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
  await expect(relayerApi("/api", thrower).info()).rejects.toBeInstanceOf(NoAnswer);

  const { fetcher } = fake({ ok: false, status: 500, body: "Internal Server Error: secret stack trace" });
  await relayerApi("/api", fetcher).info().then(
    () => { throw new Error("should have failed"); },
    (e: unknown) => {
      expect(e).toBeInstanceOf(NoAnswer);
      expect((e as Error).message).not.toContain("secret");
    },
  );
});
