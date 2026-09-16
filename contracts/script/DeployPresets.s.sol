// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PresetThemeFactory } from "../src/PresetThemeFactory.sol";
import { ThemeFactory } from "../src/ThemeFactory.sol";
import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

/// @notice Fixed-catalog bootstrap on separate operator signing infrastructure.
/// Default is simulation. Never takes private keys from environment variables.
/// Review the unsigned plan and independently supply its printed hash. Resume
/// skips occupied slots; bootstrap-presets.ts --register verifies exact policies.
contract DeployPresets is Script {
    function run() external {
        string memory raw = vm.readFile(vm.envString("PRESET_PLAN_PATH"));
        uint256 chainId = vm.parseJsonUint(raw, ".plan.chainId");
        require(
            chainId == block.chainid && (chainId == 4663 || chainId == 46_630), "Chain mismatch"
        );
        address target = vm.parseJsonAddress(raw, ".plan.factory");
        address deployer = vm.parseJsonAddress(raw, ".plan.deployer");
        PresetThemeFactory factory = PresetThemeFactory(target);
        require(factory.presetDeployer() == deployer, "Deployer mismatch");
        bytes32 catalogHash = vm.parseJsonBytes32(raw, ".plan.catalogHash");
        require(factory.catalogHash() == catalogHash, "Catalog mismatch");
        bytes32[] memory ids = factory.presetIds();
        bytes[] memory calls = new bytes[](ids.length);
        bytes32[] memory hashes = new bytes32[](ids.length);
        require(
            !vm.keyExistsJson(raw, string.concat(".plan.entries[", vm.toString(ids.length), "]")),
            "Extra preset"
        );
        for (uint256 i; i < ids.length; ++i) {
            string memory base = string.concat(".plan.entries[", vm.toString(i), "]");
            require(
                vm.parseJsonBytes32(raw, string.concat(base, ".id")) == ids[i], "Preset mismatch"
            );
            calls[i] = vm.parseJsonBytes(raw, string.concat(base, ".data"));
            hashes[i] = keccak256(calls[i]);
            require(bytes4(calls[i]) == ThemeFactory.deployTheme.selector, "Wrong selector");
        }
        bytes32 planHash = keccak256(
            abi.encode(
                chainId,
                keccak256(bytes(vm.parseJsonString(raw, ".plan.deploymentId"))),
                target,
                deployer,
                catalogHash,
                ids,
                hashes
            )
        );
        require(planHash == vm.envBytes32("PRESET_PLAN_HASH"), "Unapproved plan hash");
        require(planHash == vm.parseJsonBytes32(raw, ".planHash"), "Modified plan");
        vm.startBroadcast(deployer);
        for (uint256 i; i < ids.length; ++i) {
            (address token,,,,) = factory.presets(ids[i]);
            if (token != address(0)) continue;
            (bool ok, bytes memory reason) = target.call(calls[i]);
            if (!ok) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
        }
        vm.stopBroadcast();
        require(factory.presetsComplete(), "Incomplete bootstrap");
        console2.log("All preset slots occupied; run receipt verification and DB registration.");
    }
}
