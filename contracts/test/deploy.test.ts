// Every value in this file is invented. None is a reading of any market.
// The deployment script, run against the local chain. On Arc a person starts it from a one-shot
// unit on the host; no session ever does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getContractAddress, type Address } from "viem";

import { deploy, makeBundle, readTerms, record, type Deployed, type Terms } from "../scripts/deploy.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SOURCE = readFileSync(new URL("../contracts/BondedVault.sol", import.meta.url), "utf8");
const artifactOf = (path: string) => JSON.parse(readFileSync(new URL("../artifacts/contracts/" + path, import.meta.url), "utf8"));

describe("deploy", async function () {
  const { viem } = await network.create();
  const [deployer, operator, other] = await viem.getWalletClients();
  const reader = await viem.getPublicClient();
  const chainId = await reader.getChainId();
  const usdc = await viem.deployContract("TestDollar");
  const bundle = makeBundle(artifactOf("BondedVault.sol/BondedVault.json"), SOURCE);
  const OP = operator.account.address;
  // The file a person keeps beside the unit: every figure of one vault, and its name.
  const file = { name: "stage", operator: OP, drawBondHalves: 3, drawVaultBps: 5000, gainBps: 2000, epochSeconds: 60, capPerMarketMicros: 60_000_000, depositCapMicros: 900_000_000 };
  const terms: Terms = readTerms(file);
  const ask = (over: Partial<Parameters<typeof deploy>[0]> = {}) => deploy({ bundle, chainId, usdc: usdc.address, terms, wallet: deployer, reader, ...over });
  const sent = () => reader.getTransactionCount({ address: deployer.account.address });

  it("the bundle names the contract and carries the SHA-256 of the source it was compiled from", function () {
    assert.equal(bundle.contractName, "BondedVault");
    assert.equal(bundle.sourceSha256, createHash("sha256").update(SOURCE).digest("hex"));
    assert.match(bundle.bytecode, /^0x[0-9a-f]+$/);
    assert.throws(() => makeBundle({ ...artifactOf("BondedVault.sol/BondedVault.json"), contractName: "Other" }, SOURCE), /BondedVault/);
  });

  it("the terms file is read whole: exactly its figures, each in the contract's own range", function () {
    assert.deepEqual(terms, { name: "stage", operator: OP, drawBondHalves: 3, drawVaultBps: 5000, gainBps: 2000, epochSeconds: 60, capPerMarket: 60_000_000n, depositCap: 900_000_000n });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...file, extra: 1 }, /extra is not a figure/],
      [{ ...file, name: "Stage Vault" }, /name/],
      [{ ...file, operator: "0x12" }, /operator/],
      [{ ...file, operator: ZERO }, /operator/],
      [{ ...file, drawBondHalves: 0 }, /drawBondHalves/],
      [{ ...file, drawBondHalves: 5 }, /drawBondHalves/],
      [{ ...file, drawVaultBps: 0 }, /drawVaultBps/],
      [{ ...file, drawVaultBps: 10_000 }, /drawVaultBps/],
      [{ ...file, gainBps: 10_001 }, /gainBps/],
      [{ ...file, gainBps: 20.5 }, /gainBps/],
      [{ ...file, epochSeconds: 0 }, /epochSeconds/],
      [{ ...file, epochSeconds: 2 ** 32 }, /epochSeconds/],
      [{ ...file, capPerMarketMicros: -1 }, /capPerMarketMicros/],
      [{ ...file, depositCapMicros: 0 }, /depositCapMicros/],
      [{ ...file, depositCapMicros: "900" }, /depositCapMicros/],
    ];
    for (const [json, re] of bad) assert.throws(() => readTerms(json), re);
    const { gainBps: _left, ...short } = file;
    assert.throws(() => readTerms(short), /gainBps is missing/);
    assert.throws(() => readTerms([file]), /not an object/);
    assert.equal(readTerms({ ...file, gainBps: 0, capPerMarketMicros: 0 }).gainBps, 0); // both may be none
  });

  it("a deployment answers with its address, and the contract there reads back the token and every figure", async function () {
    const d = await ask();
    const vault = await viem.getContractAt("BondedVault", d.vault);
    assert.equal((await vault.read.usdc()).toLowerCase(), usdc.address.toLowerCase());
    assert.equal((await vault.read.operator()).toLowerCase(), OP.toLowerCase());
    assert.deepEqual(
      [await vault.read.drawBondHalves(), await vault.read.drawVaultBps(), await vault.read.gainBps(), await vault.read.epochSeconds(), await vault.read.capPerMarket(), await vault.read.depositCap()],
      [3, 5000, 2000, 60, 60_000_000n, 900_000_000n],
    );
    assert.deepEqual(
      { ...d, vault: "", usdc: d.usdc.toLowerCase(), operator: d.operator.toLowerCase(), deployTx: "", block: "" },
      {
        name: "stage", chainId, vault: "", usdc: usdc.address.toLowerCase(), operator: OP.toLowerCase(), drawBondHalves: 3, drawVaultBps: 5000, gainBps: 2000,
        epochSeconds: 60, capPerMarketMicros: "60000000", depositCapMicros: "900000000", deployTx: "", block: "", sourceSha256: bundle.sourceSha256,
      },
    );
    const receipt = await reader.getTransactionReceipt({ hash: d.deployTx });
    assert.equal(receipt.contractAddress?.toLowerCase(), d.vault.toLowerCase());
    assert.equal(d.block, receipt.blockNumber.toString());
  });

  it("the operator may be the deploying key itself", async function () {
    const d = await ask({ terms: { ...terms, operator: deployer.account.address } });
    assert.equal(d.operator.toLowerCase(), deployer.account.address.toLowerCase());
  });

  it("the wrong chain is refused before anything is sent", async function () {
    const before = await sent();
    await assert.rejects(ask({ chainId: 5042002 }), /this is chain \d+, not 5042002/);
    assert.equal(await sent(), before);
  });

  it("an operator that is zero, the token or the address the contract will get is refused before anything is sent", async function () {
    const before = await sent();
    const next = getContractAddress({ from: deployer.account.address, nonce: BigInt(before) });
    for (const bad of [ZERO, usdc.address, next] as Address[]) await assert.rejects(ask({ terms: { ...terms, operator: bad } }), /operator/);
    assert.equal(await sent(), before);
  });

  it("figures outside the contract's range are refused before anything is sent, not by a revert that was paid for", async function () {
    const before = await sent();
    await assert.rejects(ask({ terms: { ...terms, drawBondHalves: 5 } }), /drawBondHalves/);
    await assert.rejects(ask({ terms: { ...terms, depositCap: 0n } }), /depositCap/);
    await assert.rejects(ask({ terms: { ...terms, depositCap: 2n ** 96n } }), /depositCap/); // the contract takes at most 2^96 - 1
    assert.equal(await sent(), before);
    assert.equal((await ask({ terms: { ...terms, name: "at-the-most", depositCap: 2n ** 96n - 1n } })).depositCapMicros, String(2n ** 96n - 1n));
  });

  it("a token address that does not answer six decimals is refused before anything is sent", async function () {
    const before = await sent();
    const noDecimals = await viem.deployContract("Miswired", [usdc.address, OP, 3, 5000, 2000, 60, 1n, 1n], { client: { wallet: other } });
    await assert.rejects(ask({ usdc: noDecimals.address }), /six decimals/);
    await assert.rejects(ask({ usdc: "0x00000000000000000000000000000000000000aa" }), /six decimals/);
    assert.equal(await sent(), before);
  });

  it("a contract that does not read back what was asked for is reported, with what it does read", async function () {
    const wrong = artifactOf("test/Miswired.sol/Miswired.json");
    await assert.rejects(ask({ bundle: { ...bundle, abi: wrong.abi, bytecode: wrong.bytecode } }), /does not read back what was asked: epochSeconds 61/);
  });

  it("the record keeps each vault under its chain and name, and never replaces one", function () {
    const one = { chainId: 1, name: "vault", vault: OP } as Deployed;
    const two = { chainId: 1, name: "stage", vault: ZERO } as Deployed;
    const book = record(record({}, one), two);
    assert.deepEqual(Object.keys(book), ["1:vault", "1:stage"]);
    assert.throws(() => record(book, { ...one, vault: ZERO }), /chain 1 already has a vault called vault/);
    assert.equal(book["1:vault"].vault, OP);
  });
});
