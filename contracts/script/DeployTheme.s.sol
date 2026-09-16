// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { FeeController } from "../src/FeeController.sol";
import { KeylessVault } from "../src/KeylessVault.sol";
import { ThemeFactory } from "../src/ThemeFactory.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

/**
 * @title DeployTheme
 * @notice Deploys one theme through an already-deployed `ThemeFactory`, for
 *         testing and for seeding the demo theme on RHC testnet 46630.
 *
 * Explicit EXECUTION_CHAIN_ID is mandatory. Real-network broadcast needs a
 * separate operator instruction and hardware/keystore signing.
 *
 * Reads:
 *   THEME_FACTORY  — address of the deployed ThemeFactory (required).
 *   THEME_CONFIG   — path to the theme JSON, relative to `contracts/`.
 *                    Defaults to `script/config/demo-theme.json`.
 *
 * The JSON constituent/feed/USDG/venue addresses MUST be real 46630 addresses
 * before a broadcast — the factory (and the vault it deploys) probe every feed
 * for live round data and reject a no-code address. The committed demo config
 * ships with placeholders; fill them from the testnet universe first.
 *
 *   forge script script/DeployTheme.s.sol \
 *     --rpc-url rhc_testnet --account cortex-deployer --broadcast
 */
contract DeployTheme is Script {
    uint256 internal constant RHC_MAINNET = 4663;
    uint256 internal constant RHC_TESTNET = 46_630;

    function run()
        external
        returns (ThemeToken themeToken, KeylessVault vault, FeeController feeController)
    {
        uint256 expected = vm.envUint("EXECUTION_CHAIN_ID");
        require(expected == 4663 || expected == 46_630, "Unsupported execution chain");
        require(block.chainid == expected, "Execution chain mismatch");

        ThemeFactory factory = ThemeFactory(vm.envAddress("THEME_FACTORY"));
        string memory configPath = vm.envOr("THEME_CONFIG", string("script/config/demo-theme.json"));
        ThemeFactory.ThemeParams memory params = _loadParams(configPath);

        require(params.creatorFeeBps == 0, "Release supports zero creator fee only");
        require(address(factory).code.length > 0, "Factory missing");
        vm.startBroadcast();
        (themeToken, vault, feeController) = factory.deployTheme(params);
        vm.stopBroadcast();

        console2.log("theme slug      :", params.slug);
        console2.log("ThemeToken      :", address(themeToken));
        console2.log("KeylessVault    :", address(vault));
        console2.log("FeeController   :", address(feeController));
        console2.log("Record these in contracts/deployments/46630.json");
    }

    function _loadParams(string memory path)
        internal
        view
        returns (ThemeFactory.ThemeParams memory p)
    {
        string memory json = vm.readFile(path);

        p.slug = vm.parseJsonString(json, ".slug");
        p.name = vm.parseJsonString(json, ".name");
        p.symbol = vm.parseJsonString(json, ".symbol");
        uint256 decimals_ = vm.parseJsonUint(json, ".decimals");
        require(decimals_ == 18, "Theme shares require 18 decimals");
        p.decimals = uint8(decimals_);
        p.creator = vm.parseJsonAddress(json, ".creator");
        p.usdg = vm.parseJsonAddress(json, ".usdg");
        p.constituents = vm.parseJsonAddressArray(json, ".constituents");
        p.feeds = vm.parseJsonAddressArray(json, ".feeds");
        p.targetWeightsBps = vm.parseJsonUintArray(json, ".targetWeightsBps");
        p.capsBps = vm.parseJsonUintArray(json, ".capsBps");
        p.creatorFeeBps = vm.parseJsonUint(json, ".creatorFeeBps");
        p.mintRedeemBandBps = vm.parseJsonUint(json, ".mintRedeemBandBps");
        p.slippageCapBps = vm.parseJsonUint(json, ".slippageCapBps");
        p.maxRedeemUsd = vm.parseJsonUint(json, ".maxRedeemUsd");
        p.allowedVenues = vm.parseJsonAddressArray(json, ".allowedVenues");
    }
}
