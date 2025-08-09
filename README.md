# KasOracle — Hardened Optimistic Oracle for Kaspa EVM (Kasplex)

**Highlights**
- Optimistic, bonded escalation with **commit–reveal**
- **Geometric bond multiplier** (2–6x) throttles griefing
- **Escalation bond** to deter spam arbitration
- **SafeERC20 + ReentrancyGuard + Ownable2Step**
- **No tokenwide governance**, pluggable **Arbitrator** (swap in your DisputeDAO)
- Strict **question templates** (hash) and bounds for categorical/scalar

> ⚠️ Security note: No oracle is “fully secure.” This implementation follows best practices, but you should still 1) put ownership under a multisig + timelock, 2) run fuzz/invariant tests, and 3) commission an external audit before moving large value.

## Contracts
- `contracts/KasOracle.sol` — core oracle
- `contracts/SimpleArbitrator.sol` — MVP arbitrator (owner ruled). Replace with DisputeDAO.
- `contracts/interfaces/IArbitrator.sol`, `IOracleConsumer.sol`
- Vendored minimal OZ: `IERC20`, `SafeERC20`, `ReentrancyGuard`, `Ownable2Step`

## Install & Build
```bash
npm i
npm run compile
```

## Deploy (Kasplex)

This repository ships with two deployment paths:

- **Custom Node.js deployer** (`scripts/deploy.js`): Signs transactions locally and sends them via `eth_sendRawTransaction`. This approach avoids serialization issues seen with the Kasplex RPC. It can also run automatically on Heroku via the provided `server.js`. Use this for production deployments.
- **Hardhat deploy (TypeScript)** (`scripts/deploy.ts`): Uses Hardhat’s built‑in deployment flow. Kept for reference and testing.

### Deploy using the custom script

Set environment variables and run:

```bash
# Required
export RPC_URL="https://rpc.kasplextest.xyz"      # RPC endpoint
export PRIVATE_KEY="0xYOUR_PRIVATE_KEY"           # Deployer key (0x prefix optional)
export BOND_TOKEN="0xYourBondErc20"               # ERC‑20 used for bonds
export FEE_SINK="0xYourTreasuryMultisig"         # Treasury address for fees
# Optional
export OWNER="0xOwnerAddress"                     # Owner of the contracts (defaults to deployer)
export AUTO_DEPLOY_ON_START=true                   # (Heroku) Auto‑deploy on boot

npm install
npm run compile
npm run deploy
```

If you already have deployed contracts and only want to record their addresses, set `ORACLE_ADDRESS_OVERRIDE` and/or `ARBITRATOR_ADDRESS_OVERRIDE`.

### Deploy using the Hardhat script (TS)

You can still use the original script:

```bash
export RPC_URL="https://rpc.kasplextest.xyz"
export PRIVATE_KEY="0xYOUR_PRIVATE_KEY"
export BOND_TOKEN="0xYourBondErc20"
export FEE_SINK="0xYourTreasuryMultisig"
# optional
export OWNER="0xOwner"
npm run deploy:ts
```

## Using the Oracle
1. **Create a question** (onlyOwner):
   - Fill `QuestionParams`:
     - `qtype`: BINARY/CATEGORICAL/SCALAR
     - bounds/options, `timeout` (5m–7d), `bondMultiplier` (2–6), `maxRounds` (≤10)
     - `templateHash`, `dataSource`, optional `consumer`, `openingTs`
   - `createQuestion(params, salt)` → `questionId`

2. **Commit** (any reporter):
   - `hash = keccak256(abi.encode(questionId, encodedOutcome, salt, reporter))`
   - `commit(questionId, hash)` after `openingTs`

3. **Reveal**:
   - `reveal(questionId, encodedOutcome, salt, bond)` with ERC20 approved
   - `bond >= max(minBaseBond, prevBond*bondMultiplier)`

4. **Finalize**:
   - If timeout passes with no higher bonded challenge → `finalize(questionId)`
   - Or `escalate(questionId)` (pays `escalationBond`); arbitrator later calls back

5. **Arbitration outcome**:
   - Arbitrator calls `receiveArbitratorRuling(questionId, encodedOutcome, payee)`
   - If `payee` is 0 and outcome equals optimistic answer → pays optimistic reporter
   - Otherwise pays `payee`. If neither, pool is slashed to `feeSink`
   - Escalation bond refunded iff arbitrator overturns optimistic result

## Recommended Ops Hardening
- Put `owner` behind a **multisig** (e.g., Safe) and/or **timelock**
- Store `feeSink` as a DAO-controlled address
- Set `minBaseBond` to materially non-trivial (e.g., 10–100 USD equivalent)
- Monitor and rotate arbitrator as your DisputeDAO comes online
- Run static analysis (Slither) and fuzzing (Foundry) on your fork

## Minimal API for Markets
- Track `QuestionCreated`, `Revealed`, `Finalized`, `Arbitrated`
- Optional: implement `onOracleFinalize(bytes32,bytes)` on market contracts

## License
MIT
