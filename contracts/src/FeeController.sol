// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ThemeToken } from "./ThemeToken.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title FeeController
 * @notice Legacy recorded accounting only. Accrual and claim update counters;
 * neither operation transfers tokens, mints shares, pays a creator, buys CTX,
 * or distributes value. ThemeToken grants mint/burn authority only to its vault.
 * The zero-fee release constructs this ledger at rate zero to preserve the
 * factory's three-CREATE address sequence and offers no payout action.
 * Immutable destinations and rate preserve legacy deployments and their ABI.
 */
contract FeeController {
    // ─────────────────────────── constants ────────────────────────────────

    /// @notice Program ceiling on the streaming fee. A PROTOCOL CONSTANT, not a
    ///         per-deploy parameter. Matches `KeylessVault.MAX_FEE_BPS`.
    uint256 public constant MAX_FEE_BPS = 100;

    /// @notice The protocol's share of every accrued fee, in bps OF THE FEE
    ///         (not of AUM). The remainder is the creator's. A protocol
    ///         constant, identical for every theme, fixed in the bytecode.
    uint256 public constant PROTOCOL_CUT_BPS = 1_500;

    uint256 internal constant BPS = 10_000;

    /// @dev Accrual denominator. 365 days, fixed — a streaming rate quoted "per
    ///      year" needs a stable year or the effective rate drifts.
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    // ─────────────────── policy — written once, never again ────────────────

    /// @notice The theme share this fee accrues against. Sole supply reference.
    ThemeToken public immutable themeToken;

    /// @notice Recorded creator destination. Cannot be changed.
    address public immutable creator;

    /// @notice Recorded protocol destination only. Cannot be changed.
    address public immutable protocol;

    /// @notice The streaming fee rate, in bps of tracking AUM per year. Fixed at
    ///         construction, bounded by `MAX_FEE_BPS`. THERE IS NO SETTER, so
    ///         this can never be raised (or lowered) after deploy.
    uint256 public immutable creatorFeeBps;

    // ─────────────────────────── accrual ledger ───────────────────────────

    /// @notice Unix timestamp accrual was last rolled forward to.
    uint256 public lastAccrualAt;

    /// @dev Lifetime gross accrual, in `themeToken` share units.
    uint256 internal _accruedShares;
    /// @dev Lifetime amount moved out of accrual by `claim()` (creator + protocol).
    uint256 internal _claimedShares;
    uint256 internal _creatorClaimedShares;
    uint256 internal _protocolClaimedShares;
    uint256 private _supplySecondsCheckpoint;
    uint256 private _accrualRemainder;

    // ─────────────────────────── errors ───────────────────────────────────

    error ZeroAddress();
    error FeeAboveCap();

    // ─────────────────────────── events ───────────────────────────────────

    event FeeAccrued(uint256 addedShares, uint256 totalAccruedShares, uint256 atSupply);
    event Claimed(address indexed caller, uint256 creatorShares, uint256 protocolShares);

    // ─────────────────────────── construction ─────────────────────────────

    /**
     * @param themeToken_ The deployed theme share. Its `totalSupply()` is the
     *        tracking-AUM base the fee accrues against.
     * @param creator_ The creator cut destination. Fixed forever.
     * @param protocol_ The protocol cut destination. Fixed forever.
     * @param creatorFeeBps_ Streaming rate, bps of AUM per year. `<= MAX_FEE_BPS`.
     *        Zero is allowed (a creator may waive the fee); anything above the
     *        program cap reverts.
     */
    constructor(
        ThemeToken themeToken_,
        address creator_,
        address protocol_,
        uint256 creatorFeeBps_
    ) {
        if (address(themeToken_) == address(0) || creator_ == address(0) || protocol_ == address(0))
        {
            revert ZeroAddress();
        }
        if (creatorFeeBps_ > MAX_FEE_BPS) revert FeeAboveCap();

        themeToken = themeToken_;
        creator = creator_;
        protocol = protocol_;
        creatorFeeBps = creatorFeeBps_;
        lastAccrualAt = block.timestamp;
        _supplySecondsCheckpoint = themeToken_.cumulativeSupplySeconds();
    }

    // ─────────────────────────── views ────────────────────────────────────

    /// @notice Shares that have accrued since `lastAccrualAt` but are not yet
    ///         folded into `_accruedShares`. `supply × rate × dt`.
    function pendingShares() public view returns (uint256) {
        (uint256 added,) = _pending();
        return added;
    }

    function _pending() private view returns (uint256 added, uint256 remainder) {
        uint256 delta = themeToken.cumulativeSupplySeconds() - _supplySecondsCheckpoint;
        uint256 denominator = SECONDS_PER_YEAR * BPS;
        added = Math.mulDiv(delta, creatorFeeBps, denominator);
        remainder = mulmod(delta, creatorFeeBps, denominator) + _accrualRemainder;
        added += remainder / denominator;
        remainder %= denominator;
    }

    /// @notice Lifetime gross accrual including the not-yet-folded pending slice.
    ///         This is `feeRouter.creatorAccrual.accruedShares` (BE-27).
    function accruedShares() external view returns (uint256) {
        return _accruedShares + pendingShares();
    }

    /// @notice Accrued but not yet split by `claim()`.
    function unclaimedShares() public view returns (uint256) {
        return _accruedShares + pendingShares() - _claimedShares;
    }

    function claimedShares() external view returns (uint256) {
        return _claimedShares;
    }

    function creatorClaimedShares() external view returns (uint256) {
        return _creatorClaimedShares;
    }

    function protocolClaimedShares() external view returns (uint256) {
        return _protocolClaimedShares;
    }

    /// @notice The protocol's effective slice of AUM per year, in bps. Rounds
    ///         down; `creatorBps()` takes the remainder so the two always sum to
    ///         `creatorFeeBps` with no leak. This is
    ///         `feeRouter.creatorAccrual.protocolBps` (BE-27).
    function protocolBps() public view returns (uint256) {
        return creatorFeeBps * PROTOCOL_CUT_BPS / BPS;
    }

    /// @notice The creator's effective slice of AUM per year, in bps. This is
    ///         `feeRouter.creatorAccrual.creatorBps` (BE-27).
    function creatorBps() external view returns (uint256) {
        return creatorFeeBps - protocolBps();
    }

    /// @notice One-shot read for `feeRouter.creatorAccrual` (BE-27).
    function accrual()
        external
        view
        returns (
            uint256 accrued,
            uint256 unclaimed,
            uint256 creatorClaimed,
            uint256 protocolClaimed
        )
    {
        uint256 pending = pendingShares();
        accrued = _accruedShares + pending;
        unclaimed = accrued - _claimedShares;
        creatorClaimed = _creatorClaimedShares;
        protocolClaimed = _protocolClaimedShares;
    }

    // ─────────────────────────── mutators ─────────────────────────────────

    /// @notice Roll accrual forward to now. Permissionless; a keeper may call it
    ///         to checkpoint the ledger before a large supply change. Safe to
    ///         call at any cadence: over a fixed period and supply the total is
    ///         the same whether checkpointed once or many times. Fractional
    ///         accrual is retained across checkpoints.
    function accrue() public returns (uint256 added) {
        (added, _accrualRemainder) = _pending();
        _supplySecondsCheckpoint = themeToken.cumulativeSupplySeconds();
        lastAccrualAt = block.timestamp;
        if (added > 0) {
            _accruedShares += added;
            emit FeeAccrued(added, _accruedShares, themeToken.totalSupply());
        }
    }

    /**
     * @notice Split all unclaimed accrual into the creator cut and the protocol
     *         cut. Callable by ANYONE; the destinations are fixed at
     *         construction and cannot be redirected.
     *
     * The split has no rounding leak: `protocolShares` rounds down and
     * `creatorShares` takes the exact remainder, so
     * `creatorShares + protocolShares == unclaimed` for every input.
     *
     * On C2 the physical transfer of value is stubbed (see the contract notice):
     * this settles the ledger and emits the amounts for `BE-26` / `feeRouter`.
     *
     * @return creatorShares Amount credited to the creator this call.
     * @return protocolShares Amount credited to the protocol this call.
     */
    function claim() external returns (uint256 creatorShares, uint256 protocolShares) {
        accrue();

        uint256 claimable = _accruedShares - _claimedShares;
        if (claimable == 0) return (0, 0);

        protocolShares = Math.mulDiv(_accruedShares, PROTOCOL_CUT_BPS, BPS) - _protocolClaimedShares;
        creatorShares = claimable - protocolShares; // exact remainder — no leak

        _claimedShares += claimable;
        _creatorClaimedShares += creatorShares;
        _protocolClaimedShares += protocolShares;

        emit Claimed(msg.sender, creatorShares, protocolShares);
    }
}
