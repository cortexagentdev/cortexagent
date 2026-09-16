// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PresetThemeFactory } from "../src/PresetThemeFactory.sol";
import { DeployFactory } from "./DeployFactory.s.sol";

/// @notice Real contracts only. scripts/local-chain.sh deploy --fork packages
/// receipt/code-verified manifests using the same production artifacts.
contract DeployFork is DeployFactory {
    function run() public override returns (PresetThemeFactory) {
        string memory endpoint = vm.envString("LOCAL_EXECUTION_RPC_URL");
        bytes32 url = keccak256(bytes(endpoint));
        require(
            url == keccak256("http://anvil:8545") || url == keccak256("http://127.0.0.1:8545")
                || url == keccak256("http://localhost:8545"),
            "Local endpoint required"
        );
        // The named endpoint must be the actual active fork endpoint.
        vm.createSelectFork(endpoint);
        vm.rpc("anvil_nodeInfo", "[]");
        require(block.chainid == 46_630, "Local chain required");
        return super.run();
    }
}
