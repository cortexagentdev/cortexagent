// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC-20 with settable decimals, open mint, and two issuer-style
///         levers the real `Stock` implementation exposes: a transfer freeze and
///         an admin burn (CortexBackend.md PART 9). Used to prove one frozen or
///         burned constituent does not brick redeem for the others.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    bool public frozen;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    /// @notice Robinhood can freeze a Stock Token; the vault's holding becomes
    ///         non-transferable.
    function setFrozen(bool v) external {
        _setFrozen(v);
    }

    function _setFrozen(bool v) internal {
        frozen = v;
    }

    /// @notice Robinhood can burn a Stock Token out of any holder.
    function adminBurn(address from, uint256 amt) external {
        _burn(from, amt);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!frozen, "FROZEN");
        super._update(from, to, value);
    }
}

/// @notice `MockERC20` plus the `Stock` getters the vault reads.
contract MockStock is MockERC20 {
    uint256 public uiMultiplier = 1e18;
    bool public oraclePaused;
    bool public tokenPaused;
    bool public paused;

    constructor(string memory n, string memory s, uint8 d) MockERC20(n, s, d) { }

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    /// @notice The real `Stock.pause()` halts transfers. Model that by freezing.
    function pause() external {
        paused = true;
        tokenPaused = true;
        _setFrozen(true);
    }

    function pauseOracle() external {
        oraclePaused = true;
    }
}

/// @notice Minimal Chainlink AggregatorV3 mock. `answer` and `updatedAt` are
///         driven directly so a test can force stale / negative / incomplete.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    constructor(uint8 d, int256 a, uint256 u) {
        decimals = d;
        answer = a;
        updatedAt = u;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
        roundId++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

/// @notice Deterministic swap venue for the routed mint/redeem
///         paths. Prices are injected by the test (USD, 1e18, per whole token);
///         `rateBps` below 10000 simulates real slippage. Mints the output token
///         to the recipient.
contract MockVenue {
    mapping(address => uint256) public priceWad; // USD 1e18 per whole token
    uint256 public rateBps = 10_000;
    bool public enforceMinOut = true;

    function setPrice(address token, uint256 p) external {
        priceWad[token] = p;
    }

    function setRateBps(uint256 r) external {
        rateBps = r;
    }

    /// @dev When false the venue delivers `rateBps` output without checking
    ///      `minOut`, so the vault's own slippage guard is what must catch it.
    function setEnforceMinOut(bool v) external {
        enforceMinOut = v;
    }

    function _dec(address t) internal view returns (uint8) {
        return MockERC20(t).decimals();
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        uint256 pin = priceWad[tokenIn];
        uint256 pout = priceWad[tokenOut];
        return amountIn * pin * (10 ** _dec(tokenOut)) / (pout * (10 ** _dec(tokenIn)));
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut) {
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = quote(tokenIn, tokenOut, amountIn) * rateBps / 10_000;
        if (enforceMinOut) require(amountOut >= minOut, "VENUE_SLIPPAGE");
        MockERC20(tokenOut).mint(recipient, amountOut);
    }
}
