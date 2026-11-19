import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";

// Networks carry no key here. No deployment is done from this package; the tests run on the
// in-process node only (`hardhat test nodejs`).
export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.38",
    settings: {
      evmVersion: "prague",
      optimizer: { enabled: true, runs: 200 },
    },
  },
});
