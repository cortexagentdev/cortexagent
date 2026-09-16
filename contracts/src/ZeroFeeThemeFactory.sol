// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ThemeFactory } from "./ThemeFactory.sol";

/// @notice static-v5-zero-fee-v1. FeeController remains recorded accounting;
/// no payout, dilution authority, buyback or distribution is implemented.
contract ZeroFeeThemeFactory is ThemeFactory {
    string public constant RELEASE = "static-v5-zero-fee-v1";

    error NonzeroCreatorFee();

    constructor(address protocolFeeSink_) ThemeFactory(protocolFeeSink_) { }

    function _validateRelease(ThemeParams calldata p) internal pure override {
        if (p.creatorFeeBps != 0) revert NonzeroCreatorFee();
    }
}
