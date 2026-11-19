// Every value in this file is invented. None is a reading of any market.
import { renderToStaticMarkup } from "react-dom/server";
import { getAddress } from "viem";
import { expect, test } from "vitest";

import { MissingSettings, readVaultEnv } from "./main.tsx";

const GOOD = {
  VITE_VAULT_CHAIN_ID: "5042002",
  VITE_VAULT_RPC: "https://rpc.example/test",
  VITE_VAULT_VAULT: "0x1111111111111111111111111111111111111111",
  VITE_VAULT_RELAYER: "/api",
  VITE_VAULT_EXPLORER: "https://explorer.example/test",
};

test("a full, valid set of settings is read into the page's own types", () => {
  const got = readVaultEnv(GOOD);
  expect(got.ok).toBe(true);
  if (!got.ok) throw new Error("expected ok");
  expect(got.settings.chainId).toBe(5042002);
  expect(got.settings.rpc).toBe("https://rpc.example/test");
  expect(got.settings.vault).toBe(getAddress(GOOD.VITE_VAULT_VAULT));
  expect(got.settings.relayer).toBe("/api");
  expect(got.settings.explorer).toBe("https://explorer.example/test");
});

test("a missing setting is named, not crashed on", () => {
  const got = readVaultEnv({ ...GOOD, VITE_VAULT_RPC: undefined });
  expect(got.ok).toBe(false);
  if (got.ok) throw new Error("expected not ok");
  expect(got.missing.some((m) => m.includes("VITE_VAULT_RPC"))).toBe(true);
});

test("a relayer that is neither an absolute http(s) url nor a path, and a non-absolute explorer, are named malformed", () => {
  const bad = readVaultEnv({ ...GOOD, VITE_VAULT_RELAYER: "relayer", VITE_VAULT_EXPLORER: "/explorer" });
  expect(bad.ok).toBe(false);
  if (bad.ok) throw new Error("expected not ok");
  expect(bad.missing.some((m) => m.includes("VITE_VAULT_RELAYER"))).toBe(true);
  expect(bad.missing.some((m) => m.includes("VITE_VAULT_EXPLORER"))).toBe(true);
});

test("a relayer path or absolute url, and an absolute explorer, are accepted", () => {
  expect(readVaultEnv({ ...GOOD, VITE_VAULT_RELAYER: "/api" }).ok).toBe(true);
  expect(readVaultEnv({ ...GOOD, VITE_VAULT_RELAYER: "https://relay.example/test" }).ok).toBe(true);
  expect(readVaultEnv({ ...GOOD, VITE_VAULT_EXPLORER: "http://explorer.example" }).ok).toBe(true);
});

test("a chain id that is not a positive whole number is named malformed", () => {
  for (const v of ["0", "-5", "1.5", "0x10", " 12 "]) {
    const got = readVaultEnv({ ...GOOD, VITE_VAULT_CHAIN_ID: v });
    expect(got.ok, v).toBe(false);
    if (got.ok) throw new Error("expected not ok for " + v);
    expect(got.missing.some((m) => m.includes("VITE_VAULT_CHAIN_ID")), v).toBe(true);
  }
});

test("the missing-settings screen names what is missing", () => {
  const html = renderToStaticMarkup(<MissingSettings missing={["VITE_VAULT_RPC (a value)"]} />)
    .replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  expect(html).toContain("VITE_VAULT_RPC");
});

test("a wrong chain id, address or url is named", () => {
  const bad = readVaultEnv({ ...GOOD, VITE_VAULT_CHAIN_ID: "not-a-number", VITE_VAULT_VAULT: "0x1234", VITE_VAULT_RPC: "ftp://nope" });
  expect(bad.ok).toBe(false);
  if (bad.ok) throw new Error("expected not ok");
  expect(bad.missing.some((m) => m.includes("VITE_VAULT_CHAIN_ID"))).toBe(true);
  expect(bad.missing.some((m) => m.includes("VITE_VAULT_VAULT"))).toBe(true);
  expect(bad.missing.some((m) => m.includes("VITE_VAULT_RPC"))).toBe(true);
});
