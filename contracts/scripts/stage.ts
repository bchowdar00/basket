// Runs one round on a STAGE vault: posts a bond, opens a round with a draw, and either closes it
// or leaves it to pass its deadline. For a demo on a test network, with test money only — it
// refuses to operate anything but a stage vault.
//
// Nothing is compiled here. The ABI the tool needs is written out below with viem's `parseAbi`, so
// this file needs no artifact and no bundle: it imports only viem and node built-ins. On the host a
// person starts a one-shot unit that runs this file with the OPERATOR's key in VAULT_KEY (never the
// deployer's); the key is read from the environment and is never printed, logged, or put in an error.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, http, isAddress,
  keccak256, parseAbi, toHex, type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The vault functions and errors this tool calls. Errors are listed so viem decodes a revert to its
// name. It never calls the main vault's deposit/withdraw paths — only the operator's and the reads.
const VAULT_ABI = parseAbi([
  "function postBond(uint256 amount)",
  "function withdrawBond(uint256 amount)",
  "function startEpoch(bytes32 plan, uint256 draw)",
  "function closeEpoch(uint256 returned)",
  "function head() view returns (bytes32)",
  "function limits() view returns (uint256 byBond, uint256 byVault, uint256 maxDraw)",
  "function epoch() view returns (uint256 id, bool isOpen, bool isDefaulted, bytes32 plan, uint256 drawn, uint64 deadline)",
  "function bond() view returns (uint256)",
  "function epochSeconds() view returns (uint32)",
  "function assets() view returns (uint256)",
  "function operator() view returns (address)",
  "error NotOperator()",
  "error EpochOpen()",
  "error NoEpoch()",
  "error Defaulted()",
  "error Nothing()",
  "error OverLimit()",
  "error OverCap()",
  "error NotYet()",
  "error NotEnough()",
  "error PriceTooLow()",
  "error BadSetting()",
]);

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const ZERO32 = "0x" + "0".repeat(64);

// --- the step text ---------------------------------------------------------

export type Step =
  | { kind: "bond"; text: string; units: bigint }
  | { kind: "open"; text: string; draw: bigint | "max" }
  | { kind: "wait"; text: string; seconds: number }
  | { kind: "close"; text: string; mode: "abs" | "plus" | "minus"; value: bigint }
  | { kind: "unbond"; text: string; units: bigint };

/** A whole USDC amount in the six-decimal smallest unit: digits only, above zero. */
function amount(raw: string, text: string): bigint {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`bad step "${text}": the amount is not whole USDC units (digits only)`);
  const v = BigInt(raw);
  if (v <= 0n) throw new Error(`bad step "${text}": the amount is not above zero`);
  return v;
}

/**
 * Reads a step text like `bond:3000000;open:1000000;wait:40;close:1050000;unbond:500000` into steps.
 * Amounts are whole USDC units (six decimals), digits only, above zero. At most 12 steps. Anything
 * else throws an Error naming the bad step. No step holds a secret, so the text is safe to name.
 */
export function parseSteps(text: string): Step[] {
  const parts = text.split(";");
  if (parts.length > 12) throw new Error(`too many steps: ${parts.length}, at most 12`);
  const steps: Step[] = [];
  for (const raw of parts) {
    const t = raw.trim();
    if (t === "") throw new Error(`empty step in "${text}"`);
    const i = t.indexOf(":");
    const kind = i < 0 ? t : t.slice(0, i);
    const arg = i < 0 ? "" : t.slice(i + 1);
    switch (kind) {
      case "bond":
        steps.push({ kind: "bond", text: t, units: amount(arg, t) });
        break;
      case "unbond":
        steps.push({ kind: "unbond", text: t, units: amount(arg, t) });
        break;
      case "open":
        if (arg === "max") steps.push({ kind: "open", text: t, draw: "max" });
        else steps.push({ kind: "open", text: t, draw: amount(arg, t) });
        break;
      case "wait": {
        if (!/^[0-9]+$/.test(arg)) throw new Error(`bad step "${t}": wait is not a whole number of seconds`);
        const seconds = Number(arg);
        if (seconds < 1 || seconds > 600) throw new Error(`bad step "${t}": wait must be 1 to 600 seconds`);
        steps.push({ kind: "wait", text: t, seconds });
        break;
      }
      case "close": {
        if (arg.startsWith("+") || arg.startsWith("-")) {
          const bps = arg.slice(1);
          if (!/^[0-9]+$/.test(bps)) throw new Error(`bad step "${t}": the basis points are not a whole number`);
          const value = BigInt(bps);
          if (arg.startsWith("-") && value > 10_000n) throw new Error(`bad step "${t}": a minus of over 10000 bps would return below zero`);
          steps.push({ kind: "close", text: t, mode: arg.startsWith("+") ? "plus" : "minus", value });
        } else {
          steps.push({ kind: "close", text: t, mode: "abs", value: amount(arg, t) });
        }
        break;
      }
      default:
        throw new Error(`bad step "${t}": unknown kind "${kind}"`);
    }
  }
  return steps;
}

// --- running the round -----------------------------------------------------

/** The contract's own word for a refusal where there is one; otherwise the short form. (Copied from
 * services/relayer/src/chain.ts `why()`, not imported.) */
export function why(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? e.shortMessage;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

type Contract = { address: Address; abi: Abi };

export type RunArgs = {
  reader: PublicClient;
  wallet: WalletClient;
  vault: Contract;
  usdc: Contract;
  steps: Step[];
  sleep: (seconds: number) => Promise<void>;
  log: (line: Record<string, unknown>) => void;
};

/**
 * Runs the steps in order. Each transaction is simulated first, sent, and its receipt awaited and
 * checked for success; the first failure stops the run and throws with the contract's error name
 * where there is one. The plan hash for `open` is the vault's current `head()` when it is not zero,
 * otherwise keccak256(toHex("stage round")).
 */
export async function runSteps(a: RunArgs): Promise<void> {
  const account = a.wallet.account;
  if (!account) throw new Error("the wallet has no account");

  // Simulates then sends one call, waits for its receipt, and checks it succeeded. Returns the hash.
  const send = async (c: Contract, functionName: string, args: readonly unknown[]): Promise<Hex> => {
    const { request } = await a.reader.simulateContract({ address: c.address, abi: c.abi, functionName, args, account } as never);
    const hash = await a.wallet.writeContract(request as never);
    const receipt = await a.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} was mined and failed: ${hash}`);
    return hash;
  };
  const read = (functionName: string) => a.reader.readContract({ address: a.vault.address, abi: a.vault.abi, functionName });

  // A wait between an open and its close must leave the round time to be closed: past the deadline
  // anyone may declare a default, and that closes the vault for good (audit of the candidate).
  const roundSeconds = Number((await read("epochSeconds")) as bigint);
  let sinceOpen: number | null = null;
  for (const step of a.steps) {
    if (step.kind === "open") sinceOpen = 0;
    else if (step.kind === "close") sinceOpen = null;
    else if (step.kind === "wait" && sinceOpen !== null) {
      sinceOpen += step.seconds;
      const after = a.steps.slice(a.steps.indexOf(step) + 1).some((x) => x.kind === "close");
      if (after && sinceOpen > roundSeconds - 15) throw new Error(`step ${step.text} refused: it leaves under 15 seconds of a ${roundSeconds}-second round to close in`);
    }
  }

  for (const step of a.steps) {
    try {
      if (step.kind === "wait") {
        await a.sleep(step.seconds);
        a.log({ step: step.text, waited: step.seconds });
        continue;
      }

      let tx: Hex;
      if (step.kind === "bond") {
        await send(a.usdc, "approve", [a.vault.address, step.units]);
        tx = await send(a.vault, "postBond", [step.units]);
      } else if (step.kind === "unbond") {
        tx = await send(a.vault, "withdrawBond", [step.units]);
      } else if (step.kind === "open") {
        const draw = step.draw === "max" ? ((await read("limits")) as readonly bigint[])[2] : step.draw;
        const h = (await read("head")) as Hex;
        const plan = h !== ZERO32 ? h : keccak256(toHex("stage round"));
        tx = await send(a.vault, "startEpoch", [plan, draw]);
      } else {
        const drawn = ((await read("epoch")) as readonly unknown[])[4] as bigint;
        let returned: bigint;
        if (step.mode === "abs") returned = step.value;
        else if (step.mode === "plus") returned = drawn + (drawn * step.value) / 10_000n;
        else returned = drawn - (drawn * step.value) / 10_000n;
        await send(a.usdc, "approve", [a.vault.address, returned]);
        tx = await send(a.vault, "closeEpoch", [returned]);
      }
      a.log({ step: step.text, tx });
    } catch (e) {
      throw new Error(`step ${step.text} failed: ${why(e)}`);
    }
  }
}

// --- the deployment record and the refusals --------------------------------

type Entry = { name: string; chainId: number | string; vault: Address; usdc: Address };

/**
 * Finds the stage vault for a chain in the deployment record and refuses anything that is not it:
 * a name that does not start with `stage` (the main vault is never operated by this tool), a record
 * with no such name for that chain, a usdc that differs from the one given, or a key whose address
 * is not the vault's `operator()`. Only reads; nothing is sent.
 */
export async function resolveVault(a: {
  reader: Pick<PublicClient, "readContract">;
  record: Record<string, Entry>;
  chainId: number;
  name: string;
  usdc: Address;
  keyAddress: Address;
}): Promise<{ vault: Address; usdc: Address }> {
  if (!a.name.startsWith("stage")) throw new Error(`refusing name "${a.name}": it does not start with stage`);
  const entry = Object.values(a.record).find((e) => Number(e.chainId) === a.chainId && e.name === a.name);
  if (!entry) throw new Error(`no vault named "${a.name}" on chain ${a.chainId} in the record`);
  if (entry.usdc.toLowerCase() !== a.usdc.toLowerCase()) throw new Error(`the vault "${a.name}" has usdc ${entry.usdc}, not VAULT_USDC`);
  const op = (await a.reader.readContract({ address: entry.vault, abi: VAULT_ABI, functionName: "operator" })) as Address;
  if (op.toLowerCase() !== a.keyAddress.toLowerCase()) throw new Error(`the key is not the operator of "${a.name}"`);
  return { vault: entry.vault, usdc: entry.usdc };
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing " + name);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const key = need("VAULT_KEY");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("VAULT_KEY is not 0x followed by 64 hex characters");
    const account = privateKeyToAccount(key as Hex);

    const chainId = Number(need("VAULT_CHAIN_ID"));
    if (chainId !== 5042002 && chainId !== 31337) throw new Error(`VAULT_CHAIN_ID is ${chainId}, not 5042002 or 31337`);
    const rpc = need("VAULT_RPC");
    const usdc = need("VAULT_USDC") as Address;
    if (!isAddress(usdc)) throw new Error("VAULT_USDC is not an address");
    const name = process.env.VAULT_STAGE_NAME || "stage";
    const stepsText = need("VAULT_STAGE_STEPS");
    const addresses = need("VAULT_ADDRESSES");
    if (!existsSync(addresses)) throw new Error("the deployment record " + addresses + " is not there");
    const record = JSON.parse(readFileSync(addresses, "utf8")) as Record<string, Entry>;

    const steps = parseSteps(stepsText);
    const chain = defineChain({ id: chainId, name: "chain " + chainId, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const reader = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
    const actual = await reader.getChainId();
    if (actual !== chainId) throw new Error(`this is chain ${actual}, not ${chainId}; nothing was sent`);

    const { vault } = await resolveVault({ reader, record, chainId, name, usdc, keyAddress: account.address });
    const wallet = createWalletClient({ account, chain, transport: http(rpc) });

    await runSteps({
      reader,
      wallet,
      vault: { address: vault, abi: VAULT_ABI },
      usdc: { address: usdc, abi: ERC20_ABI },
      steps,
      sleep: (seconds) => new Promise((r) => setTimeout(r, seconds * 1000)),
      log: (line) => console.log(JSON.stringify(line)),
    });

    const bond = (await reader.readContract({ address: vault, abi: VAULT_ABI, functionName: "bond" })) as bigint;
    const assets = (await reader.readContract({ address: vault, abi: VAULT_ABI, functionName: "assets" })) as bigint;
    const ep = (await reader.readContract({ address: vault, abi: VAULT_ABI, functionName: "epoch" })) as readonly unknown[];
    console.log(JSON.stringify({
      done: true,
      bond: bond.toString(),
      assets: assets.toString(),
      epoch: { id: String(ep[0]), isOpen: ep[1], isDefaulted: ep[2], plan: ep[3], drawn: String(ep[4]), deadline: String(ep[5]) },
    }));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
