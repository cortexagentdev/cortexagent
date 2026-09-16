// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title CTX
 * @notice The Cortex protocol token. Deliberately the simplest contract in the
 *         set (CortexBackend.md PART 4, the `CTX.sol` line) and deliberately
 *         downstream of the research narrative: per the product positioning the
 *         token is not the reason the terminal exists (CortexOverview.md §4).
 *
 * ── Fixed supply, minted once ──────────────────────────────────────────────
 * The entire supply is minted in this constructor and split across the four
 * allocation destinations. After construction:
 *
 *   - there is NO `mint` function. Not owner-gated, not role-gated. Absent.
 *   - there is no `burn` beyond what a holder does to their own balance via the
 *     standard ERC-20 surface, which cannot lift supply.
 *   - `totalSupply()` is therefore constant for the life of the contract.
 *
 * `CTX.t.sol` greps this source and asserts no mint entrypoint exists, alongside
 * a runtime check that `totalSupply()` never moves.
 *
 * ── No keys ───────────────────────────────────────────────────────────────
 * There is no owner, no admin, no access-control role, no pause, and no upgrade
 * path (this contract sits behind no proxy). It is a plain OpenZeppelin ERC-20
 * with a constructor that does the distribution and nothing else. This matches
 * ThemeToken.sol and FeeController.sol: Design Law 4, "no admin key can move
 * user funds or reweight outside published policy."
 *
 * ── Studio-standard 80 / 10 / 5 / 5 allocation ─────────────────────────────
 * The full {TOTAL_SUPPLY} is distributed at construction as:
 *
 *   | Bucket              | Share | Amount (1e18)        | Purpose                                    |
 *   | ------------------- | ----- | -------------------- | ------------------------------------------ |
 *   | Community & ecosystem | 80% | 800,000,000          | Distribution, incentives, staking rewards  |
 *   |                     |       |                      | reserve, airdrops. The circulating float   |
 *   |                     |       |                      | the fee flywheel buys back into.           |
 *   | Core contributors   | 10%   | 100,000,000          | Team and early builders.                    |
 *   | Treasury            | 5%    | 50,000,000           | Protocol-owned reserve, grants, ops.        |
 *   | Initial liquidity   | 5%    | 50,000,000           | Seeding the trading pool and market making. |
 *
 * The last bucket is computed as the remainder of {TOTAL_SUPPLY} after the other
 * three, so the four transfers sum to {TOTAL_SUPPLY} EXACTLY with no dust ever
 * stranded in this contract, regardless of how the percentages round. With a
 * 1,000,000,000-token base every split is already integral, but the remainder
 * form makes the "sums to total supply" property hold structurally.
 *
 * Vesting, lockups and cliffs for the contributor and treasury buckets are an
 * off-chain / escrow-contract concern: each destination address may itself be a
 * vesting contract. This token does not encode a schedule.
 *
 * ── Testnet only ──────────────────────────────────────────────────────────
 * Deployed to RHC testnet 46630 only. No real value, from anyone, including the
 * team (locked decision 5). $CTX premium tiers and staking are C4 and are not
 * built now (locked decision 10): `authRouter.me()` returns `tier: "open"`
 * regardless of any balance. This task ships the token and nothing else.
 */
contract CTX is ERC20 {
    /// @notice The immutable total (and only ever) supply. One billion CTX.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Community & ecosystem allocation, 80% of {TOTAL_SUPPLY}.
    uint256 public constant COMMUNITY_ALLOCATION = (TOTAL_SUPPLY * 80) / 100;
    /// @notice Core contributor allocation, 10% of {TOTAL_SUPPLY}.
    uint256 public constant CONTRIBUTORS_ALLOCATION = (TOTAL_SUPPLY * 10) / 100;
    /// @notice Treasury allocation, 5% of {TOTAL_SUPPLY}.
    uint256 public constant TREASURY_ALLOCATION = (TOTAL_SUPPLY * 5) / 100;
    /// @notice Initial-liquidity allocation, the remaining 5% of {TOTAL_SUPPLY}.
    ///         Defined as the remainder so the four buckets sum to
    ///         {TOTAL_SUPPLY} with no rounding dust.
    uint256 public constant LIQUIDITY_ALLOCATION =
        TOTAL_SUPPLY - COMMUNITY_ALLOCATION - CONTRIBUTORS_ALLOCATION - TREASURY_ALLOCATION;

    error ZeroAddress();

    /**
     * @param community Community & ecosystem sink. Receives 80%.
     * @param contributors Core-contributor sink. Receives 10%.
     * @param treasury Treasury sink. Receives 5%.
     * @param liquidity Initial-liquidity sink. Receives the remaining 5%.
     *
     * Each destination is consumed here and never stored: there is nothing to
     * change afterwards. A zero address in any slot reverts, so no allocation is
     * ever burned to `address(0)` by mistake.
     */
    constructor(address community, address contributors, address treasury, address liquidity)
        ERC20("Cortex", "CTX")
    {
        if (
            community == address(0) || contributors == address(0) || treasury == address(0)
                || liquidity == address(0)
        ) {
            revert ZeroAddress();
        }

        _mint(community, COMMUNITY_ALLOCATION);
        _mint(contributors, CONTRIBUTORS_ALLOCATION);
        _mint(treasury, TREASURY_ALLOCATION);
        _mint(liquidity, LIQUIDITY_ALLOCATION);

        // Belt to the remainder-form suspenders: the four mints must have moved
        // the entire supply, leaving nothing mintable later and no dust here.
        assert(totalSupply() == TOTAL_SUPPLY);
    }
}
