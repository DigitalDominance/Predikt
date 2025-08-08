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
Set env and run:
```bash
export RPC_URL="https://rpc.kasplextest.xyz"
export PRIVATE_KEY="0xYOUR_PRIVATE_KEY"
export BOND_TOKEN="0xYourBondErc20"
export FEE_SINK="0xYourTreasuryMultisig"
# optional
export OWNER="0xOwner"
npm run deploy
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
