// Mount the vault's phone page, and read its settings. Every setting comes from import.meta.env's
// VITE_VAULT_* names (no address or URL is hard-coded); `readVaultEnv` reads them in this one place
// and, when one is missing or wrong, names it on the page instead of crashing. USDC's address, the
// relayer's own chain address and the handout split are learned from the relayer's info route, not
// from here.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getAddress, isAddress, type Address } from "viem";

import { TestMoneyBanner, VaultApp } from "./VaultApp.tsx";
import "../ui/weave.css"; // the weave theme first
import "./vault.css"; // then only what the phone layout adds

export type VaultSettings = {
  chainId: number;
  rpc: string;
  vault: Address;
  relayer: string;
  explorer: string;
  /** Optional: about how often a round opens on this deployment, in seconds (VITE_VAULT_ROUND_EVERY). */
  roundEverySec?: number;
  /** Optional: where the source is (VITE_VAULT_SOURCE). */
  sourceUrl?: string;
  /** Optional: where the operator's screen on invented markets is, a path or an address (VITE_VAULT_SCREEN). */
  screenUrl?: string;
};

export type EnvResult = { ok: true; settings: VaultSettings } | { ok: false; missing: string[] };

/** Reads the five VITE_VAULT_* settings. Returns the settings, or the names of the ones missing or
 * wrong, so the page can say what to set rather than crash. */
export function readVaultEnv(env: Record<string, unknown>): EnvResult {
  const missing: string[] = [];
  const str = (name: string): string => {
    const v = env[name];
    if (typeof v !== "string" || v.trim() === "") {
      missing.push(name + " (a value)");
      return "";
    }
    return v;
  };

  const chainRaw = env.VITE_VAULT_CHAIN_ID;
  let chainId = 0;
  if (typeof chainRaw !== "string" || !/^\d+$/.test(chainRaw) || Number(chainRaw) === 0) {
    missing.push("VITE_VAULT_CHAIN_ID (a whole number)");
  } else {
    chainId = Number(chainRaw);
  }

  // A web address setting: an absolute http(s) url, or — for the relayer only — a path starting with
  // "/" that the page fetches against its own origin. Anything else is named malformed, not crashed on.
  const webAddr = (name: string, allowPath: boolean): string => {
    const v = env[name];
    if (typeof v !== "string" || v.trim() === "") {
      missing.push(name + " (a value)");
      return "";
    }
    if (/^https?:\/\//.test(v) || (allowPath && v.startsWith("/"))) return v;
    missing.push(name + (allowPath ? " (an http or https address, or a path starting with /)" : " (an http or https address)"));
    return "";
  };

  const rpc = str("VITE_VAULT_RPC");
  if (rpc !== "" && !/^https?:\/\//.test(rpc)) missing.push("VITE_VAULT_RPC (an http or https address)");

  const vaultRaw = env.VITE_VAULT_VAULT;
  let vault: Address = "0x0000000000000000000000000000000000000000";
  if (typeof vaultRaw !== "string" || !isAddress(vaultRaw)) {
    missing.push("VITE_VAULT_VAULT (the vault's address)");
  } else {
    vault = getAddress(vaultRaw);
  }

  const relayer = webAddr("VITE_VAULT_RELAYER", true);
  const explorer = webAddr("VITE_VAULT_EXPLORER", false);

  if (missing.length > 0) return { ok: false, missing };
  // Two optional settings: left out, the page simply does not say them. A wrong one is left out too.
  const every = env.VITE_VAULT_ROUND_EVERY;
  const source = env.VITE_VAULT_SOURCE;
  const screen = env.VITE_VAULT_SCREEN;
  return {
    ok: true,
    settings: {
      chainId, rpc, vault, relayer, explorer,
      ...(typeof every === "string" && /^[1-9]\d{1,5}$/.test(every) ? { roundEverySec: Number(every) } : {}),
      ...(typeof source === "string" && /^https:\/\//.test(source) ? { sourceUrl: source } : {}),
      ...(typeof screen === "string" && /^(https:\/\/|\/[a-z])/.test(screen) ? { screenUrl: screen } : {}),
    },
  };
}

export function MissingSettings({ missing }: { missing: string[] }) {
  return (
    <main className="vault">
      <h1 className="vault-name">BASKET</h1>
      <p className="error" role="alert">This page is not set up. Set these before it can run:</p>
      <ul className="vault-missing">
        {missing.map((m) => <li key={m}>{m}</li>)}
      </ul>
      <TestMoneyBanner />
    </main>
  );
}

const container = typeof document !== "undefined" ? document.getElementById("root") : null;
if (container !== null) {
  const env = readVaultEnv(import.meta.env as unknown as Record<string, unknown>);
  createRoot(container).render(
    <StrictMode>{env.ok ? <VaultApp settings={env.settings} /> : <MissingSettings missing={env.missing} />}</StrictMode>,
  );
}
