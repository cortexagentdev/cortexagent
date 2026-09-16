// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Stand-in contracts for a local Anvil chain. Never deployed anywhere else.
 *
 * ── Why these exist, and why they are not the test mocks ─────────────────────
 * `test/mocks/Mocks.sol` sets its state in constructors, which is exactly what
 * a local chain cannot use. The constituents and Chainlink feeds a theme
 * deploys against are addressed by their **mainnet 4663** addresses: that is
 * what `universe` stores and what `themeRouter.deployParams` encodes into the
 * calldata. On Anvil those addresses hold no code, so `ThemeFactory._validate`
 * rejects every basket with `FeedNotResponding`.
 *
 * The fix is to place code at those exact addresses with `anvil_setCode`, which
 * copies runtime bytecode and nothing else: constructor-assigned storage does
 * not come with it, and immutables baked into code would carry the deploying
 * instance's values. So everything here is plain storage, set through `init`
 * after the code is in place.
 *
 * This is the local analogue of forking. It is what makes the cross-chain gap
 * in `deployParams` (mainnet addresses, testnet chain id) testable at all
 * without either inventing a testnet address set or rewriting the router.
 */

/// @notice Minimal ERC-20. Hand-written rather than OpenZeppelin's because
///         `_name` and `_symbol` are private there, and an etched contract has
///         to be able to set them after the fact.
contract LocalERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool internal _initialised;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error AlreadyInitialised();
    error InsufficientBalance();
    error InsufficientAllowance();

    function init(string calldata n, string calldata s, uint8 d) external virtual {
        if (_initialised) revert AlreadyInitialised();
        _initialised = true;
        name = n;
        symbol = s;
        decimals = d;
    }

    /// @notice Open mint. This chain has no value on it and every account is a
    ///         test account, so there is nothing to protect.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice `LocalERC20` plus the four getters `KeylessVault` reads off a Stock
///         Token. `uiMultiplier` is 18-dp fixed point, matching the real
///         implementation (CRWD reads 4e18 after its 4:1).
contract LocalStock is LocalERC20 {
    uint256 public uiMultiplier;
    bool public oraclePaused;
    bool public tokenPaused;
    bool public paused;

    /// @notice Sets the ERC-20 identity and the multiplier in one call, so an
    ///         etched token is usable after a single transaction.
    function initStock(string calldata n, string calldata s, uint8 d, uint256 multiplier) external {
        if (_initialised) revert AlreadyInitialised();
        _initialised = true;
        name = n;
        symbol = s;
        decimals = d;
        uiMultiplier = multiplier;
    }

    /// @notice The three advisory pause flags (Design Law 3c). Settable so a
    ///         local session can exercise the constituent-state surfaces.
    function setPaused(bool oracle_, bool token_, bool all_) external {
        oraclePaused = oracle_;
        tokenPaused = token_;
        paused = all_;
    }

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}

/// @notice Chainlink `AggregatorV3` stand-in. `answer` is feed-decimal scaled
///         and `updatedAt` is a unix timestamp, both driven directly so a local
///         session can force a stale or negative feed on purpose.
contract LocalAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    bool private _initialised;

    error AlreadyInitialised();

    function init(uint8 d, int256 a, uint256 u) external {
        if (_initialised) revert AlreadyInitialised();
        _initialised = true;
        decimals = d;
        answer = a;
        updatedAt = u;
        roundId = 1;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
        roundId += 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

/**
 * @notice The one Multicall3 entry point the api actually calls.
 *
 *         Every batched read in the backend goes through `client.multicall`
 *         with `multicallAddress` pinned to canonical Multicall3, and this
 *         Anvil build does not predeploy it. With no code there, every read in
 *         a batch fails at once: the NAV poller logs `unreadable`, writes a
 *         null `nav_per_share`, and `vaultRouter.summary` answers "Vault NAV is
 *         not available yet" even though `navPerShare()` returns a perfectly
 *         good number when called directly.
 *
 *         Only `aggregate3` is implemented, because that is the only function
 *         viem's multicall uses. It is etched at the canonical address.
 */
contract LocalMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    error Multicall3CallFailed(uint256 index);

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory out) {
        uint256 n = calls.length;
        out = new Result[](n);
        for (uint256 i; i < n; ++i) {
            (bool ok, bytes memory data) = calls[i].target.call(calls[i].callData);
            if (!ok && !calls[i].allowFailure) revert Multicall3CallFailed(i);
            out[i] = Result({ success: ok, returnData: data });
        }
    }
}

/// @notice A deterministic swap venue for user entry/exit routing.
///
///         Prices are injected per token in USD 1e18 per whole token, and the
///         output side is minted rather than held, so a local session never has
///         to fund the venue. `rateBps` below 10000 simulates slippage.
contract LocalVenue {
    mapping(address => uint256) public priceUsd;
    uint256 public rateBps = 10_000;

    error NoPrice(address token);
    error BelowMinOut(uint256 amountOut, uint256 minOut);

    function setPrice(address token, uint256 usdPerWholeToken1e18) external {
        priceUsd[token] = usdPerWholeToken1e18;
    }

    function setRateBps(uint256 r) external {
        rateBps = r;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        uint256 pIn = priceUsd[tokenIn];
        uint256 pOut = priceUsd[tokenOut];
        if (pIn == 0) revert NoPrice(tokenIn);
        if (pOut == 0) revert NoPrice(tokenOut);
        uint256 decIn = LocalERC20(tokenIn).decimals();
        uint256 decOut = LocalERC20(tokenOut).decimals();
        // valueUsd is 1e18-scaled throughout, so the two decimal conversions
        // never share an intermediate that could overflow at test sizes.
        uint256 valueUsd = (amountIn * pIn) / (10 ** decIn);
        uint256 out = (valueUsd * (10 ** decOut)) / pOut;
        return (out * rateBps) / 10_000;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minOut) revert BelowMinOut(amountOut, minOut);
        LocalERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        LocalERC20(tokenOut).mint(recipient, amountOut);
    }
}
