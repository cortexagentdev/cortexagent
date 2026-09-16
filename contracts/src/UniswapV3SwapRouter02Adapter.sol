// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ISwapVenue } from "./KeylessVault.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    IUniswapV3QuoterMetadata,
    IUniswapV3SwapRouter02
} from "./interfaces/IUniswapV3SwapRouter02.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Constructor-fixed, direct exact-input routes for the verified RHC token release.
/// Donations are permanently stranded. No administrator, rescue or route update exists.
contract UniswapV3SwapRouter02Adapter is ISwapVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address pool;
    }
    string public constant protocolVariant = "uniswap-v3-swaprouter02";
    address public immutable factory;
    address public immutable router;
    address public immutable quoter;
    bytes32 public immutable routeHash;
    uint256 public immutable routeCount;
    mapping(address => mapping(address => Route)) private _routes;

    error InvalidConfiguration();
    error UnsupportedRoute();
    error InvalidSwap();
    error UnsupportedTransfer();

    constructor(address factory_, address router_, address quoter_, Route[] memory routes) {
        if (
            factory_.code.length == 0 || router_.code.length == 0 || quoter_.code.length == 0
                || routes.length == 0 || routes.length > 20
        ) revert InvalidConfiguration();
        if (
            IUniswapV3SwapRouter02(router_).factory() != factory_
                || IUniswapV3QuoterMetadata(quoter_).factory() != factory_
        ) revert InvalidConfiguration();
        factory = factory_;
        router = router_;
        quoter = quoter_;
        routeCount = routes.length;
        for (uint256 i; i < routes.length; ++i) {
            Route memory r = routes[i];
            if (
                !_supported(r.tokenIn) || !_supported(r.tokenOut) || r.tokenIn == r.tokenOut
                    || r.tokenIn.code.length == 0 || r.tokenOut.code.length == 0
                    || r.pool.code.length == 0 || (r.fee != 500 && r.fee != 3000)
            ) revert InvalidConfiguration();
            if (
                i != 0
                    && (routes[i - 1].tokenIn > r.tokenIn
                        || (routes[i - 1].tokenIn == r.tokenIn
                            && routes[i - 1].tokenOut >= r.tokenOut))
            ) revert InvalidConfiguration();
            IUniswapV3Pool pool = IUniswapV3Pool(r.pool);
            (address t0, address t1) =
                r.tokenIn < r.tokenOut ? (r.tokenIn, r.tokenOut) : (r.tokenOut, r.tokenIn);
            if (
                IUniswapV3Factory(factory_).feeAmountTickSpacing(r.fee) <= 0
                    || IUniswapV3Factory(factory_).getPool(t0, t1, r.fee) != r.pool
                    || pool.factory() != factory_ || pool.token0() != t0 || pool.token1() != t1
                    || pool.fee() != r.fee
            ) revert InvalidConfiguration();
            _routes[r.tokenIn][r.tokenOut] = r;
        }
        routeHash =
            keccak256(abi.encode(uint256(1), protocolVariant, factory_, router_, quoter_, routes));
    }

    function route(address tokenIn, address tokenOut) external view returns (Route memory) {
        return _routes[tokenIn][tokenOut];
    }

    function routePath(address tokenIn, address tokenOut) public view returns (bytes memory) {
        Route memory r = _routes[tokenIn][tokenOut];
        if (r.pool == address(0)) revert UnsupportedRoute();
        return abi.encodePacked(r.tokenIn, r.fee, r.tokenOut);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external nonReentrant returns (uint256 amountOut) {
        // 1 and 2 are SwapRouter02's MSG_SENDER and ADDRESS_THIS sentinels.
        if (
            uint160(recipient) <= 2 || recipient == address(this) || recipient == router
                || amountIn == 0 || minOut == 0
        ) revert InvalidSwap();
        bytes memory path = routePath(tokenIn, tokenOut);
        IERC20 input = IERC20(tokenIn);
        IERC20 output = IERC20(tokenOut);
        uint256 beforeInput = input.balanceOf(address(this));
        uint256 beforeCaller = input.balanceOf(msg.sender);
        uint256 beforeOutput = output.balanceOf(recipient);
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        if (
            input.balanceOf(address(this)) != beforeInput + amountIn
                || input.balanceOf(msg.sender) + amountIn != beforeCaller
        ) revert UnsupportedTransfer();
        input.forceApprove(router, amountIn);
        uint256 reported = IUniswapV3SwapRouter02(router)
            .exactInput(IUniswapV3SwapRouter02.ExactInputParams(path, recipient, amountIn, minOut));
        input.forceApprove(router, 0);
        uint256 afterOutput = output.balanceOf(recipient);
        if (afterOutput < beforeOutput) revert UnsupportedTransfer();
        amountOut = afterOutput - beforeOutput;
        if (
            amountOut < minOut || amountOut != reported
                || input.balanceOf(address(this)) != beforeInput
                || input.allowance(address(this), router) != 0
        ) revert UnsupportedTransfer();
    }

    function _supported(address token) private pure returns (bool) {
        return token == 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
            || token == 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9
            || token == 0xe93237C50D904957Cf27E7B1133b510C669c2e74
            || token == 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
            || token == 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3
            || token == 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A
            || token == 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C
            || token == 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68
            || token == 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5
            || token == 0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4
            || token == 0x12f190a9F9d7D37a250758b26824B97CE941bF54;
    }
}
