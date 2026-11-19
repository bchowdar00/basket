// The relayer as a service: it reads its settings from the environment, resolves its key (a raw
// setting for local tests, or Azure Key Vault on the host), serves the deployment record's vaults
// for this chain, and listens on 127.0.0.1 only. The key is held in the process; it is never
// printed, logged or written by this program.
//
//   VAULT_KEY               a raw key, 0x and 64 hex (local tests only)   — or the trio:
//   VAULT_KEY_VAULT         an https ...vault.azure.net address
//   VAULT_KEY_SECRET        the secret's name
//   VAULT_IDENTITY_CLIENT_ID the managed identity's client id
//   VAULT_CHAIN_ID          5042002 (Arc's test network); the main network is refused
//   VAULT_RPC               the chain's RPC address
//   VAULT_USDC              USDC's address
//   VAULT_ADDRESSES         a full path to the deployment record
//   VAULT_DB                a full path to the relayer's database
//   VAULT_PORT              the port to listen on, on 127.0.0.1
//   VAULT_HANDOUT_DEPOSIT   whole USDC units: the part of a handout meant to be deposited
//   VAULT_HANDOUT_FEES      whole USDC units: the part meant for fees, and the size of a top-up
//   VAULT_HANDOUTS_MOST     the most phones ever handed dollars by this database
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createPublicClient, createWalletClient, defineChain, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { relayerChain, type RelayerChain } from "./chain.ts";
import { keyFromVault } from "./key.ts";
import { relayer } from "./relayer.ts";
import { handler } from "./server.ts";
import { openStore, type Store } from "./store.ts";

export type KeyConfig = { kind: "raw"; key: Hex } | { kind: "vault"; keyVault: string; secret: string; clientId: string };

export type Settings = {
  keyConfig: KeyConfig;
  chainId: 5042002;
  rpc: string;
  usdc: Address;
  addresses: string;
  db: string;
  port: number;
  forDeposit: bigint;
  forFees: bigint;
  most: number;
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME = /^[A-Za-z0-9-]+$/;
const WHOLE = /^(0|[1-9]\d*)$/;

const isWeb = (s: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};
const isVaultUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.endsWith(".vault.azure.net");
  } catch {
    return false;
  }
};

/** The settings, or an error that names the one that is wrong. No value is ever repeated in an error. */
export function settings(env: Record<string, string | undefined>): Settings {
  const bad = (name: string, rule: string): never => {
    throw new Error(`${name} is missing or wrong: ${rule}`);
  };
  const has = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;

  // The key: exactly one of a raw key or the three Key Vault settings.
  const raw = env.VAULT_KEY;
  const anyTrio = has(env.VAULT_KEY_VAULT) || has(env.VAULT_KEY_SECRET) || has(env.VAULT_IDENTITY_CLIENT_ID);
  let keyConfig: KeyConfig;
  if (has(raw) && anyTrio) throw new Error("set exactly one of VAULT_KEY or (VAULT_KEY_VAULT, VAULT_KEY_SECRET, VAULT_IDENTITY_CLIENT_ID), not both");
  if (!has(raw) && !anyTrio) throw new Error("set exactly one of VAULT_KEY or (VAULT_KEY_VAULT, VAULT_KEY_SECRET, VAULT_IDENTITY_CLIENT_ID)");
  if (has(raw)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) bad("VAULT_KEY", "a 32-byte key, 0x and 64 hex characters");
    keyConfig = { kind: "raw", key: raw as Hex };
  } else {
    const keyVault = env.VAULT_KEY_VAULT ?? "";
    if (!isVaultUrl(keyVault)) bad("VAULT_KEY_VAULT", "an https address ending .vault.azure.net");
    const secret = env.VAULT_KEY_SECRET ?? "";
    if (!NAME.test(secret)) bad("VAULT_KEY_SECRET", "letters, digits and dashes");
    const clientId = env.VAULT_IDENTITY_CLIENT_ID ?? "";
    if (!UUID.test(clientId)) bad("VAULT_IDENTITY_CLIENT_ID", "a UUID");
    keyConfig = { kind: "vault", keyVault, secret, clientId };
  }

  const chainId = Number(env.VAULT_CHAIN_ID || NaN);
  if (chainId !== 5042002) bad("VAULT_CHAIN_ID", "exactly 5042002 (Arc's main network is refused)");
  const rpc = env.VAULT_RPC ?? "";
  if (!isWeb(rpc)) bad("VAULT_RPC", "an http or https address");
  const usdc = env.VAULT_USDC ?? "";
  if (!isAddress(usdc)) bad("VAULT_USDC", "an address");
  const addresses = env.VAULT_ADDRESSES ?? "";
  if (!addresses.startsWith("/")) bad("VAULT_ADDRESSES", "a full path to the deployment record");
  const db = env.VAULT_DB ?? "";
  if (!db.startsWith("/")) bad("VAULT_DB", "a full path to a file");
  const port = Number(env.VAULT_PORT || NaN);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) bad("VAULT_PORT", "a whole number from 1024 to 65535");

  const units = (name: string, v: string | undefined): bigint => {
    if (!WHOLE.test(v ?? "") || BigInt(v!) <= 0n) bad(name, "whole USDC units above none");
    return BigInt(v!);
  };
  const forDeposit = units("VAULT_HANDOUT_DEPOSIT", env.VAULT_HANDOUT_DEPOSIT);
  const forFees = units("VAULT_HANDOUT_FEES", env.VAULT_HANDOUT_FEES);
  const mostText = env.VAULT_HANDOUTS_MOST ?? "";
  if (!WHOLE.test(mostText) || Number(mostText) <= 0) bad("VAULT_HANDOUTS_MOST", "a whole number above none");
  const most = Number(mostText);

  return { keyConfig, chainId: 5042002, rpc, usdc: usdc as Address, addresses, db, port, forDeposit, forFees, most };
}

type Served = { name: string; vault: Address };
type RecordEntry = { name: string; chainId: number; vault: Address; usdc: Address };

/** The deployment record's vaults for this chain. An entry of this chain whose USDC is not ours stops the start. */
function readAddresses(path: string, chainId: number, usdc: Address): Served[] {
  const book = JSON.parse(readFileSync(path, "utf8")) as Record<string, RecordEntry>;
  const out: Served[] = [];
  for (const entry of Object.values(book)) {
    if (entry.chainId !== chainId) continue;
    if (entry.usdc.toLowerCase() !== usdc.toLowerCase()) throw new Error(`the deployment "${entry.name}" is for another USDC than VAULT_USDC`);
    out.push({ name: entry.name, vault: entry.vault });
  }
  return out;
}

async function connect(s: Settings): Promise<{ chain: RelayerChain; relayer: Address }> {
  const key = s.keyConfig.kind === "raw" ? s.keyConfig.key : await keyFromVault({ clientId: s.keyConfig.clientId, keyVault: s.keyConfig.keyVault, secret: s.keyConfig.secret });
  const account = privateKeyToAccount(key);
  const chain = defineChain({ id: s.chainId, name: "chain " + s.chainId, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [s.rpc] } } });
  const reader = createPublicClient({ chain, transport: http(s.rpc), pollingInterval: 500 });
  const wallet = createWalletClient({ account, chain, transport: http(s.rpc) });
  const actual = await reader.getChainId();
  if (actual !== s.chainId) throw new Error(`the RPC is chain ${actual}, not ${s.chainId}`);
  return { chain: relayerChain({ reader, wallet, chainId: s.chainId, usdc: s.usdc }), relayer: account.address };
}

export type Io = {
  connect?: (s: Settings) => Promise<{ chain: RelayerChain; relayer: Address }>;
  readAddresses?: (path: string, chainId: number, usdc: Address) => Served[];
  openStore?: (path: string) => Store;
  serve?: (h: ReturnType<typeof handler>, port: number) => Promise<{ close: () => void }>;
  now?: () => number;
  nowMs?: () => number;
  log?: (line: Record<string, unknown>) => void;
};

async function listen(h: ReturnType<typeof handler>, port: number): Promise<{ close: () => void }> {
  const server = createServer(h);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return { close: () => server.close() };
}

/** Starts the relayer and returns a function that stops it. */
export async function run(env: Record<string, string | undefined>, io: Io = {}): Promise<() => Promise<void>> {
  const log = io.log ?? ((line) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line })));
  const s = settings(env);
  const store = (io.openStore ?? openStore)(s.db);
  const vaults = (io.readAddresses ?? readAddresses)(s.addresses, s.chainId, s.usdc);
  const { chain, relayer: relayerAddress } = await (io.connect ?? connect)(s);
  const app = relayer({ store, chain, now: io.now ?? (() => Math.floor(Date.now() / 1000)), nowMs: io.nowMs, vaults, usdc: s.usdc, forDeposit: s.forDeposit, forFees: s.forFees, most: s.most, log });
  const server = await (io.serve ?? listen)(handler(app, log), s.port);
  log({ what: "started", relayer: relayerAddress, chainId: s.chainId, port: s.port, vaults: vaults.length });
  return async () => {
    server.close();
    store.close();
    log({ what: "stopped" });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.env).then((stop) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void stop().then(() => process.exit(0)));
  }).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
