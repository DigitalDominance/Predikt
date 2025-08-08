// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbitrator} from "./interfaces/IArbitrator.sol";

interface IOracleHook {
    function receiveArbitratorRuling(bytes32 questionId, bytes calldata encodedOutcome, address payee) external;
}

/// @notice MVP arbitrator. Replace with your DisputeDAO in production.
contract SimpleArbitrator is IArbitrator {
    address public owner;
    address public oracle;

    event ArbitrationRequested(bytes32 indexed questionId, address indexed requester);
    event Ruled(bytes32 indexed questionId, bytes encodedOutcome, address payee);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _owner, address _oracle) {
        owner = _owner;
        oracle = _oracle;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function requestArbitration(bytes32 questionId) external override {
        emit ArbitrationRequested(questionId, msg.sender);
    }

    /// @notice Admin ruling call for MVP (swap this out with DAO logic).
    function adminRule(bytes32 questionId, bytes calldata encodedOutcome, address payee) external onlyOwner {
        IOracleHook(oracle).receiveArbitratorRuling(questionId, encodedOutcome, payee);
        emit Ruled(questionId, encodedOutcome, payee);
    }
}
