// Sends one vault's creation and checks what landed.
//
// Nothing is compiled where this runs. `makeBundle` is run on the build machine and writes one
// file: the compiled code and the SHA-256 of the source it came from. On the host a person
// starts a one-shot unit that runs this file with the deploy key in its environment
// (deploy/README.md). The key is read from VAULT_KEY and is never printed or written.
//
// One vault is one terms file: its name and its seven figures. Run with the vault's terms and
// again with the stage vault's, it gives the two deployments, each under its own name.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createPublicClient, createWalletClient, defineChain, getContractAddress, http, isAddress, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Bundle = { contractName: "BondedVault"; abi: Abi; bytecode: Hex; sourceSha256: string };

/** One vault's settings as the contract's constructor takes them, and the name it is recorded under. */
export type Terms = {
  name: string; operator: Address; drawBondHalves: number; drawVaultBps: number; gainBps: number;
  epochSeconds: number; capPerMarket: bigint; depositCap: bigint;
};

export type Deployed = {
  name: string; chainId: number; vault: Address; usdc: Address; operator: Address;
  drawBondHalves: number; drawVaultBps: number; gainBps: number; epochSeconds: number;
  capPerMarketMicros: string; depositCapMicros: string; deployTx: Hex; block: string; sourceSha256: string;
};

const DECIMALS = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const KEYS = ["name", "operator", "drawBondHalves", "drawVaultBps", "gainBps", "epochSeconds", "capPerMarketMicros", "depositCapMicros"] as const;
const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
const zero = (a: string) => /^0x0{40}$/.test(a);

/** What the host needs to deploy: the compiled code and the hash of the audited source. */
export function makeBundle(artifact: { contractName: string; abi: Abi; bytecode: Hex }, source: string): Bundle {
  if (artifact.contractName !== "BondedVault") throw new Error("the bundle is for BondedVault, not " + artifact.contractName);
  return {
    contractName: "BondedVault", abi: artifact.abi, bytecode: artifact.bytecode,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  };
}

/** The contract's own ranges, so that a figure it would refuse is refused here, before a creation is paid for. */
function inRange(t: Terms): void {
  const whole = (name: string, v: number, low: number, high: number) => {
    if (!Number.isInteger(v) || v < low || v > high) throw new Error(`terms: ${name} is not a whole figure from ${low} to ${high}`);
  };
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(t.name)) throw new Error("terms: name is not a short name in lower case");
  if (!isAddress(t.operator) || zero(t.operator)) throw new Error("terms: operator is not an address");
  whole("drawBondHalves", t.drawBondHalves, 1, 4);
  whole("drawVaultBps", t.drawVaultBps, 1, 9999);
  whole("gainBps", t.gainBps, 0, 10000);
  whole("epochSeconds", t.epochSeconds, 1, 2 ** 32 - 1);
  if (typeof t.capPerMarket !== "bigint" || t.capPerMarket < 0n) throw new Error("terms: capPerMarketMicros is not a whole figure of none or more");
  if (typeof t.depositCap !== "bigint" || t.depositCap <= 0n || t.depositCap >= 2n ** 96n) throw new Error("terms: depositCapMicros is not a whole figure above none and under 2^96");
}

/** A terms file as one vault's settings. Throws unless it holds exactly the eight entries, each in the contract's range. */
export function readTerms(json: unknown): Terms {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("terms: the file is not an object");
  const given = json as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!(KEYS as readonly string[]).includes(k)) throw new Error("terms: " + k + " is not a figure of a vault");
  for (const k of KEYS) if (given[k] === undefined) throw new Error("terms: " + k + " is missing");
  const micros = (k: "capPerMarketMicros" | "depositCapMicros") => {
    const v = given[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`terms: ${k} is not a whole figure`);
    return BigInt(v);
  };
  const figure = (k: "drawBondHalves" | "drawVaultBps" | "gainBps" | "epochSeconds") => (typeof given[k] === "number" ? (given[k] as number) : NaN);
  const terms: Terms = {
    name: typeof given.name === "string" ? given.name : "", operator: (typeof given.operator === "string" ? given.operator : "") as Address,
    drawBondHalves: figure("drawBondHalves"), drawVaultBps: figure("drawVaultBps"), gainBps: figure("gainBps"), epochSeconds: figure("epochSeconds"),
    capPerMarket: micros("capPerMarketMicros"), depositCap: micros("depositCapMicros"),
  };
  inRange(terms);
  return terms;
}

/**
 * Deploys one vault with its token and its terms, then reads all eight settings back.
 * Every refusal comes before anything is sent.
 */
export async function deploy(a: { bundle: Bundle; chainId: number; usdc: Address; terms: Terms; wallet: WalletClient; reader: PublicClient }): Promise<Deployed> {
  const from = a.wallet.account?.address;
  if (!from) throw new Error("the wallet has no account");
  const actual = await a.reader.getChainId();
  if (actual !== a.chainId) throw new Error(`this is chain ${actual}, not ${a.chainId}; nothing was sent`);
  const t = a.terms;
  try {
    inRange(t);
  } catch (e) {
    throw new Error((e as Error).message + "; nothing was sent");
  }

  let decimals: number | null = null;
  try {
    decimals = await a.reader.readContract({ address: a.usdc, abi: DECIMALS, functionName: "decimals" });
  } catch {
    decimals = null;
  }
  if (decimals !== 6) throw new Error(`the token at ${a.usdc} does not answer six decimals; nothing was sent`);

  const nonce = await a.reader.getTransactionCount({ address: from });
  const willBe = getContractAddress({ from, nonce: BigInt(nonce) });
  if (same(t.operator, a.usdc)) throw new Error("the operator is the token's address; nothing was sent");
  if (same(t.operator, willBe)) throw new Error("the operator is the address the contract will get; nothing was sent");

  const deployTx = await a.wallet.deployContract({
    abi: a.bundle.abi, bytecode: a.bundle.bytecode,
    args: [a.usdc, t.operator, t.drawBondHalves, t.drawVaultBps, t.gainBps, t.epochSeconds, t.capPerMarket, t.depositCap],
    account: a.wallet.account!, chain: a.wallet.chain,
  });
  const receipt = await a.reader.waitForTransactionReceipt({ hash: deployTx });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`the creation ${deployTx} did not succeed`);
  const vault = receipt.contractAddress;

  const read = (functionName: string) => a.reader.readContract({ address: vault, abi: a.bundle.abi, functionName }) as Promise<unknown>;
  const asked: [string, string][] = [
    ["usdc", a.usdc.toLowerCase()], ["operator", t.operator.toLowerCase()], ["drawBondHalves", String(t.drawBondHalves)], ["drawVaultBps", String(t.drawVaultBps)],
    ["gainBps", String(t.gainBps)], ["epochSeconds", String(t.epochSeconds)], ["capPerMarket", String(t.capPerMarket)], ["depositCap", String(t.depositCap)],
  ];
  const wrong: string[] = [];
  for (const [name, want] of asked) {
    const got = String(await read(name)).toLowerCase();
    if (got !== want) wrong.push(`${name} ${got}`);
  }
  if (wrong.length > 0) throw new Error(`the contract at ${vault} does not read back what was asked: ${wrong.join(", ")}`);
  return {
    name: t.name, chainId: a.chainId, vault, usdc: a.usdc, operator: t.operator, drawBondHalves: t.drawBondHalves, drawVaultBps: t.drawVaultBps, gainBps: t.gainBps,
    epochSeconds: t.epochSeconds, capPerMarketMicros: String(t.capPerMarket), depositCapMicros: String(t.depositCap), deployTx, block: receipt.blockNumber.toString(),
    sourceSha256: a.bundle.sourceSha256,
  };
}

/** Adds a deployment to the book of addresses, under its chain and name. An entry is never replaced by this. */
export function record(book: Record<string, Deployed>, d: Deployed): Record<string, Deployed> {
  const key = d.chainId + ":" + d.name;
  if (book[key]) throw new Error(`chain ${d.chainId} already has a vault called ${d.name} at ${book[key].vault}; take that entry out by hand to deploy again`);
  return { ...book, [key]: d };
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing " + name);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chainId = Number(need("VAULT_CHAIN_ID"));
    const rpc = need("VAULT_RPC");
    const out = need("VAULT_ADDRESSES");
    const terms = readTerms(JSON.parse(readFileSync(need("VAULT_TERMS"), "utf8")));
    const book = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Record<string, Deployed>) : {};
    record(book, { chainId, name: terms.name } as Deployed); // refuses a second vault of this name before anything is sent
    const bundle = JSON.parse(readFileSync(need("VAULT_BUNDLE"), "utf8")) as Bundle;
    const chain = defineChain({ id: chainId, name: "chain " + chainId, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const wallet = createWalletClient({ account: privateKeyToAccount(need("VAULT_KEY") as Hex), chain, transport: http(rpc) });
    const reader = createPublicClient({ chain, transport: http(rpc) });
    const d = await deploy({ bundle, chainId, usdc: need("VAULT_USDC") as Address, terms, wallet, reader: reader as PublicClient });
    writeFileSync(out, JSON.stringify(record(book, d), null, 2) + "\n");
    console.log(`deployed ${d.name} at ${d.vault} on chain ${d.chainId} in ${d.deployTx} (block ${d.block}); source ${d.sourceSha256}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
