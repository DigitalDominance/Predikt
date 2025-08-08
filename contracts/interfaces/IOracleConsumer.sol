// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracleConsumer {
    /// @notice Optional hook invoked by the oracle after finalization
    function onOracleFinalize(bytes32 questionId, bytes calldata encodedOutcome) external;
}
