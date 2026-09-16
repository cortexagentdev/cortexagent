// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { FeeController } from "./FeeController.sol";
import { KeylessVault } from "./KeylessVault.sol";
import { ThemeFactory } from "./ThemeFactory.sol";
import { ThemeToken } from "./ThemeToken.sol";

/// @notice Fixed catalog, operator-only creation. Each preset can be deployed
/// exactly once. There is no owner setter, public-deployment switch, upgrade,
/// or authority over any existing vault. Custom vaults need a different factory.
contract PresetThemeFactory is ThemeFactory {
    string public constant RELEASE = "preset-v6-zero-fee-v1";
    address public immutable presetDeployer;
    bytes32 public immutable catalogHash;
    uint256 public immutable presetCount;

    struct Preset {
        address token;
        address vault;
        address feeController;
        bytes32 policyHash;
        uint256 blockNumber;
    }

    mapping(bytes32 => bool) public allowedPreset;
    mapping(bytes32 => Preset) public presets;
    mapping(bytes32 => bool) private _used;
    bytes32[] private _presetIds;

    error UnauthorizedDeployer();
    error InvalidPresetCatalog();
    error UnknownPreset();
    error PresetAlreadyDeployed();
    error NonzeroCreatorFee();

    event PresetRegistered(bytes32 indexed presetId, address indexed token, address indexed vault);

    constructor(address sink, address deployer, bytes32 catalogHash_, bytes32[] memory ids)
        ThemeFactory(sink)
    {
        if (
            deployer == address(0) || catalogHash_ == bytes32(0) || ids.length == 0
                || ids.length > 64
        ) {
            revert InvalidPresetCatalog();
        }
        presetDeployer = deployer;
        catalogHash = catalogHash_;
        presetCount = ids.length;
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == bytes32(0) || allowedPreset[ids[i]]) revert InvalidPresetCatalog();
            allowedPreset[ids[i]] = true;
            _presetIds.push(ids[i]);
        }
    }

    function presetIds() external view returns (bytes32[] memory) {
        return _presetIds;
    }

    function presetsComplete() external view returns (bool) {
        return deployedVaults.length == presetCount;
    }

    function deployTheme(ThemeParams calldata params)
        public
        override
        returns (ThemeToken token, KeylessVault vault, FeeController feeController)
    {
        if (msg.sender != presetDeployer) revert UnauthorizedDeployer();
        bytes32 id = keccak256(bytes(params.slug));
        if (!allowedPreset[id]) revert UnknownPreset();
        if (_used[id]) revert PresetAlreadyDeployed();
        // Reserve before any constructor's external reads. Failure rolls back
        // the reservation and all CREATE nonces; retry cannot strand a slot.
        _used[id] = true;
        (token, vault, feeController) = super.deployTheme(params);
        presets[id] = Preset({
            token: address(token),
            vault: address(vault),
            feeController: address(feeController),
            policyHash: keccak256(abi.encode(_toPolicy(params, address(token)))),
            blockNumber: block.number
        });
        emit PresetRegistered(id, address(token), address(vault));
    }

    function _validateRelease(ThemeParams calldata p) internal pure override {
        if (p.creatorFeeBps != 0) revert NonzeroCreatorFee();
    }
}
