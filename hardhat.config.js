// hardhat.config.js
require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

const {
  KASPA_TESTNET_RPC,
  RPC_URL,                 // optional fallback
  PRIVATE_KEY,
  BLOCKSCOUT_API_KEY,      // optional unless you run `verify`
} = process.env;

const URL = KASPA_TESTNET_RPC || RPC_URL; // allow either env var

module.exports = {
  // Your contracts use ^0.8.24 pragmas, so compile with 0.8.24
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 50 },
      // IR helps reduce bytecode size and link-time bloat
      viaIR: true,
    },
  },

  // So your scripts run on Kaspa testnet by default (no --network needed)
  defaultNetwork: "kaspaTestnet",

  networks: {
    hardhat: { allowUnlimitedContractSize: true }, // dev only
    kaspaTestnet: {
      url: URL || "https://rpc.kasplextest.xyz",
      chainId: 167012,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      // tip: you can set a small multiplier if needed:
      // gasMultiplier: 1.1,
    },
  },

  // Blockscout-style verify (optional; won’t block deploys if not used)
  etherscan: {
    apiKey: { kaspaTestnet: BLOCKSCOUT_API_KEY || "placeholder" },
    customChains: [
      {
        network: "kaspaTestnet",
        chainId: 167012,
        urls: {
          apiURL: "https://frontend.kasplextest.xyz/api",
          browserURL: "https://frontend.kasplextest.xyz",
        },
      },
    ],
  },

  sourcify: { enabled: false },
};
