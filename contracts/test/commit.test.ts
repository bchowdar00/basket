// Every value in this file is invented. None is a reading of any market.
// The engine's `viemSender` run against BondedVault over real HTTP: Hardhat's own JSON-RPC server
// on localhost, with Hardhat's published test accounts (the well-known "test ... junk" mnemonic).
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import hre, { network } from "hardhat";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { asBytes32, viemSender } from "../../services/engine/src/commit.ts";

// Accounts 0 and 1 of Hardhat's default test mnemonic. Public, worthless, never funded anywhere real.
const OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

describe("commit: the engine's sender against the contract", async function () {
  const node = await network.createServer();
  const server = await node.listen();
  const rpc = "http://" + server.address + ":" + server.port;
  const chain = defineChain({ id: 31337, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const wallet = createWalletClient({ account: operator, chain, transport: http(rpc) });
  const reader = createPublicClient({ chain, transport: http(rpc) });

  const deployed = async (name: string, args: unknown[] = []) => {
    const art = await hre.artifacts.readArtifact(name);
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode as Hex, args, account: operator, chain });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return { address: receipt.contractAddress!, abi: art.abi };
  };

  const usdc = await deployed("TestDollar");
  const vault = await deployed("BondedVault", [usdc.address, operator.address, 3, 5000, 2000, 60, 1_000_000_000n, 1_000_000_000_000n]);
  const read = (fn: "head" | "commits") => reader.readContract({ address: vault.address, abi: vault.abi, functionName: fn });
  const sender = (key: Hex) => viemSender({ key, rpc, chainId: 31337, vault: vault.address, timeoutMs: 30_000 });

  after(async function () {
    await node.close();
  });

  it("K1: the operator's sender lands a head: a transaction hash, the head set, one commit", async function () {
    const head = asBytes32("ab".repeat(32));
    const tx = await sender(OPERATOR_KEY).send(head);
    assert.match(tx, /^0x[0-9a-f]{64}$/);
    assert.equal(await read("head"), "0x" + "ab".repeat(32));
    assert.equal(await read("commits"), 1n);
  });

  it("K2: a second head replaces the first and the count goes to two", async function () {
    const tx = await sender(OPERATOR_KEY).send(asBytes32("cd".repeat(32)));
    assert.match(tx, /^0x[0-9a-f]{64}$/);
    assert.equal(await read("head"), "0x" + "cd".repeat(32));
    assert.equal(await read("commits"), 2n);
  });

  it("K3: a sender built from a non-operator key is rejected and nothing changes", async function () {
    await assert.rejects(sender(OTHER_KEY).send(asBytes32("ef".repeat(32))));
    assert.equal(await read("head"), "0x" + "cd".repeat(32));
    assert.equal(await read("commits"), 2n);
  });
});
