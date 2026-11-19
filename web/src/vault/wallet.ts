// The phone's wallet: a key made in this browser on the first visit with viem's generatePrivateKey,
// kept in localStorage under one name per chain (so a key made for test dollars is never used for
// real ones), used only to sign the phone's own four calls, which the relayer then passes on. The
// key never leaves the account that signs it, and it is lost if the browser's data is cleared — the
// page says so before any result, not after. The pure parts take an injected store so they are
// tested without a browser.
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** The slice of Storage the wallet uses; a memory stand-in with these two methods is enough. */
export type KeyStore = Pick<Storage, "getItem" | "setItem">;

/** A call of the phone's own, with everything the network needs. Value is always zero (the relayer
 * refuses any transaction that moves value). */
export type OwnCall = {
  chainId: number;
  to: Address;
  data: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type VaultWallet = {
  address: Address;
  /** Signs the call as a zero-value EIP-1559 transaction for this chain and gives the raw hex. */
  signCall: (call: OwnCall) => Promise<Hex>;
};

const keyName = (chainId: number) => "basket:vault:key:" + chainId;
const deviceName = "basket:vault:device";

/**
 * The wallet kept in this browser for this chain, made now if there is none. A stored value that
 * does not read as a key is never replaced (it may be the only way to test dollars already held),
 * and a browser that will not keep the key gives no wallet: both throw, and the page says which.
 */
export function loadOrMakeKey(store: KeyStore, chainId: number, make: () => Hex = generatePrivateKey): { wallet: VaultWallet; made: boolean } {
  const name = keyName(chainId);
  let key = store.getItem(name) as Hex | null;
  const made = key === null;
  if (key === null) {
    key = make();
    try {
      store.setItem(name, key);
    } catch {
      throw new Error("this browser cannot keep a wallet");
    }
    if (store.getItem(name) !== key) throw new Error("this browser cannot keep a wallet");
  } else if (!/^0x[0-9a-f]{64}$/.test(key)) {
    throw new Error("the wallet kept in this browser is damaged; it was not replaced");
  }
  const account = privateKeyToAccount(key);
  return {
    made,
    wallet: {
      address: account.address,
      signCall: (call) => {
        if (call.chainId !== chainId) return Promise.reject(new Error("this wallet signs only for its own network"));
        return account.signTransaction({
          type: "eip1559",
          chainId: call.chainId,
          to: call.to,
          data: call.data,
          value: 0n,
          nonce: call.nonce,
          gas: call.gas,
          maxFeePerGas: call.maxFeePerGas,
          maxPriorityFeePerGas: call.maxPriorityFeePerGas,
        });
      },
    },
  };
}

const randomDevice = (): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
};

/** The device id this browser reports to the relayer's handout, made once and kept. Sits inside the
 * relayer's shape (16 to 64 of A-Za-z0-9_-). */
export function deviceId(store: KeyStore, make: () => string = randomDevice): string {
  const held = store.getItem(deviceName);
  if (held !== null && /^[A-Za-z0-9_-]{16,64}$/.test(held)) return held;
  const id = make();
  try {
    store.setItem(deviceName, id);
  } catch {
    // A browser that will not keep it still gets a usable id for this visit.
  }
  return id;
}
