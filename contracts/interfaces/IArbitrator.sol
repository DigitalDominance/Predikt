// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal arbitrator interface used by the oracle to request rulings.
interface IArbitrator {
    /// @notice Ask the arbitrator to decide a question
    function requestArbitration(bytes32 questionId) external;
}
