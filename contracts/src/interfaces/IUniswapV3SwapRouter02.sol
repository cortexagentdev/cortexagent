// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3Pool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IUniswapV3QuoterMetadata {
    function factory() external view returns (address);
}

/// @notice Verified SwapRouter02 V3 ABI; exactInput has no deadline field.
interface IUniswapV3SwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function factory() external view returns (address);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256);
}
