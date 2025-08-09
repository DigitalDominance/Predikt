import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  // Ensure that scripts run on the Kasplex network by default. Without this,
  // `hre.ethers.provider` will point to the Hardhat in‑memory network when
  // scripts are executed via `node`, which is not what we want. Setting
  // defaultNetwork here means both Hardhat CLI and our custom deploy script
  // will use the kasplex RPC unless overridden.
  defaultNetwork: "kasplex",
  networks: {
    kasplex: {
      url: process.env.RPC_URL || "https://rpc.kasplextest.xyz",
      chainId: 167012,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  }
};

export default config;
