// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Local-fork identity only. It is deployed separately from ThemeFactory.
contract ExecutionGenerationMarker {
    bytes32 public immutable generation;

    constructor(bytes32 generation_) {
        require(generation_ != bytes32(0), "generation required");
        generation = generation_;
    }
}
