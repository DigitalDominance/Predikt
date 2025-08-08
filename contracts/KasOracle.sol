// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
    KasOracle (Hardened):
    - Optimistic, bonded escalation oracle with commit–reveal and arbitrator fallback.
    - SafeERC20, ReentrancyGuard, Ownable2Step.
    - Escalation bond to curb spam; refunds if arbitrator overturns the optimistic result.
    - No tokenwide governance; objective templates + bounds.
    - Admin actions are limited; recommend placing owner under multisig + timelock.
*/

import {IERC20} from "./libs/oz/IERC20.sol";
import {SafeERC20} from "./libs/oz/SafeERC20.sol";
import {ReentrancyGuard} from "./libs/oz/ReentrancyGuard.sol";
import {Ownable2Step} from "./libs/oz/Ownable2Step.sol";
import {IArbitrator} from "./interfaces/IArbitrator.sol";
import {IOracleConsumer} from "./interfaces/IOracleConsumer.sol";

contract KasOracle is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /* ----------------------------- Admin / Config ---------------------------- */

    IERC20 public immutable bondToken;      // e.g., stable or WKAS-ERC20
    IArbitrator public arbitrator;          // pluggable arbitrator
    address public feeSink;                 // treasury / multisig
    uint256 public feeBps = 200;            // 2% protocol fee
    uint256 public minBaseBond = 1e18;      // minimum base bond (default 1 token)
    uint256 public escalationBond = 1e17;   // 0.1 token by default
    bool    public paused;                  // circuit breaker for new actions

    uint256 public constant BPS = 10_000;
    uint8    public constant MAX_BOND_MULTIPLIER = 6;
    uint8    public constant MIN_BOND_MULTIPLIER = 2;
    uint8    public constant MAX_MAX_ROUNDS = 10;

    event FeeSinkUpdated(address sink);
    event FeeBpsUpdated(uint256 bps);
    event ArbitratorUpdated(address arbitrator);
    event MinBaseBondUpdated(uint256 amount);
    event EscalationBondUpdated(uint256 amount);
    event Paused(bool status);

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    /* ----------------------------- Question Types ---------------------------- */

    enum QuestionType { BINARY, CATEGORICAL, SCALAR }

    struct QuestionParams {
        QuestionType qtype;
        uint32 options;           // for categorical (<= 256)
        int256 scalarMin;         // for scalar
        int256 scalarMax;         // for scalar
        uint32 scalarDecimals;    // fixed-point decimals for scalar (metadata)
        uint32 timeout;           // seconds of liveness per round
        uint8 bondMultiplier;     // geometric factor (>=2 && <=6)
        uint8 maxRounds;          // after this → arbitration (<=10)
        bytes32 templateHash;     // hash of the question text/template
        string dataSource;        // human-readable URL/IPFS for clarity
        address consumer;         // optional IOracleConsumer
        uint64 openingTs;         // when event “closes” (no answers before)
    }

    enum Status { NONE, OPEN, FINALIZED, ARBITRATED }

    struct Answer {
        address reporter;
        bytes encoded;        // ABI-encoded outcome
        uint256 bond;         // bond posted with this answer
        uint64 ts;            // reveal timestamp
    }

    struct Question {
        Status status;
        QuestionParams params;
        bytes32 bestCommit;       // current liveness’ commit hash (optional)
        Answer bestAnswer;        // highest bonded revealed answer
        uint8 round;              // number of revealed rounds so far
        uint64 lastActionTs;      // last reveal; used to compute timeout expiry
        uint256 totalBondsAtStake; // sum of all posted bonds
        address escalator;        // who paid escalationBond
        uint256 escalatorBond;    // amount paid as escalation bond
        mapping(address => bytes32) commits; // reporter => commit hash
        mapping(address => uint256) bonded;  // reporter => total bonds locked
    }

    mapping(bytes32 => Question) internal questions;

    /* --------------------------------- Events -------------------------------- */

    event QuestionCreated(bytes32 indexed id, QuestionParams params);
    event Committed(bytes32 indexed id, address indexed reporter, bytes32 commit);
    event Revealed(bytes32 indexed id, address indexed reporter, bytes encoded, uint256 bond, uint8 round);
    event Finalized(bytes32 indexed id, bytes encoded, address winner, uint256 winnerPayout);
    event Disputed(bytes32 indexed id, address indexed by, uint256 newBond, uint8 round);
    event Escalated(bytes32 indexed id, uint8 round, address indexed escalator);
    event Arbitrated(bytes32 indexed id, bytes encoded, address payee);

    /* ------------------------------- Constructor ----------------------------- */

    constructor(IERC20 _bondToken, IArbitrator _arbitrator, address _feeSink, address initialOwner)
        Ownable2Step(initialOwner)
    {
        require(address(_bondToken) != address(0), "bond token zero");
        require(address(_arbitrator) != address(0), "arb zero");
        require(_feeSink != address(0), "fee sink zero");
        bondToken = _bondToken;
        arbitrator = _arbitrator;
        feeSink = _feeSink;
    }

    /* ------------------------------- Admin funcs ----------------------------- */

    function setFeeSink(address _sink) external onlyOwner {
        require(_sink != address(0), "zero sink");
        feeSink = _sink;
        emit FeeSinkUpdated(_sink);
    }

    function setFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 1000, "fee too high"); // max 10%
        feeBps = _bps;
        emit FeeBpsUpdated(_bps);
    }

    function setArbitrator(IArbitrator _arb) external onlyOwner {
        require(address(_arb) != address(0), "arb zero");
        arbitrator = _arb;
        emit ArbitratorUpdated(address(_arb));
    }

    function setMinBaseBond(uint256 amt) external onlyOwner {
        require(amt > 0, "zero base bond");
        minBaseBond = amt;
        emit MinBaseBondUpdated(amt);
    }

    function setEscalationBond(uint256 amt) external onlyOwner {
        require(amt > 0, "zero escalation bond");
        escalationBond = amt;
        emit EscalationBondUpdated(amt);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    /// @notice Rescue non-bond tokens only; bondToken is intentionally non-withdrawable.
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(bondToken), "cannot rescue bondToken");
        IERC20(token).safeTransfer(to, amount);
    }

    /* ------------------------------ Lib: Utilities --------------------------- */

    function _requireOpen(bytes32 id) internal view {
        require(questions[id].status == Status.OPEN, "not open");
    }

    function _livenessExpired(Question storage q) internal view returns (bool) {
        return (block.timestamp > (uint256(q.lastActionTs) + q.params.timeout));
    }

    /* ---------------------------- Public: Create Q --------------------------- */

    /// @notice Deterministic id for identical params + salt
    function computeQuestionId(QuestionParams calldata p, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(p, salt));
    }

    function createQuestion(QuestionParams calldata p, bytes32 salt) external onlyOwner notPaused returns (bytes32 id) {
        require(p.timeout >= 5 minutes && p.timeout <= 7 days, "bad timeout");
        require(p.bondMultiplier >= MIN_BOND_MULTIPLIER && p.bondMultiplier <= MAX_BOND_MULTIPLIER, "bad multiplier");
        require(p.maxRounds >= 1 && p.maxRounds <= MAX_MAX_ROUNDS, "bad maxRounds");
        if (p.qtype == QuestionType.CATEGORICAL) require(p.options >= 2 && p.options <= 256, "bad options");
        if (p.qtype == QuestionType.SCALAR) require(p.scalarMin < p.scalarMax, "bad scalar range");
        require(p.openingTs <= block.timestamp + 365 days, "opening too far");

        id = computeQuestionId(p, salt);
        Question storage q = questions[id];
        require(q.status == Status.NONE, "exists");

        q.status = Status.OPEN;
        q.params = p;
        q.lastActionTs = uint64(block.timestamp); // start ticking for commits

        emit QuestionCreated(id, p);
    }

    /* --------------------------- Commit → Reveal Flow ------------------------ */

    /// @notice Commit: hash = keccak256(abi.encode(questionId, encodedOutcome, salt, msg.sender))
    function commit(bytes32 id, bytes32 hashCommit) external notPaused {
        _requireOpen(id);
        Question storage q = questions[id];
        require(block.timestamp >= q.params.openingTs, "not opened");
        q.commits[msg.sender] = hashCommit;
        emit Committed(id, msg.sender, hashCommit);
    }

    /// @notice Anyone can re-commit during liveness; prevents “no one else can join” problems
    function recommit(bytes32 id, bytes32 hashCommit) external notPaused {
        _requireOpen(id);
        Question storage q = questions[id];
        require(block.timestamp >= q.params.openingTs, "not opened");
        q.commits[msg.sender] = hashCommit;
        emit Committed(id, msg.sender, hashCommit);
    }

    /// @notice Reveal a committed answer with a bond
    /// @param encodedOutcome ABI-encoded per question type (bool, uint256, or int256)
    /// @param salt arbitrary salt used in commit
    /// @param bond amount of ERC20 to bond (must be >= required)
    function reveal(bytes32 id, bytes calldata encodedOutcome, bytes32 salt, uint256 bond)
        external
        notPaused
        nonReentrant
    {
        _requireOpen(id);
        Question storage q = questions[id];

        bytes32 check = keccak256(abi.encode(id, encodedOutcome, salt, msg.sender));
        require(q.commits[msg.sender] == check, "bad commit");

        // compute min bond: either base or prevBond * multiplier
        uint256 minBond = q.bestAnswer.bond == 0 ? minBaseBond : q.bestAnswer.bond * q.params.bondMultiplier;
        require(bond >= minBond, "bond too low");

        // Validate outcome bounds per type to avoid out-of-range disputes
        if (q.params.qtype == QuestionType.CATEGORICAL) {
            uint256 idx = abi.decode(encodedOutcome, (uint256));
            require(idx < uint256(q.params.options), "bad category");
        } else if (q.params.qtype == QuestionType.SCALAR) {
            int256 v = abi.decode(encodedOutcome, (int256));
            require(v >= q.params.scalarMin && v <= q.params.scalarMax, "bad scalar");
        } else {
            // binary: abi.decode(bool) always valid; gas check via decode
            abi.decode(encodedOutcome, (bool));
        }

        // Pull bond
        bondToken.safeTransferFrom(msg.sender, address(this), bond);

        // Book-keep
        q.bestCommit = bytes32(0); // consumed
        q.round += 1;
        q.lastActionTs = uint64(block.timestamp);
        q.totalBondsAtStake += bond;
        q.bonded[msg.sender] += bond;

        // Update best
        q.bestAnswer = Answer({
            reporter: msg.sender,
            encoded: encodedOutcome,
            bond: bond,
            ts: uint64(block.timestamp)
        });

        emit Revealed(id, msg.sender, encodedOutcome, bond, q.round);
        if (q.round > 1) emit Disputed(id, msg.sender, bond, q.round);

        // Auto-escalate if max rounds exceeded
        if (q.round >= q.params.maxRounds) {
            _escalate(id, q, address(0), 0, false);
        }
    }

    /* -------------------------- Time-based Finalization ---------------------- */

    /// @notice Finalize if liveness expired without a higher bonded challenge
    function finalize(bytes32 id) external nonReentrant {
        _requireOpen(id);
        Question storage q = questions[id];
        require(q.bestAnswer.reporter != address(0), "no answer");
        require(_livenessExpired(q), "liveness not expired");

        q.status = Status.FINALIZED;

        // Payout: winner gets all losing bonds minus fee
        uint256 pool = q.totalBondsAtStake;
        uint256 fee = pool * feeBps / BPS;
        uint256 payout = pool - fee;

        if (fee > 0 && feeSink != address(0)) {
            bondToken.safeTransfer(feeSink, fee);
        }
        bondToken.safeTransfer(q.bestAnswer.reporter, payout);

        emit Finalized(id, q.bestAnswer.encoded, q.bestAnswer.reporter, payout);

        // Optional notify consumer market (best-effort)
        if (q.params.consumer != address(0)) {
            (bool ok, ) = q.params.consumer.call(
                abi.encodeWithSelector(IOracleConsumer.onOracleFinalize.selector, id, q.bestAnswer.encoded)
            );
            ok;
        }
    }

    /* ------------------------------ Escalation ------------------------------- */

    function escalate(bytes32 id) external notPaused nonReentrant {
        _requireOpen(id);
        Question storage q = questions[id];
        require(q.escalator == address(0), "already escalated");
        // Take escalation bond
        bondToken.safeTransferFrom(msg.sender, address(this), escalationBond);
        _escalate(id, q, msg.sender, escalationBond, true);
    }

    function _escalate(bytes32 id, Question storage q, address escalator_, uint256 bond_, bool newBond) internal {
        q.status = Status.ARBITRATED;
        if (newBond) {
            q.escalator = escalator_;
            q.escalatorBond = bond_;
        }
        emit Escalated(id, q.round, escalator_);
        arbitrator.requestArbitration(id);
    }

    /// @notice Arbitrator callback (via adapter). Final, overrides any optimistic outcome.
    /// @param payee If nonzero, receives payout; else if matches optimistic answer, winner is best reporter.
    function receiveArbitratorRuling(bytes32 id, bytes calldata encodedOutcome, address payee)
        external
        nonReentrant
    {
        require(msg.sender == address(arbitrator), "only arbitrator");
        Question storage q = questions[id];
        require(q.status == Status.ARBITRATED, "not arbitrating");

        q.status = Status.FINALIZED;

        uint256 pool = q.totalBondsAtStake;
        uint256 fee = pool * feeBps / BPS;
        uint256 payout = pool - fee;

        if (fee > 0 && feeSink != address(0)) {
            bondToken.safeTransfer(feeSink, fee);
        }

        address winner = payee;
        if (winner == address(0)) {
            // Fallback to optimistic reporter when outcome matches
            if (keccak256(encodedOutcome) == keccak256(q.bestAnswer.encoded)) {
                winner = q.bestAnswer.reporter;
            }
        }

        if (winner != address(0)) {
            bondToken.safeTransfer(winner, payout);
        } else {
            // If arbitrator outcome rejects optimistic answer and no payee specified,
            // slash pool to the fee sink (can be DAO treasury).
            bondToken.safeTransfer(feeSink, payout);
        }

        // Escalation bond: refund if arbitrator overturned optimistic result; else send to feeSink
        if (q.escalator != address(0) && q.escalatorBond > 0) {
            bool overturned = (winner != q.bestAnswer.reporter);
            if (overturned) {
                bondToken.safeTransfer(q.escalator, q.escalatorBond);
            } else {
                bondToken.safeTransfer(feeSink, q.escalatorBond);
            }
            q.escalatorBond = 0;
            q.escalator = address(0);
        }

        emit Arbitrated(id, encodedOutcome, winner);

        if (q.params.consumer != address(0)) {
            (bool ok, ) = q.params.consumer.call(
                abi.encodeWithSelector(IOracleConsumer.onOracleFinalize.selector, id, encodedOutcome)
            );
            ok;
        }
    }

    /* --------------------------------- Views --------------------------------- */

    function getStatus(bytes32 id) external view returns (Status) {
        return questions[id].status;
    }

    function getParams(bytes32 id) external view returns (QuestionParams memory) {
        return questions[id].params;
    }

    function getBestAnswer(bytes32 id) external view returns (Answer memory) {
        return questions[id].bestAnswer;
    }

    function timeLeft(bytes32 id) external view returns (uint256) {
        Question storage q = questions[id];
        if (q.status != Status.OPEN) return 0;
        uint256 end = uint256(q.lastActionTs) + q.params.timeout;
        return block.timestamp >= end ? 0 : (end - block.timestamp);
    }

    function commitOf(bytes32 id, address reporter) external view returns (bytes32) {
        return questions[id].commits[reporter];
    }
}
