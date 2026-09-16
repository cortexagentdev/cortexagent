// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { KeylessVault } from "./KeylessVault.sol";

/// @notice Fixed-purpose, statically linked creation library. Solidity emits
/// DELEGATECALL so CREATE uses the calling factory's account nonce. No storage
/// writes, configurable targets, arbitrary calldata execution or selfdestruct.
/// Solidity's library guard rejects direct calls to this non-view function.
library VaultDeployer {
    function deploy(KeylessVault.ThemePolicy memory policy) external returns (KeylessVault) {
        return new KeylessVault(policy);
    }
}
