// The phone talking to the vault's relayer over its HTTP routes, at a base the page is given. Every
// answer is read into the page's own types; every refusal is turned into a plain sentence the person
// can read, keeping the relayer's own code (and the contract's word, where a dry run was turned
// back) for the page to act on. Nothing of an internal error reaches the person. The fetcher is
// injected so the routes are tested without a network.
import { getAddress, type Address, type Hex } from "viem";

/** The relayer said no. `code` is its own word for why; `sentence` is the plain line for the person;
 * `why` is the contract's error name where a dry run or a default was turned back. */
export class RelayerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly sentence: string;
  readonly why: string | undefined;
  constructor(status: number, code: string, sentence: string, why?: string) {
    super("refused: " + code);
    this.name = "RelayerError";
    this.status = status;
    this.code = code;
    this.sentence = sentence;
    this.why = why;
  }
}

/** Nothing came back, or what came back could not be read as the relayer's own answer. */
export class NoAnswer extends Error {
  constructor() {
    super("The relayer did not answer. Check the connection and open the page again.");
    this.name = "NoAnswer";
  }
}

export type Info = {
  chainId: number;
  usdc: Address;
  relayer: Address;
  forDeposit: bigint;
  forFees: bigint;
  vaults: { name: string; vault: Address }[];
};

export type AccountInfo = { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; balance: bigint };

/** The contract's own word for a turned-back call, as a plain sentence. */
function whySentence(why: string | undefined): string {
  switch (why) {
    case "NotYet":
      return "The operator still has time: the round's deadline has not passed yet.";
    case "NoEpoch":
      return "There is no open round to act on.";
    case "Defaulted":
      return "This vault has already been declared in default.";
    default:
      return "The vault would turn this down right now. Try again in a moment.";
  }
}

/** A plain sentence for each relayer refusal code. Never a currency sign, never an annual rate. */
function sentenceFor(code: string, why: string | undefined): string {
  switch (code) {
    case "bad-request":
      return "That request was not understood.";
    case "already-handed":
      return "This wallet has already been funded.";
    case "too-many":
      return "Too many requests just now. Try again later, up to an hour from now.";
    case "none-left":
      return "No more funds are being given out here.";
    case "empty":
      return "Funds cannot be added right now. Try again later.";
    case "send-failed":
      return "That could not be sent. Try again in a moment.";
    case "send-unknown":
      return "That may have been sent; the network has not confirmed it. Look at your balance in a moment; asking again sends nothing.";
    case "chain-unavailable":
      return "The network could not be reached. Try again in a moment.";
    case "not-handed":
      return "Add funds first.";
    case "not-low":
      return "You still have enough to pay network fees.";
    case "not-found":
      return "That vault is not served here.";
    case "not-a-vault-call":
      return "This page can only send the vault's own calls.";
    case "refused":
      return whySentence(why);
    default:
      return "That could not be done right now.";
  }
}

const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return Number(v);
  throw new NoAnswer();
};
const units = (v: unknown): bigint => {
  if (typeof v === "string" && /^(0|[1-9]\d{0,38})$/.test(v)) return BigInt(v);
  throw new NoAnswer();
};
const hex32 = (v: unknown): Hex => {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase() as Hex;
  throw new NoAnswer();
};
const addr = (v: unknown): Address => {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return getAddress(v);
  throw new NoAnswer();
};

export function relayerApi(base: string, fetcher: typeof fetch = (...a) => fetch(...a)) {
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    let text: string;
    // A relayer that never answers is no answer, not a button held forever. An AbortController is
    // used because older phones' browsers have no AbortSignal.timeout.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 25_000);
    try {
      res = await fetcher(base + path, {
        method,
        cache: "no-store",
        signal: stop.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      text = await res.text();
    } catch {
      throw new NoAnswer();
    } finally {
      clearTimeout(timer);
    }
    let said: unknown = null;
    try {
      said = JSON.parse(text);
    } catch {
      /* not the relayer's own answer: the web server's, or a network box's */
    }
    if (res.ok) {
      if (said === null) throw new NoAnswer();
      return said;
    }
    const b = typeof said === "object" && said !== null ? (said as Record<string, unknown>) : {};
    if (typeof b.error !== "string") throw new NoAnswer();
    const why = typeof b.why === "string" ? b.why : undefined;
    throw new RelayerError(res.status, b.error, sentenceFor(b.error, why), why);
  }
  const obj = (v: unknown): Record<string, unknown> => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    throw new NoAnswer();
  };

  return {
    async info(): Promise<Info> {
      const b = obj(await call("GET", "/"));
      const list = Array.isArray(b.vaults) ? b.vaults : [];
      return {
        chainId: num(b.chainId),
        usdc: addr(b.usdc),
        relayer: addr(b.relayer),
        forDeposit: units(b.forDeposit),
        forFees: units(b.forFees),
        vaults: list.map((v) => {
          const e = obj(v);
          return { name: String(e.name), vault: addr(e.vault) };
        }),
      };
    },
    async handout(address: string, device: string): Promise<{ tx: Hex; forDeposit: bigint; forFees: bigint }> {
      const b = obj(await call("POST", "/handouts", { address, device }));
      return { tx: hex32(b.tx), forDeposit: units(b.forDeposit), forFees: units(b.forFees) };
    },
    async topUp(address: string): Promise<{ tx: Hex; forFees: bigint }> {
      const b = obj(await call("POST", "/fees", { address }));
      return { tx: hex32(b.tx), forFees: units(b.forFees) };
    },
    async declareDefault(name: string): Promise<{ tx: Hex }> {
      const b = obj(await call("POST", "/vaults/" + name + "/defaults"));
      return { tx: hex32(b.tx) };
    },
    async account(address: string): Promise<AccountInfo> {
      const b = obj(await call("GET", "/accounts/" + address));
      return { nonce: num(b.nonce), maxFeePerGas: units(b.maxFeePerGas), maxPriorityFeePerGas: units(b.maxPriorityFeePerGas), balance: units(b.balance) };
    },
    async relay(raw: Hex | string): Promise<{ tx: Hex }> {
      const b = obj(await call("POST", "/transactions", { raw }));
      return { tx: hex32(b.tx) };
    },
  };
}

export type RelayerApi = ReturnType<typeof relayerApi>;
