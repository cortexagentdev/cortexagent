// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PresetThemeFactory } from "../src/PresetThemeFactory.sol";
import { UniswapV3SwapRouter02Adapter } from "../src/UniswapV3SwapRouter02Adapter.sol";
import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

/// @notice Operator tooling. Default invocation simulates only. Any real-network
/// broadcast requires separate operator authorization and hardware/keystore
/// signing on separate infrastructure. Never reads a private-key environment var.
/// Forge deploys VaultDeployer separately and statically links it into the factory;
/// capture its receipt along with the adapter/factory receipts before publication.
contract DeployFactory is Script {
    function run() public virtual returns (PresetThemeFactory factory) {
        uint256 expected = vm.envUint("EXECUTION_CHAIN_ID");
        require(expected == 4663 || expected == 46_630, "Unsupported execution chain");
        require(block.chainid == expected, "Execution chain mismatch");
        address sink = vm.envAddress("PROTOCOL_FEE_SINK");
        require(sink != address(0), "Zero protocol sink");
        // Exported by bootstrap-presets.ts --catalog. Do not hand-edit IDs/hash.
        string memory catalog = vm.readFile(vm.envString("PRESET_CATALOG_PATH"));
        bytes32 catalogHash = vm.parseJsonBytes32(catalog, ".catalogHash");
        bytes32[] memory ids = vm.parseJsonBytes32Array(catalog, ".ids");
        address deployer = vm.envAddress("PRESET_DEPLOYER");
        string memory raw = vm.readFile("../api/data/venues.json");
        address dex = vm.parseJsonAddress(raw, ".venues[0].factory");
        address router = vm.parseJsonAddress(raw, ".venues[0].router");
        address quoter = vm.parseJsonAddress(raw, ".venues[0].quoter");
        uint256 poolCount;
        while (
            poolCount <= 10
                && vm.keyExistsJson(
                    raw, string.concat(".venues[0].pools[", vm.toString(poolCount), "].address")
                )
        ) {
            ++poolCount;
        }
        require(poolCount > 0 && poolCount <= 10, "Unsupported pool count");
        UniswapV3SwapRouter02Adapter.Route[] memory routes =
            new UniswapV3SwapRouter02Adapter.Route[](poolCount * 2);
        for (uint256 i; i < poolCount; ++i) {
            string memory base = string.concat(".venues[0].pools[", vm.toString(i), "]");
            address a = vm.parseJsonAddress(raw, string.concat(base, ".token0"));
            address b = vm.parseJsonAddress(raw, string.concat(base, ".token1"));
            address pool = vm.parseJsonAddress(raw, string.concat(base, ".address"));
            uint256 fee = vm.parseJsonUint(raw, string.concat(base, ".feePips"));
            require(fee <= type(uint24).max, "Fee overflow");
            routes[i * 2] = UniswapV3SwapRouter02Adapter.Route(a, b, uint24(fee), pool);
            routes[i * 2 + 1] = UniswapV3SwapRouter02Adapter.Route(b, a, uint24(fee), pool);
        }
        for (uint256 i; i < routes.length; ++i) {
            for (uint256 j = i + 1; j < routes.length; ++j) {
                if (
                    routes[j].tokenIn < routes[i].tokenIn
                        || (routes[j].tokenIn == routes[i].tokenIn
                            && routes[j].tokenOut < routes[i].tokenOut)
                ) {
                    (routes[i], routes[j]) = (routes[j], routes[i]);
                }
            }
        }
        vm.startBroadcast();
        UniswapV3SwapRouter02Adapter adapter =
            new UniswapV3SwapRouter02Adapter(dex, router, quoter, routes);
        factory = new PresetThemeFactory(sink, deployer, catalogHash, ids);
        vm.stopBroadcast();
        console2.log("ThemeFactory        :", address(factory));
        console2.log("SwapVenue      :", address(adapter));
        console2.log("chain id            :", block.chainid);
    }
}
