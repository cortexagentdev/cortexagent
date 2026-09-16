// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../../src/local/ExecutionGenerationMarker.sol";

/// @dev Run only against the verified persistent local Anvil fork.
contract DeployExecutionGenerationMarker is Script {
    function run() external returns (ExecutionGenerationMarker marker) {
        bytes32 generation = vm.envBytes32("LOCAL_EXECUTION_GENERATION_ID");
        vm.startBroadcast();
        marker = new ExecutionGenerationMarker(generation);
        vm.stopBroadcast();
    }
}
