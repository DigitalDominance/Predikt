import { ethers } from "hardhat";

async function main() {
  const BOND_TOKEN = process.env.BOND_TOKEN!; // address of ERC20 used for bonds (e.g., WKAS or stable)
  const FEE_SINK = process.env.FEE_SINK!;     // treasury / multisig
  const OWNER = process.env.OWNER || (await ethers.getSigners())[0].address;

  if (!BOND_TOKEN || !FEE_SINK) {
    throw new Error("Please set BOND_TOKEN and FEE_SINK env vars");
  }

  // Deploy a placeholder arbitrator for now. Replace with your DisputeDAO later.
  const SimpleArbitrator = await ethers.getContractFactory("SimpleArbitrator");
  const arbitrator = await SimpleArbitrator.deploy(OWNER, ethers.ZeroAddress);
  await arbitrator.waitForDeployment();
  console.log("SimpleArbitrator:", await arbitrator.getAddress());

  const KasOracle = await ethers.getContractFactory("KasOracle");
  const oracle = await KasOracle.deploy(BOND_TOKEN, await arbitrator.getAddress(), FEE_SINK, OWNER);
  await oracle.waitForDeployment();
  console.log("KasOracle:", await oracle.getAddress());

  // Wire oracle into arbitrator
  const setOracleTx = await arbitrator.setOracle(await oracle.getAddress());
  await setOracleTx.wait();
  console.log("Arbitrator wired to Oracle.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
