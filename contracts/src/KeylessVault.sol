// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ThemeToken } from "./ThemeToken.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The four getters the vault reads from a Chainlink AggregatorV3 proxy.
///         The RHC equity feeds are 8-dp with an 86400s heartbeat and a 0.5%
///         deviation threshold (CortexBackend.md PART 9).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @notice The parts of the shared `Stock` implementation the vault touches.
///         `uiMultiplier()` is 18-dp fixed point (CRWD reads 4e18 after its 4:1).
///         The three pause flags are advisory only (Design Law 3c).
interface IStockToken {
    function uiMultiplier() external view returns (uint256);
    function oraclePaused() external view returns (bool);
    function tokenPaused() external view returns (bool);
    function paused() external view returns (bool);
}

/// @notice An immutable-allowlisted swap adapter for user deposits and exits.
///         `swap` must pull `amountIn` of `tokenIn` from the caller and deliver
///         at least `minOut` of `tokenOut` to `recipient`, or revert.
interface ISwapVenue {
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}

/**
 * @title KeylessVault
 * @notice Holds a theme's constituent Stock Tokens at policy weights and mints /
 *         redeems `ThemeToken` against them. New source requires a new immutable
 *         deployment; it does not repair previously deployed vaults.
 *
 * ── Design Law 4: non-custodial + keyless ────────────────────────────────────
 * The entire policy is fixed at construction. There is:
 *   - no owner, no admin, no access-control role, no governance,
 *   - no setter for any policy field,
 *   - no upgrade path (this contract sits behind no proxy),
 *   - no admin exit, no asset-recovery function, no back door of any name.
 * "No admin key can move user funds or reweight outside published policy."
 * The absence of a recovery path is the design, not an oversight, so a bug here
 * is permanent — every rule below is load-bearing.
 *
 * ── Design Law 2: on-chain priceability ─────────────────────────────────────
 * The constituent universe is the 35 names with a Chainlink feed, not all 96
 * active tokens. A contract cannot read a REST quote, so a name with no feed can
 * never be priced on-chain. The constructor rejects a policy that names one.
 *
 * ── Design Law 3a2: staleness is a LIVENESS bound, not an accuracy one ───────
 * `MAX_STALENESS = 90000` is a liveness check, NOT an accuracy guarantee.
 * A deviation threshold triggers feed updates; it does not bound market gaps,
 * latency, token discounts, or market closures. Deposits into an existing vault
 * are therefore capped by the least-funded constituent's proportional backing.
 * User-requested routed entry and exit depend on configured feeds and venues.
 *
 * ── Counterparty reality (PART 6) ──────────────────────────────────────────
 * Every Stock Token is a beacon proxy over one shared implementation, and its
 * issuer can `pause` or `adminBurn` the vault's holding at will. A keyless vault
 * is keyless over its own logic; it is not trustless with respect to the assets
 * it holds. The obligation that follows is testable: one frozen or burned
 * constituent must not brick redeem for the others. `redeem()` never reverts on
 * a single failing constituent transfer.
 */
contract KeylessVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────── constants ────────────────────────────────

    /// @notice Feed heartbeat (86400s) + grace (3600s). Immutable policy
    ///         constant. A LIVENESS check. See Design Law 3a2 — do not tighten.
    uint256 public constant MAX_STALENESS = 90_000;

    /// @notice The feed deviation threshold, in bps. The mint/redeem band must
    ///         strictly exceed this plus the creator fee.
    uint256 public constant DEVIATION_THRESHOLD_BPS = 50;

    /// @notice Ceiling on `creatorFeeBps`. FeeController (PART 4) owns fee
    ///         accrual; the vault only stores the rate and bounds it here.
    uint256 public constant MAX_FEE_BPS = 100;

    /// @notice Ceiling on the per-leg slippage cap a policy may set.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    /// @notice Prevent economically significant share-rounding at thin supply.
    /// A successful entry loses less than two parts in 1e12 to share flooring.
    uint256 public constant MIN_MINT_SHARES = 1e12;

    // ───────────────────── policy — written once, never again ─────────────
    //
    // Solidity has no immutable arrays or mappings. These are written exactly
    // once, in the constructor, and no function anywhere in this contract writes
    // them again. There is no setter. They are functionally immutable.

    address[] private _constituents;
    address[] private _feeds;
    uint256[] private _targetWeightsBps;
    uint256[] private _capsBps;
    address[] private _allowedVenues;

    mapping(address => bool) public isAllowedVenue;

    // Each constituent has its own ownership ledger. Active units back theme
    // shares; deferred units belong to exited holders. Units track proportional
    // ownership even when an issuer burns balances or balanceOf stops working.
    struct AssetAccount {
        uint256 totalUnits;
        uint256 activeUnits;
    }
    mapping(uint256 => AssetAccount) private _assetAccounts;
    mapping(address => mapping(uint256 => uint256)) public deferredUnits;
    uint256 private constant UNIT_SCALE = 1e18;

    /// @notice The ERC-20 share of this theme. This vault is its only minter/burner.
    ThemeToken public immutable themeToken;
    /// @notice The USDG settlement token, for the optional routed mint/redeem paths.
    address public immutable usdg;
    /// @notice The theme creator. Recorded for the fee split; holds no power here.
    address public immutable creator;

    uint256 public immutable creatorFeeBps;
    /// @notice Published spread retained in the active vault on mint.
    uint256 public immutable mintRedeemBandBps;
    /// @notice Per-leg slippage cap for user-requested routed deposits and exits.
    uint256 public immutable slippageCapBps;
    /// @notice USD (1e18) ceiling on a single routed-to-USDG redeem. Never
    ///         applies to the in-kind `redeem()` — that path reads no oracle.
    uint256 public immutable maxRedeemUsd;

    uint8 internal immutable _usdgDecimals;

    // ─────────────────────────── errors ───────────────────────────────────

    error NoConstituents();
    error LengthMismatch();
    error ZeroAddress();
    error ConstituentHasNoFeed(uint256 index);
    error FeedNotResponding(uint256 index);
    error WeightsMustSumToBps(uint256 got);
    error ZeroWeight(uint256 index);
    error BadCap(uint256 index);
    error FeeAboveCap();
    error BandNotAboveThreshold();
    error BadSlippageCap();
    error NoVenues();

    error StaleFeed(uint256 index, uint256 age);
    error BadAnswer(uint256 index, int256 answer);
    error RoundIncomplete(uint256 index);
    error NoSupply();

    error ZeroShares();
    error ZeroAmount();
    error BadRecipient();
    error DepositOffTargetWeight(uint256 index);
    error NothingDeposited();
    error SlippageExceeded();
    error MaxRedeemExceeded();

    error VenueNotAllowed(address venue);
    error NotAVaultAsset(address token);
    error UnsupportedTransfer(address token);
    error SettlementMismatch(address token);
    error SharesExceedSupply();
    error DeadlineExpired(uint256 deadline);
    error OnlySelf();
    error InsufficientExitGas();
    error InvalidConstituent(uint256 index);
    error InvalidConfiguration();
    error NoDeferredClaim();
    error AssetInsolvent(uint256 index);
    error AmountTooSmall();

    function _requireRecipient(address to) private view {
        if (to == address(0) || to == address(this) || to == address(themeToken)) {
            revert BadRecipient();
        }
    }

    /// @notice Maximum gas for one isolated in-kind balance/transfer leg.
    uint256 public constant IN_KIND_LEG_GAS = 250_000;

    // ─────────────────────────── events ───────────────────────────────────

    event Minted(
        address indexed caller, address indexed to, uint256 shares, uint256 depositValueUsd
    );
    event Redeemed(address indexed caller, address indexed to, uint256 shares, uint256 failedLegs);
    event RedeemedToUsdg(
        address indexed caller, address indexed to, uint256 shares, uint256 usdgOut
    );
    event InKindLegFailed(address indexed token, address indexed to);
    event ExitDeferred(address indexed owner, uint256 indexed index, uint256 units);
    event DeferredClaimed(address indexed owner, uint256 indexed index, address to, uint256 amount);

    // ─────────────────────────── construction ─────────────────────────────

    /**
     * @notice The published policy. Every field is fixed at construction and
     *         never mutated. There is no setter for any of it.
     *
     * @param themeToken The already-deployed ThemeToken whose `vault` is this
     *        contract's final address (the factory, BE-25e, breaks the cycle).
     * @param usdg USDG address on 46630.
     * @param creator Theme creator, for the fee split. Holds no power here.
     * @param constituents Stock Token addresses. Each MUST have a feed.
     * @param feeds Parallel Chainlink AggregatorV3 proxies. A zero entry is
     *        rejected — Design Law 2 gate 4.
     * @param targetWeightsBps Parallel target weights; must sum to 10000.
     * @param capsBps Parallel per-constituent max weight; each >= its target.
     * @param creatorFeeBps <= MAX_FEE_BPS.
     * @param mintRedeemBandBps > DEVIATION_THRESHOLD_BPS + creatorFeeBps.
     * @param slippageCapBps Per-leg slippage cap, in (0, MAX_SLIPPAGE_BPS].
     * @param maxRedeemUsd USD (1e18) cap on the routed-to-USDG redeem path.
     * @param allowedVenues Non-empty swap venue allowlist.
     */
    struct ThemePolicy {
        address themeToken;
        address usdg;
        address creator;
        address[] constituents;
        address[] feeds;
        uint256[] targetWeightsBps;
        uint256[] capsBps;
        uint256 creatorFeeBps;
        uint256 mintRedeemBandBps;
        uint256 slippageCapBps;
        uint256 maxRedeemUsd;
        address[] allowedVenues;
    }

    constructor(ThemePolicy memory p) {
        uint256 n = p.constituents.length;
        if (n == 0) revert NoConstituents();
        if (n > 16) revert InvalidConfiguration();
        if (p.feeds.length != n || p.targetWeightsBps.length != n || p.capsBps.length != n) {
            revert LengthMismatch();
        }
        if (p.themeToken == address(0) || p.usdg == address(0) || p.creator == address(0)) {
            revert ZeroAddress();
        }
        if (p.creatorFeeBps > MAX_FEE_BPS) revert FeeAboveCap();
        // "exceeds 0.5% plus fee" — strictly greater.
        if (
            p.mintRedeemBandBps <= DEVIATION_THRESHOLD_BPS + p.creatorFeeBps
                || p.mintRedeemBandBps >= BPS
        ) {
            revert BandNotAboveThreshold();
        }
        if (p.slippageCapBps == 0 || p.slippageCapBps > MAX_SLIPPAGE_BPS) revert BadSlippageCap();

        _validateAndStoreConstituents(p);

        uint256 v = p.allowedVenues.length;
        if (v == 0) revert NoVenues();
        for (uint256 i; i < v; ++i) {
            if (p.allowedVenues[i] == address(0)) revert ZeroAddress();
            if (p.allowedVenues[i].code.length == 0) revert InvalidConfiguration();
            _allowedVenues.push(p.allowedVenues[i]);
            isAllowedVenue[p.allowedVenues[i]] = true;
        }

        themeToken = ThemeToken(p.themeToken);
        usdg = p.usdg;
        creator = p.creator;
        creatorFeeBps = p.creatorFeeBps;
        mintRedeemBandBps = p.mintRedeemBandBps;
        slippageCapBps = p.slippageCapBps;
        maxRedeemUsd = p.maxRedeemUsd;
        _usdgDecimals = IERC20Metadata(p.usdg).decimals();
        if (_usdgDecimals > 18 || ThemeToken(p.themeToken).decimals() != 18) {
            revert InvalidConfiguration();
        }
    }

    function _validateAndStoreConstituents(ThemePolicy memory p) private {
        uint256 n = p.constituents.length;
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (p.constituents[i] == address(0)) revert ZeroAddress();
            if (
                p.constituents[i] == p.usdg || p.constituents[i] == p.themeToken
                    || p.constituents[i] == address(this) || p.constituents[i].code.length == 0
            ) revert InvalidConstituent(i);
            if (
                IERC20Metadata(p.constituents[i]).decimals() > 18
                    || IStockToken(p.constituents[i]).uiMultiplier() == 0
            ) revert InvalidConfiguration();
            for (uint256 j; j < i; ++j) {
                if (p.constituents[j] == p.constituents[i]) revert InvalidConstituent(i);
            }
            // Design Law 2 gate 4 + the task: a constituent with no Chainlink
            // feed can never be priced on-chain. Reject it at construction.
            if (p.feeds[i] == address(0)) revert ConstituentHasNoFeed(i);
            // Probe the feed now so a typo'd non-feed address fails at deploy,
            // not on the first mint. A no-code address would let a staticcall
            // "succeed" with empty returndata and only blow up later on decode,
            // which try/catch does not trap — reject it up front.
            if (p.feeds[i].code.length == 0) revert FeedNotResponding(i);
            try AggregatorV3Interface(p.feeds[i]).decimals() returns (uint8 decimals_) {
                if (decimals_ > 18) revert FeedNotResponding(i);
                (, int256 a,, uint256 u,) = AggregatorV3Interface(p.feeds[i]).latestRoundData();
                if (a <= 0 || u == 0) revert FeedNotResponding(i);
            } catch {
                revert FeedNotResponding(i);
            }
            if (p.targetWeightsBps[i] == 0) revert ZeroWeight(i);
            if (p.capsBps[i] < p.targetWeightsBps[i] || p.capsBps[i] > BPS) revert BadCap(i);

            sum += p.targetWeightsBps[i];
            _constituents.push(p.constituents[i]);
            _feeds.push(p.feeds[i]);
            _targetWeightsBps.push(p.targetWeightsBps[i]);
            _capsBps.push(p.capsBps[i]);
        }
        if (sum != BPS) revert WeightsMustSumToBps(sum);
    }

    // ─────────────────────────── NAV ──────────────────────────────────────

    /**
     * @notice `Σ(answer × uiMultiplier() × heldQty) / totalSupply`, in USD (1e18).
     *
     * Reverts on, per constituent:
     *   - `block.timestamp - updatedAt > MAX_STALENESS` (liveness),
     *   - `answer <= 0`,
     *   - `updatedAt == 0` (round incomplete).
     *
     * Age is clamped at zero first — one RHC feed was observed reporting
     * `updatedAt` 14s in the future (clock skew is real, PART 9).
     *
     * Mint consumes this. `redeem()` never does — a reverting NAV must not be
     * able to block the exit of last resort.
     */
    function navPerShare() public view returns (uint256) {
        uint256 supply = themeToken.totalSupply();
        if (supply == 0) revert NoSupply();
        return Math.mulDiv(_totalValueStrict(), WAD, supply);
    }

    /// @notice Total vault AUM in USD (1e18). Same guards as `navPerShare`.
    function navValue() external view returns (uint256) {
        return _totalValueStrict();
    }

    /**
     * @notice Same maths as `navPerShare`, but never reverts: returns
     *         `(value, stale)` for the UI when the market is closed or a feed is
     *         lagging. `stale` is also set when an advisory pause flag is up.
     *
     * Read-only. No mint or redeem path consumes this.
     */
    function navIndicative() external view returns (uint256 value, bool stale) {
        uint256 supply = themeToken.totalSupply();
        if (supply == 0) return (0, true);

        uint256 total;
        uint256 n = _constituents.length;
        for (uint256 i; i < n; ++i) {
            try this.constituentIndicative{ gas: IN_KIND_LEG_GAS }(i) returns (
                uint256 legValue, bool legStale
            ) {
                if (legValue > type(uint256).max - total) return (0, true);
                total += legValue;
                if (legStale) stale = true;
            } catch {
                stale = true;
            }
        }
        if (total > type(uint256).max / WAD) return (0, true);
        value = Math.mulDiv(total, WAD, supply);
    }

    /// @dev External boundary makes malformed metadata and balance reads catchable.
    function constituentIndicative(uint256 i) external view returns (uint256, bool) {
        return _constituentValueIndicative(i);
    }

    // ─────────────────────────── mint ─────────────────────────────────────

    /**
     * @notice In-kind mint. Deposit each constituent at target weights (within
     *         `mintRedeemBandBps`). Existing supply issues no more than the
     *         smallest proportional increase of any held constituent, less band.
     *
     * The band is retained in the vault and accrues to existing holders; it is
     * not a guarantee about the accuracy of external prices. Imbalanced entries
     * receive fewer shares: clients must simulate and bind a reviewed minimum.
     *
     * Reverts if any constituent feed fails a guard. A reverting mint is the
     * SAFE failure: the caller keeps their tokens and can retry later.
     *
     * @param amountsIn Parallel to `constituents()`. Every entry must be > 0.
     * @param to Recipient of the minted shares.
     * @param minSharesOut Caller's slippage floor.
     */
    function mint(uint256[] calldata amountsIn, address to, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 shares)
    {
        uint256 n = _constituents.length;
        if (amountsIn.length != n) revert LengthMismatch();
        _requireRecipient(to);

        uint256 supply = themeToken.totalSupply();
        uint256 gross = type(uint256).max;

        uint256[] memory depositValue = new uint256[](n);
        uint256 depositTotal;
        for (uint256 i; i < n; ++i) {
            uint256 amt = amountsIn[i];
            if (amt == 0) revert ZeroAmount();
            uint256 unitsBefore = _syncAsset(i);
            uint256 received = _receiveExact(_constituents[i], amt);
            if (supply != 0 && unitsBefore != 0) {
                gross = Math.min(
                    gross,
                    Math.mulDiv(_assetAccounts[i].activeUnits - unitsBefore, supply, unitsBefore)
                );
            }
            depositValue[i] = _valueOf(i, received);
            depositTotal += depositValue[i];
        }
        if (depositTotal == 0) revert NothingDeposited();

        _requireOnTargetWeight(depositValue, depositTotal);

        if (supply == 0) gross = depositTotal;
        else if (gross == type(uint256).max) revert NothingDeposited();
        shares = Math.mulDiv(gross, BPS - mintRedeemBandBps, BPS);
        if (shares == 0) revert ZeroShares();
        if (shares < MIN_MINT_SHARES) revert AmountTooSmall();
        if (shares < minSharesOut) revert SlippageExceeded();

        themeToken.mint(to, shares);
        emit Minted(msg.sender, to, shares, depositTotal);
    }

    /**
     * @notice Routed mint. Deposit USDG; the vault buys each constituent
     *         weight-proportionally through `venue`, then issues shares using
     *         the same non-dilution cap and band as an in-kind mint.
     *         `venue` must be on the immutable allowlist.
     *
     * Reverts if any constituent feed fails a guard (the SAFE failure) or a leg
     * breaches the slippage cap.
     */
    function mintWithUsdg(uint256 usdgIn, address venue, address to, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 shares)
    {
        return _mintWithUsdg(usdgIn, venue, to, minSharesOut);
    }

    function mintWithUsdgUntil(
        uint256 usdgIn,
        address venue,
        address to,
        uint256 minSharesOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 shares) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        return _mintWithUsdg(usdgIn, venue, to, minSharesOut);
    }

    function _mintWithUsdg(uint256 usdgIn, address venue, address to, uint256 minSharesOut)
        internal
        returns (uint256 shares)
    {
        if (!isAllowedVenue[venue]) revert VenueNotAllowed(venue);
        if (usdgIn == 0) revert ZeroAmount();
        _requireRecipient(to);
        uint256 supply = themeToken.totalSupply();
        uint256 usdgBefore = IERC20(usdg).balanceOf(address(this));
        _receiveExact(usdg, usdgIn);

        uint256 n = _constituents.length;
        uint256[] memory values = new uint256[](n);
        uint256 depositTotal;
        uint256 remaining = usdgIn;
        uint256 gross = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            uint256 spend = i == n - 1 ? remaining : Math.mulDiv(usdgIn, _targetWeightsBps[i], BPS);
            if (spend == 0) revert ZeroAmount();
            remaining -= spend;
            uint256 unitsBefore = _syncAsset(i);
            uint256 out = _settleSwap(venue, usdg, _constituents[i], spend);
            if (supply != 0 && unitsBefore != 0) {
                gross = Math.min(
                    gross,
                    Math.mulDiv(_assetAccounts[i].activeUnits - unitsBefore, supply, unitsBefore)
                );
            }
            values[i] = _valueOf(i, out);
            depositTotal += values[i];
        }
        if (IERC20(usdg).balanceOf(address(this)) != usdgBefore) revert SettlementMismatch(usdg);
        if (depositTotal == 0) revert NothingDeposited();
        _requireOnTargetWeight(values, depositTotal);
        if (supply == 0) gross = depositTotal;
        else if (gross == type(uint256).max) revert NothingDeposited();
        shares = Math.mulDiv(gross, BPS - mintRedeemBandBps, BPS);
        if (shares == 0) revert ZeroShares();
        if (shares < MIN_MINT_SHARES) revert AmountTooSmall();
        if (shares < minSharesOut) revert SlippageExceeded();
        themeToken.mint(to, shares);
        emit Minted(msg.sender, to, shares, depositTotal);
    }

    /// @dev Supported deposits debit the caller and credit the vault exactly.
    function _receiveExact(address token, uint256 amount) internal returns (uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeVault = asset.balanceOf(address(this));
        uint256 beforeCaller = asset.balanceOf(msg.sender);
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterVault = asset.balanceOf(address(this));
        uint256 afterCaller = asset.balanceOf(msg.sender);
        if (afterVault < beforeVault || afterCaller > beforeCaller) {
            revert UnsupportedTransfer(token);
        }
        received = afterVault - beforeVault;
        if (received != amount || beforeCaller - afterCaller != amount) {
            revert UnsupportedTransfer(token);
        }
        if (token != usdg) _creditAsset(_constituentIndex(token), received, beforeVault);
    }

    /// @dev Return data is corroboration, never backing. Every exact-input leg
    ///      consumes its allocation and leaves no allowance for a later call.
    function _settleSwap(address venue, address tokenIn, address tokenOut, uint256 amount)
        internal
        returns (uint256 received)
    {
        uint256 minOut = Math.mulDiv(_convert(tokenIn, tokenOut, amount), BPS - slippageCapBps, BPS);
        if (minOut == 0) revert ZeroAmount();
        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        if (tokenIn != usdg) _debitAsset(_constituentIndex(tokenIn), amount, inputBefore);
        IERC20(tokenIn).forceApprove(venue, amount);
        uint256 reported = ISwapVenue(venue).swap(tokenIn, tokenOut, amount, minOut, address(this));
        IERC20(tokenIn).forceApprove(venue, 0);
        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (
            inputAfter > inputBefore || inputBefore - inputAfter != amount
                || IERC20(tokenIn).allowance(address(this), venue) != 0
        ) revert SettlementMismatch(tokenIn);
        if (outputAfter < outputBefore) revert SettlementMismatch(tokenOut);
        received = outputAfter - outputBefore;
        if (received < minOut) revert SlippageExceeded();
        if (reported != received) revert SettlementMismatch(tokenOut);
        if (tokenOut != usdg) _creditAsset(_constituentIndex(tokenOut), received, outputBefore);
    }

    // ─────────────────────────── redeem ───────────────────────────────────

    /**
     * @notice THE EXIT OF LAST RESORT. Burn `shares`, receive a pro-rata slice
     *         of every constituent, in kind.
     *
     * This path reads NO oracle and touches NO router. It must succeed when
     * every feed is stale, every venue is down, and `navPerShare()` reverts.
     * There is no `maxRedeemUsd` gate here — pricing the cap would need an
     * oracle, and this path has none by design (global do-not 7).
     *
     * One frozen or `adminBurn`ed constituent must not brick the others: each
     * leg is a low-level call, and a failing leg is recorded and skipped, not
     * reverted. Failed legs remain owned by the caller as deferred units and
     * can be retried independently, to a different recipient if necessary.
     *
     * @return tokens  Parallel to `constituents()`.
     * @return amounts Amount actually sent for each (0 for a skipped leg).
     * @return failed  Constituents whose transfer failed.
     */
    function redeem(uint256 shares, address to)
        external
        nonReentrant
        returns (address[] memory tokens, uint256[] memory amounts, address[] memory failed)
    {
        if (shares == 0) revert ZeroShares();
        _requireRecipient(to);

        uint256 supply = themeToken.totalSupply();

        // Reserve every bounded leg plus loop/event overhead before burning.
        // An underfunded transaction must not silently defer otherwise good legs.
        if (gasleft() < _constituents.length * (IN_KIND_LEG_GAS + 100_000) + 150_000) {
            revert InsufficientExitGas();
        }

        // Checks-effects: burn first. ThemeToken.burn reverts if the caller's
        // balance is short, so this also bounds `shares <= supply`.
        themeToken.burn(msg.sender, shares);

        uint256 n = _constituents.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        failed = new address[](n);
        uint256 failCount;

        for (uint256 i; i < n; ++i) {
            address c = _constituents[i];
            tokens[i] = c;
            uint256 units = _reserveExit(i, shares, supply);
            if (units == 0) continue;
            // The bounded self-call rolls back this leg on malformed returns,
            // balance-read failure, non-exact transfer, or token gas exhaustion.
            try this.redeemInKindLeg{ gas: IN_KIND_LEG_GAS }(i, units, msg.sender, to) returns (
                uint256 amt
            ) {
                amounts[i] = amt;
            } catch {
                failed[failCount++] = c;
                emit InKindLegFailed(c, to);
                emit ExitDeferred(msg.sender, i, units);
            }
        }
        assembly {
            mstore(failed, failCount)
        }
        emit Redeemed(msg.sender, to, shares, failCount);
    }

    function _reserveExit(uint256 index, uint256 shares, uint256 supply)
        private
        returns (uint256 units)
    {
        AssetAccount storage a = _assetAccounts[index];
        units = Math.mulDiv(a.activeUnits, shares, supply);
        if (a.activeUnits != 0 && units == 0) revert AmountTooSmall();
        a.activeUnits -= units;
        deferredUnits[msg.sender][index] += units;
    }

    /// @dev Only reachable from redeem's guarded self-call. External callers
    ///      always revert. Empty return or exactly ABI true is supported;
    ///      false, malformed and oversized returns fail and roll back the leg.
    function redeemInKindLeg(uint256 index, uint256 units, address owner, address to)
        external
        returns (uint256 amount)
    {
        if (msg.sender != address(this)) revert OnlySelf();
        return _claimDeferred(owner, index, units, to);
    }

    /// @notice Retry an exited asset without an oracle, router, or other token
    /// read. Only the claim owner chooses the recipient. Failure preserves the
    /// complete claim. No gas cap applies to this single-token escape path.
    function claimDeferred(uint256 index, address to) external nonReentrant returns (uint256) {
        _requireRecipient(to);
        return _claimDeferred(msg.sender, index, deferredUnits[msg.sender][index], to);
    }

    function _claimDeferred(address owner, uint256 index, uint256 units, address to)
        private
        returns (uint256 amount)
    {
        if (units == 0) revert NoDeferredClaim();
        AssetAccount storage a = _assetAccounts[index];
        address token = _constituents[index];
        amount = Math.mulDiv(IERC20(token).balanceOf(address(this)), units, a.totalUnits);
        // Dust and temporarily zero balances are still claims, not forfeitures.
        if (amount == 0) revert AmountTooSmall();
        deferredUnits[owner][index] -= units;
        a.totalUnits -= units;
        _sendExact(token, to, amount);
        emit DeferredClaimed(owner, index, to, amount);
    }

    /// @notice Constituent balance backing circulating shares, excluding exits.
    function activeBalance(uint256 index) public view returns (uint256) {
        uint256 balance = IERC20(_constituents[index]).balanceOf(address(this));
        AssetAccount storage a = _assetAccounts[index];
        return a.totalUnits == 0 ? balance : Math.mulDiv(balance, a.activeUnits, a.totalUnits);
    }

    function deferredBalance(address owner, uint256 index) external view returns (uint256) {
        AssetAccount storage a = _assetAccounts[index];
        if (a.totalUnits == 0) return 0;
        return Math.mulDiv(
            IERC20(_constituents[index]).balanceOf(address(this)),
            deferredUnits[owner][index],
            a.totalUnits
        );
    }

    /// @dev Initialize unsolicited backing before comparing a new deposit's
    /// ownership units. Rounded token balances are not issuance denominators:
    /// active ownership can be a fraction of one native unit after an exit.
    function _syncAsset(uint256 index) private returns (uint256 activeUnits) {
        AssetAccount storage a = _assetAccounts[index];
        if (a.totalUnits == 0) {
            a.totalUnits = IERC20(_constituents[index]).balanceOf(address(this)) * UNIT_SCALE;
            a.activeUnits = a.totalUnits;
        }
        return a.activeUnits;
    }

    function _creditAsset(uint256 index, uint256 amount, uint256 beforeBalance) private {
        AssetAccount storage a = _assetAccounts[index];
        if (a.totalUnits == 0) {
            a.totalUnits = (beforeBalance + amount) * UNIT_SCALE;
            a.activeUnits = a.totalUnits;
            return;
        }
        if (beforeBalance == 0) revert AssetInsolvent(index);
        uint256 units = Math.mulDiv(amount, a.totalUnits, beforeBalance);
        if (units == 0) revert AmountTooSmall();
        a.totalUnits += units;
        a.activeUnits += units;
    }

    function _debitAsset(uint256 index, uint256 amount, uint256 beforeBalance) private {
        AssetAccount storage a = _assetAccounts[index];
        uint256 units = Math.mulDiv(amount, a.totalUnits, beforeBalance, Math.Rounding.Ceil);
        if (units > a.activeUnits) revert SettlementMismatch(_constituents[index]);
        a.activeUnits -= units;
        a.totalUnits -= units;
    }

    function _sendExact(address token, address to, uint256 amount) internal {
        uint256 beforeVault = IERC20(token).balanceOf(address(this));
        uint256 beforeRecipient = IERC20(token).balanceOf(to);
        bytes memory input = abi.encodeCall(IERC20.transfer, (to, amount));
        bool ok;
        uint256 size;
        uint256 returned;
        // Copy at most one word, even if a token produces huge return data.
        assembly ("memory-safe") {
            let output := mload(0x40)
            mstore(output, 0)
            ok := call(gas(), token, 0, add(input, 32), mload(input), output, 32)
            size := returndatasize()
            returned := mload(output)
        }
        if (!ok || (size != 0 && (size != 32 || returned != 1))) revert UnsupportedTransfer(token);
        uint256 afterVault = IERC20(token).balanceOf(address(this));
        uint256 afterRecipient = IERC20(token).balanceOf(to);
        if (
            afterVault > beforeVault || beforeVault - afterVault != amount
                || afterRecipient < beforeRecipient || afterRecipient - beforeRecipient != amount
        ) {
            revert UnsupportedTransfer(token);
        }
    }

    /**
     * @notice Convenience exit: burn `shares` and route the pro-rata basket to
     *         USDG through `venue`, when every feed is fresh and the basket is
     *         within band. Reverts past `maxRedeemUsd`.
     *
     * This is NOT the exit of last resort. If any feed is stale or any
     * constituent is frozen, this reverts and the caller falls back to the
     * oracle-free `redeem()`.
     */
    function redeemToUsdg(uint256 shares, address venue, address to, uint256 minUsdgOut)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        return _redeemToUsdg(shares, venue, to, minUsdgOut);
    }

    function redeemToUsdgUntil(
        uint256 shares,
        address venue,
        address to,
        uint256 minUsdgOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 usdgOut) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        return _redeemToUsdg(shares, venue, to, minUsdgOut);
    }

    function _redeemToUsdg(uint256 shares, address venue, address to, uint256 minUsdgOut)
        internal
        returns (uint256 usdgOut)
    {
        if (!isAllowedVenue[venue]) revert VenueNotAllowed(venue);
        if (shares == 0) revert ZeroShares();
        _requireRecipient(to);
        uint256 supply = themeToken.totalSupply();
        if (shares > supply) revert SharesExceedSupply();
        uint256 redeemValueUsd = Math.mulDiv(_totalValueStrict(), shares, supply);
        if (redeemValueUsd > maxRedeemUsd) revert MaxRedeemExceeded();
        uint256 usdgBefore = IERC20(usdg).balanceOf(address(this));
        uint256 n = _constituents.length;
        uint256[] memory amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = Math.mulDiv(activeBalance(i), shares, supply);
        }
        themeToken.burn(msg.sender, shares);
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) continue;
            usdgOut += _settleSwap(venue, _constituents[i], usdg, amounts[i]);
        }
        if (usdgOut == 0 || usdgOut < minUsdgOut) revert SlippageExceeded();
        if (usdgOut != 0) _sendExact(usdg, to, usdgOut);
        if (IERC20(usdg).balanceOf(address(this)) != usdgBefore) revert SettlementMismatch(usdg);
        emit RedeemedToUsdg(msg.sender, to, shares, usdgOut);
    }

    // ─────────────────────────── no sequencer check ───────────────────────
    //
    // Chainlink publishes NO sequencer-uptime feed for Robinhood Chain, despite
    // RHC docs recommending the pattern (Design Law 3b). A check against a
    // non-existent feed would revert every operation. The reference is kept
    // here, inert, for the day one ships. Liveness is monitored off-chain
    // (OPS-6) and gates the API, not the vault.
    //
    //   AggregatorV3Interface sequencerUptimeFeed = AggregatorV3Interface(SEQ_FEED);
    //   (, int256 sequencerStatus, uint256 startedAt,,) = sequencerUptimeFeed.latestRoundData();
    //   if (sequencerStatus != 0) revert SequencerDown();
    //   if (block.timestamp - startedAt <= 3600) revert SequencerGracePeriod();

    // ─────────────────────────── views ───────────────────────────────────

    function constituents() external view returns (address[] memory) {
        return _constituents;
    }

    function feeds() external view returns (address[] memory) {
        return _feeds;
    }

    function targetWeightsBps() external view returns (uint256[] memory) {
        return _targetWeightsBps;
    }

    function capsBps() external view returns (uint256[] memory) {
        return _capsBps;
    }

    function allowedVenues() external view returns (address[] memory) {
        return _allowedVenues;
    }

    function constituentCount() external view returns (uint256) {
        return _constituents.length;
    }

    /// @notice Current oracle-priced weights, in bps. Reverts if a feed fails a
    ///         guard (same as `navPerShare`).
    function currentWeightsBps() external view returns (uint256[] memory weights) {
        (uint256[] memory values, uint256 total) = _valuesStrict();
        uint256 n = values.length;
        weights = new uint256[](n);
        if (total == 0) return weights;
        for (uint256 i; i < n; ++i) {
            weights[i] = Math.mulDiv(values[i], BPS, total);
        }
    }

    /// @notice Max deviation of any constituent from its target, in bps.
    function currentDriftBps() external view returns (uint256) {
        (uint256[] memory values, uint256 total) = _valuesStrict();
        return _maxDriftBps(values, total);
    }

    // ─────────────────────────── internals ────────────────────────────────

    /// @dev Oracle price of one constituent feed, USD (1e18) per whole token,
    ///      with all three guards. Age clamped at zero for clock skew.
    function _feedPriceWad(uint256 i) internal view returns (uint256) {
        AggregatorV3Interface feed = AggregatorV3Interface(_feeds[i]);
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadAnswer(i, answer);
        if (updatedAt == 0) revert RoundIncomplete(i);
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        if (age > MAX_STALENESS) revert StaleFeed(i, age);
        // answer > 0 is guaranteed by the check above, so the cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (updatedAt > block.timestamp + 60) revert RoundIncomplete(i);
        uint8 decimals_ = feed.decimals();
        if (decimals_ > 18) revert InvalidConfiguration();
        return Math.mulDiv(uint256(answer), WAD, 10 ** decimals_);
    }

    /// @dev USD (1e18) per WHOLE token, oracle-guarded. `Σ(answer × uiMultiplier)`.
    function _wholeTokenValueWad(uint256 i) internal view returns (uint256) {
        uint256 value =
            Math.mulDiv(_feedPriceWad(i), IStockToken(_constituents[i]).uiMultiplier(), WAD);
        if (value == 0) revert BadAnswer(i, 0);
        return value;
    }

    /// @dev USD (1e18) value of `amount` native units of constituent `i`.
    function _valueOf(uint256 i, uint256 amount) internal view returns (uint256) {
        uint8 decimals_ = IERC20Metadata(_constituents[i]).decimals();
        if (decimals_ > 18) revert InvalidConfiguration();
        return Math.mulDiv(_wholeTokenValueWad(i), amount, 10 ** decimals_);
    }

    /// @dev Vault's full USD (1e18) holding of constituent `i`, oracle-guarded.
    function _constituentValueStrict(uint256 i) internal view returns (uint256) {
        return _valueOf(i, activeBalance(i));
    }

    function _totalValueStrict() internal view returns (uint256 total) {
        uint256 n = _constituents.length;
        for (uint256 i; i < n; ++i) {
            total += _constituentValueStrict(i);
        }
    }

    function _valuesStrict() internal view returns (uint256[] memory values, uint256 total) {
        uint256 n = _constituents.length;
        values = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            values[i] = _constituentValueStrict(i);
            total += values[i];
        }
    }

    /// @dev Best-effort value + a `stale` flag; never reverts. A round that is
    ///      structurally invalid (`answer <= 0` or `updatedAt == 0`) contributes
    ///      zero and flags stale — it is never priced. Age beyond MAX_STALENESS
    ///      still contributes at the last answer, flagged stale (the price has
    ///      not moved 0.5%). An advisory pause flag also flags stale.
    function _constituentValueIndicative(uint256 i)
        internal
        view
        returns (uint256 value, bool stale)
    {
        AggregatorV3Interface feed = AggregatorV3Interface(_feeds[i]);
        try feed.latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0 || updatedAt == 0) return (0, true);
            uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
            if (age > MAX_STALENESS) stale = true;

            // answer > 0 is guaranteed by the guard above.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 priceWad = uint256(answer) * WAD / (10 ** feed.decimals());
            uint256 whole = priceWad * IStockToken(_constituents[i]).uiMultiplier() / WAD;
            uint256 held = activeBalance(i);
            value = whole * held / (10 ** IERC20Metadata(_constituents[i]).decimals());
        } catch {
            return (0, true);
        }

        if (_advisoryPaused(i)) stale = true;
    }

    function _advisoryPaused(uint256 i) internal view returns (bool) {
        address c = _constituents[i];
        try IStockToken(c).oraclePaused() returns (bool p) {
            if (p) return true;
        } catch { }
        try IStockToken(c).tokenPaused() returns (bool p) {
            if (p) return true;
        } catch { }
        try IStockToken(c).paused() returns (bool p) {
            if (p) return true;
        } catch { }
        return false;
    }

    /// @dev Oracle-implied output amount for swapping `amountIn` of `tin` into
    ///      `tout`, in `tout` native units. USDG is valued at $1 (testnet).
    function _convert(address tin, address tout, uint256 amountIn) internal view returns (uint256) {
        uint256 inWholeWad = _assetWholeValueWad(tin);
        uint256 outWholeWad = _assetWholeValueWad(tout);
        uint8 dIn = IERC20Metadata(tin).decimals();
        uint8 dOut = IERC20Metadata(tout).decimals();
        if (dIn > 18 || dOut > 18) revert InvalidConfiguration();
        uint256 value = Math.mulDiv(amountIn, inWholeWad, 10 ** dIn);
        return Math.mulDiv(value, 10 ** dOut, outWholeWad);
    }

    function _assetWholeValueWad(address token) internal view returns (uint256) {
        if (token == usdg) return WAD;
        return _wholeTokenValueWad(_constituentIndex(token));
    }

    function _constituentIndex(address token) internal view returns (uint256) {
        uint256 n = _constituents.length;
        for (uint256 i; i < n; ++i) {
            if (_constituents[i] == token) return i;
        }
        revert NotAVaultAsset(token);
    }

    function _maxDriftBps(uint256[] memory values, uint256 total)
        internal
        view
        returns (uint256 maxd)
    {
        if (total == 0) return 0;
        for (uint256 i; i < values.length; ++i) {
            uint256 w = Math.mulDiv(values[i], BPS, total);
            uint256 t = _targetWeightsBps[i];
            uint256 d = w > t ? w - t : t - w;
            if (d > maxd) maxd = d;
        }
    }

    function _requireOnTargetWeight(uint256[] memory value, uint256 total) internal view {
        for (uint256 i; i < value.length; ++i) {
            uint256 w = Math.mulDiv(value[i], BPS, total);
            uint256 t = _targetWeightsBps[i];
            uint256 lo = t > mintRedeemBandBps ? t - mintRedeemBandBps : 0;
            uint256 hi = t + mintRedeemBandBps;
            if (w < lo || w > hi) revert DepositOffTargetWeight(i);
        }
    }
}
