// scripts/deploy.js

/*
 * Custom deployment script for the KasOracle and SimpleArbitrator
 *
 * This script mirrors the functionality of the original TypeScript deploy
 * (scripts/deploy.ts) but uses a manual transaction signing flow. The goal
 * is to avoid issues with Hardhat’s built in transaction wrappers on
 * non‑standard RPC providers (Kasplex) that can sometimes return hashes
 * without a 0x prefix or omit contract addresses in receipts. By signing
 * transactions locally and sending them via eth_sendRawTransaction, we
 * control the entire lifecycle and can normalise hashes and wait for
 * receipts ourselves.
 *
 * Environment variables:
 *   PRIVATE_KEY   – Deployer’s private key (hex string with or without 0x)
 *   BOND_TOKEN    – Address of the ERC20 used for bonds (e.g. WKAS or stable)
 *   FEE_SINK      – Treasury address that receives fees
 *   OWNER         – (Optional) Owner of the oracle and arbitrator. Defaults to deployer
 *   SKIP_DEPLOY   – If set to "true", skips deployment entirely
 *
 * Optional overrides:
 *   ORACLE_ADDRESS_OVERRIDE        – Use this to specify an existing KasOracle address
 *   ARBITRATOR_ADDRESS_OVERRIDE    – Use this to specify an existing SimpleArbitrator address
 *
 * When both override vars are provided, the script will skip deploying new
 * contracts and simply record the existing addresses into deployments.json.
 */

require('dotenv').config();
const hre = require('hardhat');
const fs = require('fs');

// Helper: ensure a hex string has a 0x prefix
function ensure0x(h) {
  return typeof h === 'string' && !h.startsWith('0x') ? `0x${h}` : h;
}

// Helper: sleep for ms milliseconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helper: catch queue/full errors from the RPC (Kasplex txpool)
function isQueueErr(e) {
  const m = (e?.message || String(e)).toLowerCase();
  return m.includes('no available queue') || m.includes('queue full') || m.includes('txpool is full');
}

async function withQueueRetries(fn, label) {
  const BASE = Number(process.env.RETRY_BASE_MS || 2500);
  const MAX = Number(process.env.RETRY_MAX_MS || 120000);
  const FACT = Number(process.env.RETRY_FACTOR || 1.7);
  let i = 0;
  let lastLog = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isQueueErr(err)) throw err;
      const delay = Math.min(Math.floor(BASE * Math.pow(FACT, i)), MAX);
      const jitter = Math.floor(delay * 0.2 * (Math.random() * 2 - 1));
      const waitMs = Math.max(1000, delay + jitter);
      const now = Date.now();
      if (now - lastLog > 15000) {
        console.warn(`[DEPLOY] ${label}: queue unavailable; retry #${i + 1} in ~${Math.round(waitMs / 1000)}s`);
        lastLog = now;
      }
      await sleep(waitMs);
      i++;
    }
  }
}

// Wait until the txpool queue for the account empties out
async function waitForQueue(addr, maxMs = 120000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const [pending, latest] = await Promise.all([
        hre.ethers.provider.getTransactionCount(addr, 'pending'),
        hre.ethers.provider.getTransactionCount(addr, 'latest'),
      ]);
      if (pending <= latest) return;
      if (Date.now() - start > maxMs) return;
      await sleep(1500);
    } catch (err) {
      console.warn(`[DEPLOY] Error checking queue for ${addr}:`, err.message);
      await sleep(2000);
      if (Date.now() - start > maxMs) return;
    }
  }
}

// Wait for a transaction receipt using only a 0x-prefixed hash. If the RPC
// never returns a receipt, this will throw after maxWaitMs.
async function waitForReceipt(provider, txHash, maxWaitMs = 300000) {
  const start = Date.now();
  const hash = ensure0x(txHash);
  console.log(`[DEPLOY] Waiting for receipt: ${hash}`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    } catch (e) {
      console.warn(`[DEPLOY] getReceipt error for ${hash}:`, e.message);
    }
    await sleep(2500);
  }
  throw new Error(`Receipt not found after ${maxWaitMs}ms for ${hash}`);
}

// Compute the future CREATE address for a contract given a sender and nonce
function getCreateAddress(from, nonce) {
  if (hre.ethers.getCreateAddress) {
    return hre.ethers.getCreateAddress({ from, nonce }); // v6
  }
  if (hre.ethers.utils?.getContractAddress) {
    return hre.ethers.utils.getContractAddress({ from, nonce }); // v5
  }
  throw new Error('Cannot compute create address');
}

async function main() {
  if (process.env.SKIP_DEPLOY === 'true') {
    console.log('⚡ SKIP_DEPLOY is true — skipping contract deployment');
    return;
  }

  const pkRaw = process.env.PRIVATE_KEY;
  if (!pkRaw) throw new Error('❌ PRIVATE_KEY is required');
  const PRIVATE_KEY = pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`;

  const BOND_TOKEN = process.env.BOND_TOKEN;
  const FEE_SINK = process.env.FEE_SINK;
  const OWNER = process.env.OWNER;

  if (!BOND_TOKEN) throw new Error('❌ BOND_TOKEN is required');
  if (!FEE_SINK) throw new Error('❌ FEE_SINK is required');
  if (!BOND_TOKEN.startsWith('0x')) throw new Error('❌ BOND_TOKEN must be 0x-prefixed');

  await hre.run('compile');

  const provider = hre.ethers.provider;
  const wallet = new hre.ethers.Wallet(PRIVATE_KEY, provider);

  console.log('[DEPLOY] Network:', hre.network.name);
  console.log('[DEPLOY] Deployer:', wallet.address);

  // Determine owner
  const owner = OWNER || wallet.address;
  console.log('[DEPLOY] Owner:', owner);

  // Optional overrides
  const overrideOracleRaw = process.env.ORACLE_ADDRESS_OVERRIDE;
  const overrideArbRaw = process.env.ARBITRATOR_ADDRESS_OVERRIDE;

  let oracleAddress;
  let arbitratorAddress;

  // Deploy SimpleArbitrator if no override provided
  if (overrideArbRaw) {
    arbitratorAddress = ensure0x(overrideArbRaw);
    console.log(`[DEPLOY] ⚠️ Using override for SimpleArbitrator: ${arbitratorAddress}`);
  } else {
    // Get factory and connect to wallet
    const ArbitFactory = await hre.ethers.getContractFactory('SimpleArbitrator');
    const Arbit = ArbitFactory.connect(wallet);

    // Precalculate nonce to compute predicted address
    await waitForQueue(wallet.address);
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    const predicted = getCreateAddress(wallet.address, nonce);
    console.log(`[DEPLOY] SimpleArbitrator predicted address: ${predicted}`);

    // Build deployment transaction (owner + zero oracle)
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    const deployTx = await Arbit.getDeployTransaction(owner, zeroAddress);
    const req = {
      from: wallet.address,
      to: undefined,
      data: deployTx.data,
      nonce,
    };
    const gasLimit = await wallet.estimateGas(req);
    req.gasLimit = gasLimit;
    console.log(`[DEPLOY] SimpleArbitrator estimated gas: ${gasLimit.toString()}`);
    // Populate, sign and send
    const populated = await wallet.populateTransaction(req);
    const signed = await withQueueRetries(() => wallet.signTransaction(populated), 'SimpleArbitrator sign');
    const txHashRaw = await withQueueRetries(
      () => provider.send('eth_sendRawTransaction', [signed]),
      'SimpleArbitrator sendRaw'
    );
    const txHash = ensure0x(txHashRaw);
    if (txHash !== txHashRaw) {
      console.log(`[DEPLOY] SimpleArbitrator RPC returned non-0x hash; normalized -> ${txHash}`);
    }
    console.log(`[DEPLOY] SimpleArbitrator tx: ${txHash}`);
    // Wait for receipt
    let finalAddr = predicted;
    try {
      const receipt = await withQueueRetries(() => waitForReceipt(provider, txHash), 'SimpleArbitrator wait');
      if (receipt?.contractAddress) finalAddr = ensure0x(receipt.contractAddress);
      console.log(`[DEPLOY] ✅ SimpleArbitrator deployed at: ${finalAddr} (block ${receipt.blockNumber})`);
    } catch (e) {
      console.warn(`[DEPLOY] ⚠️ SimpleArbitrator receipt unavailable; using predicted address: ${finalAddr}`);
    }
    arbitratorAddress = finalAddr;
  }

  // Deploy KasOracle if no override provided
  if (overrideOracleRaw) {
    oracleAddress = ensure0x(overrideOracleRaw);
    console.log(`[DEPLOY] ⚠️ Using override for KasOracle: ${oracleAddress}`);
  } else {
    const OracleFactory = await hre.ethers.getContractFactory('KasOracle');
    const Oracle = OracleFactory.connect(wallet);
    // Wait for queue and compute predicted address
    await waitForQueue(wallet.address);
    const nonce2 = await provider.getTransactionCount(wallet.address, 'pending');
    const predictedOracle = getCreateAddress(wallet.address, nonce2);
    console.log(`[DEPLOY] KasOracle predicted address: ${predictedOracle}`);
    // Build deploy tx: (bondToken, arbitrator, feeSink, owner)
    const deployTxOracle = await Oracle.getDeployTransaction(BOND_TOKEN, arbitratorAddress, FEE_SINK, owner);
    const req2 = {
      from: wallet.address,
      to: undefined,
      data: deployTxOracle.data,
      nonce: nonce2,
    };
    const gasLimit2 = await wallet.estimateGas(req2);
    req2.gasLimit = gasLimit2;
    console.log(`[DEPLOY] KasOracle estimated gas: ${gasLimit2.toString()}`);
    const populated2 = await wallet.populateTransaction(req2);
    const signed2 = await withQueueRetries(() => wallet.signTransaction(populated2), 'KasOracle sign');
    const txHashRaw2 = await withQueueRetries(
      () => provider.send('eth_sendRawTransaction', [signed2]),
      'KasOracle sendRaw'
    );
    const txHash2 = ensure0x(txHashRaw2);
    if (txHash2 !== txHashRaw2) {
      console.log(`[DEPLOY] KasOracle RPC returned non-0x hash; normalized -> ${txHash2}`);
    }
    console.log(`[DEPLOY] KasOracle tx: ${txHash2}`);
    let finalOracle = predictedOracle;
    try {
      const rec2 = await withQueueRetries(() => waitForReceipt(provider, txHash2), 'KasOracle wait');
      if (rec2?.contractAddress) finalOracle = ensure0x(rec2.contractAddress);
      console.log(`[DEPLOY] ✅ KasOracle deployed at: ${finalOracle} (block ${rec2.blockNumber})`);
    } catch (e) {
      console.warn(`[DEPLOY] ⚠️ KasOracle receipt unavailable; using predicted address: ${finalOracle}`);
    }
    oracleAddress = finalOracle;
  }

  // If we deployed both contracts (no override), wire arbitrator to oracle
  if (!overrideArbRaw || !overrideOracleRaw) {
    console.log('[DEPLOY] Wiring arbitrator to oracle...');
    // Build call to setOracle(oracleAddress)
    const ArbitFactory = await hre.ethers.getContractFactory('SimpleArbitrator');
    const arbInterface = ArbitFactory.interface;
    const data = arbInterface.encodeFunctionData('setOracle', [oracleAddress]);
    // Build transaction
    await waitForQueue(wallet.address);
    const nonce3 = await provider.getTransactionCount(wallet.address, 'pending');
    const txReq = {
      from: wallet.address,
      to: arbitratorAddress,
      data,
      nonce: nonce3,
    };
    const gasLimit3 = await wallet.estimateGas(txReq);
    txReq.gasLimit = gasLimit3;
    console.log(`[DEPLOY] setOracle estimated gas: ${gasLimit3.toString()}`);
    const populated3 = await wallet.populateTransaction(txReq);
    const signed3 = await withQueueRetries(() => wallet.signTransaction(populated3), 'setOracle sign');
    const txHashRaw3 = await withQueueRetries(
      () => provider.send('eth_sendRawTransaction', [signed3]),
      'setOracle sendRaw'
    );
    const txHash3 = ensure0x(txHashRaw3);
    if (txHash3 !== txHashRaw3) {
      console.log(`[DEPLOY] setOracle RPC returned non-0x hash; normalized -> ${txHash3}`);
    }
    console.log(`[DEPLOY] setOracle tx: ${txHash3}`);
    try {
      const rec3 = await withQueueRetries(() => waitForReceipt(provider, txHash3), 'setOracle wait');
      console.log(`[DEPLOY] ✅ setOracle confirmed at block ${rec3.blockNumber}`);
    } catch (e) {
      console.warn('[DEPLOY] ⚠️ setOracle receipt unavailable; transaction may still have executed');
    }
    console.log('[DEPLOY] Arbitrator wired to Oracle.');
  }

  // Write deployments.json
  const deploymentData = {
    network: hre.network.name,
    deployedAt: new Date().toISOString(),
    owner: owner,
    bondToken: BOND_TOKEN,
    feeSink: FEE_SINK,
    arbitrator: ensure0x(arbitratorAddress),
    oracle: ensure0x(oracleAddress),
  };
  fs.writeFileSync('deployments.json', JSON.stringify(deploymentData, null, 2));
  console.log('[DEPLOY] ✅ Wrote deployments.json');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Unhandled error:', err);
    process.exit(1);
  });