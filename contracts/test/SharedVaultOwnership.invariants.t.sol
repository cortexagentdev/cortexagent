// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { KeylessVault } from "../src/KeylessVault.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { KeylessVaultInvariantFixture } from "./KeylessVault.invariants.t.sol";
import { MockAggregator, MockERC20, MockStock, MockVenue } from "./mocks/Mocks.sol";
import { Test } from "forge-std/Test.sol";

/// @notice Three independent holders interleave deposits, both USDG exit ABIs,
/// in-kind exits, share transfers, freezes, claims, and price changes. This is
/// an ownership test, not a claim that NAV cannot fall when the market moves.
/// No caught reverts: fail_on_revert makes unexpected failures/assertions fatal.
contract SharedVaultOwnershipHandler is Test {
    KeylessVault public vault;
    ThemeToken public token;
    MockERC20 public usdg;
    MockStock[2] public stocks;
    MockAggregator[2] public feeds;
    MockVenue public venue;
    address[3] public actors = [makeAddr("owner1"), makeAddr("owner2"), makeAddr("owner3")];

    uint256 public minted;
    uint256 public burned;
    uint256 public inKindMints;
    uint256 public routedMints;
    uint256 public inKindExits;
    uint256 public routedExits;
    uint256 public claims;
    uint256 public frozenExits;

    struct Ownership {
        uint256 supply;
        uint256[3] shares;
        uint256[6] claimUnits;
        uint256[6] claimAssets;
        uint256[6] shareAssets;
    }

    constructor(
        KeylessVault vault_,
        ThemeToken token_,
        MockERC20 usdg_,
        MockStock a,
        MockStock b,
        MockAggregator fa,
        MockAggregator fb,
        MockVenue venue_
    ) {
        vault = vault_;
        token = token_;
        usdg = usdg_;
        stocks = [a, b];
        feeds = [fa, fb];
        venue = venue_;
    }

    function _snapshot() private view returns (Ownership memory s) {
        s.supply = token.totalSupply();
        for (uint256 i; i < 3; ++i) {
            s.shares[i] = token.balanceOf(actors[i]);
            for (uint256 j; j < 2; ++j) {
                uint256 index = i * 2 + j;
                s.claimUnits[index] = vault.deferredUnits(actors[i], j);
                s.claimAssets[index] = vault.deferredBalance(actors[i], j);
                if (s.supply != 0) {
                    s.shareAssets[index] = vault.activeBalance(j) * s.shares[i] / s.supply;
                }
            }
        }
    }

    function _assertOtherOwners(Ownership memory before_, uint256 changedOwner) private view {
        Ownership memory after_ = _snapshot();
        for (uint256 i; i < 3; ++i) {
            if (i == changedOwner) continue;
            assertEq(after_.shares[i], before_.shares[i], "another holder's shares changed");
            for (uint256 j; j < 2; ++j) {
                uint256 index = i * 2 + j;
                assertEq(
                    after_.claimUnits[index], before_.claimUnits[index], "another claim was spent"
                );
                // Integer balances and the pro-rata share each floor once.
                assertGe(
                    after_.shareAssets[index] + 2,
                    before_.shareAssets[index],
                    "another holder lost constituent backing"
                );
                assertGe(
                    after_.claimAssets[index] + 1,
                    before_.claimAssets[index],
                    "another holder lost deferred backing"
                );
            }
        }
    }

    function _refresh() private {
        for (uint256 j; j < 2; ++j) {
            feeds[j].set(feeds[j].answer(), block.timestamp);
        }
    }

    function depositInKind(uint256 ownerSeed, uint256 size) public {
        if (stocks[0].frozen() || stocks[1].frozen()) return;
        _refresh();
        uint256 owner = ownerSeed % 3;
        uint256 k = bound(size, 1, 10);
        uint256[] memory amounts = new uint256[](2);
        // Match 60/40 at the CURRENT prices, even after large relative moves.
        amounts[0] = 3 * uint256(feeds[1].answer()) * k;
        amounts[1] = 2 * uint256(feeds[0].answer()) * k;
        Ownership memory before_ = _snapshot();
        for (uint256 j; j < 2; ++j) {
            stocks[j].mint(actors[owner], amounts[j]);
            vm.prank(actors[owner]);
            stocks[j].approve(address(vault), amounts[j]);
        }
        vm.prank(actors[owner]);
        uint256 shares = vault.mint(amounts, actors[owner], 1);
        minted += shares;
        ++inKindMints;
        assertEq(token.balanceOf(actors[owner]), before_.shares[owner] + shares);
        _assertOtherOwners(before_, owner);
    }

    function depositUsdg(uint256 ownerSeed, uint256 dollars, bool deadline) public {
        if (stocks[0].frozen() || stocks[1].frozen()) return;
        _refresh();
        uint256 owner = ownerSeed % 3;
        uint256 amount = bound(dollars, 1000, 10_000) * 1e6;
        Ownership memory before_ = _snapshot();
        usdg.mint(actors[owner], amount);
        vm.startPrank(actors[owner]);
        usdg.approve(address(vault), amount);
        uint256 shares = deadline
            ? vault.mintWithUsdgUntil(amount, address(venue), actors[owner], 1, block.timestamp + 1)
            : vault.mintWithUsdg(amount, address(venue), actors[owner], 1);
        vm.stopPrank();
        minted += shares;
        ++routedMints;
        assertEq(token.balanceOf(actors[owner]), before_.shares[owner] + shares);
        _assertOtherOwners(before_, owner);
    }

    function exitInKind(uint256 ownerSeed, uint256 portion) public {
        uint256 owner = ownerSeed % 3;
        uint256 shares = token.balanceOf(actors[owner]) * bound(portion, 1, 10_000) / 10_000;
        if (shares == 0) return;
        Ownership memory before_ = _snapshot();
        uint256[2] memory expected;
        uint256[2] memory walletBefore;
        for (uint256 j; j < 2; ++j) {
            expected[j] = vault.activeBalance(j) * shares / before_.supply;
            walletBefore[j] = stocks[j].balanceOf(actors[owner]);
        }
        vm.prank(actors[owner]);
        vault.redeem(shares, actors[owner]);
        burned += shares;
        ++inKindExits;
        if (stocks[0].frozen() || stocks[1].frozen()) ++frozenExits;
        assertEq(token.balanceOf(actors[owner]), before_.shares[owner] - shares);
        for (uint256 j; j < 2; ++j) {
            uint256 paid = stocks[j].balanceOf(actors[owner]) - walletBefore[j];
            uint256 claimIncrease =
                vault.deferredBalance(actors[owner], j) - before_.claimAssets[owner * 2 + j];
            // activeBalance then pro-rata floor twice. A prior deferred claim
            // can also gain one native unit of the successful payment's dust.
            assertApproxEqAbs(paid + claimIncrease, expected[j], 2, "exit ownership mismatch");
            if (stocks[j].frozen()) assertEq(paid, 0);
        }
        _assertOtherOwners(before_, owner);
    }

    function exitUsdg(uint256 ownerSeed, uint256 portion, bool deadline) public {
        if (stocks[0].frozen() || stocks[1].frozen()) return;
        _refresh();
        uint256 owner = ownerSeed % 3;
        uint256 shares = token.balanceOf(actors[owner]) * bound(portion, 1, 10_000) / 10_000;
        if (shares == 0) return;
        Ownership memory before_ = _snapshot();
        uint256 expected;
        for (uint256 j; j < 2; ++j) {
            uint256 amount = vault.activeBalance(j) * shares / before_.supply;
            // Dust is covered separately; here every leg must be swappable.
            if (amount < 1e5) return;
            expected += venue.quote(address(stocks[j]), address(usdg), amount);
        }
        uint256 walletBefore = usdg.balanceOf(actors[owner]);
        vm.prank(actors[owner]);
        uint256 paid = deadline
            ? vault.redeemToUsdgUntil(shares, address(venue), actors[owner], 1, block.timestamp + 1)
            : vault.redeemToUsdg(shares, address(venue), actors[owner], 1);
        burned += shares;
        ++routedExits;
        assertEq(paid, expected, "USDG exit not pro-rata active backing");
        assertEq(usdg.balanceOf(actors[owner]) - walletBefore, expected);
        assertEq(token.balanceOf(actors[owner]), before_.shares[owner] - shares);
        // Even the exiting owner's earlier deferred claims are NOT sold.
        for (uint256 j; j < 2; ++j) {
            assertEq(vault.deferredUnits(actors[owner], j), before_.claimUnits[owner * 2 + j]);
        }
        _assertOtherOwners(before_, owner);
    }

    function claim(uint256 ownerSeed, uint256 assetSeed, uint256 recipientSeed) public {
        uint256 owner = ownerSeed % 3;
        uint256 asset = assetSeed % 2;
        if (stocks[asset].frozen()) return;
        uint256 expected = vault.deferredBalance(actors[owner], asset);
        if (expected == 0) return;
        address recipient = actors[recipientSeed % 3];
        Ownership memory before_ = _snapshot();
        uint256 walletBefore = stocks[asset].balanceOf(recipient);
        vm.prank(actors[owner]);
        assertEq(vault.claimDeferred(asset, recipient), expected);
        ++claims;
        assertEq(stocks[asset].balanceOf(recipient) - walletBefore, expected);
        assertEq(vault.deferredUnits(actors[owner], asset), 0);
        assertEq(token.balanceOf(actors[owner]), before_.shares[owner]);
        _assertOtherOwners(before_, owner);
    }

    function transferShares(uint256 ownerSeed, uint256 recipientSeed, uint256 portion) public {
        uint256 owner = ownerSeed % 3;
        uint256 recipient = recipientSeed % 3;
        if (owner == recipient) return;
        Ownership memory before_ = _snapshot();
        uint256 shares = before_.shares[owner] * bound(portion, 1, 10_000) / 10_000;
        vm.prank(actors[owner]);
        token.transfer(actors[recipient], shares);
        assertEq(token.balanceOf(actors[owner]), before_.shares[owner] - shares);
        assertEq(token.balanceOf(actors[recipient]), before_.shares[recipient] + shares);
        assertEq(token.totalSupply(), before_.supply);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 2; ++j) {
                assertEq(vault.deferredUnits(actors[i], j), before_.claimUnits[i * 2 + j]);
                assertEq(vault.deferredBalance(actors[i], j), before_.claimAssets[i * 2 + j]);
            }
        }
    }

    function market(uint256 priceA, uint256 priceB, uint256 elapsed) public {
        vm.warp(block.timestamp + bound(elapsed, 0, 2 days));
        uint256[2] memory prices = [bound(priceA, 10, 500), bound(priceB, 10, 500)];
        for (uint256 j; j < 2; ++j) {
            feeds[j].set(int256(prices[j] * 1e8), block.timestamp);
            venue.setPrice(address(stocks[j]), prices[j] * 1e18);
        }
    }

    function freeze(uint256 assetSeed, bool frozen) public {
        stocks[assetSeed % 2].setFrozen(frozen);
    }

    /// @dev Called by afterInvariant, NOT fuzzed: after issuers unfreeze, every
    /// holder can exit, every non-dust claim can settle, and no payable backing
    /// is left with no owner. Oracle/router availability is irrelevant here.
    function closeAll() external {
        stocks[0].setFrozen(false);
        stocks[1].setFrozen(false);
        for (uint256 i; i < 3; ++i) {
            exitInKind(i, 10_000);
        }
        for (uint256 j; j < 2; ++j) {
            // A later rounded settlement may make an earlier dust claim
            // payable. Every successful claim removes one of the three owners.
            for (uint256 pass; pass < 3; ++pass) {
                for (uint256 i; i < 3; ++i) {
                    claim(i, j, i);
                }
            }
            uint256 unclaimed;
            for (uint256 i; i < 3; ++i) {
                unclaimed += vault.deferredBalance(actors[i], j);
            }
            assertEq(unclaimed, 0, "payable claim left after all owners tried to exit");
            // At most floor dust per remaining owner; units are NOT erased.
            assertLe(stocks[j].balanceOf(address(vault)), 2, "unowned assets stuck after exits");
        }
        assertEq(token.totalSupply(), 0);
    }
}

contract SharedVaultOwnershipInvariants is KeylessVaultInvariantFixture {
    SharedVaultOwnershipHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new SharedVaultOwnershipHandler(
            vault, themeToken, usdg, stockA, stockB, feedA, feedB, venue
        );
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.depositInKind.selector;
        selectors[1] = handler.depositUsdg.selector;
        selectors[2] = handler.exitInKind.selector;
        selectors[3] = handler.exitUsdg.selector;
        selectors[4] = handler.claim.selector;
        selectors[5] = handler.transferShares.selector;
        selectors[6] = handler.market.selector;
        selectors[7] = handler.freeze.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    function invariant_allSharesBelongToHolders() public view {
        uint256 owned;
        for (uint256 i; i < 3; ++i) {
            owned += themeToken.balanceOf(handler.actors(i));
        }
        assertEq(themeToken.totalSupply(), owned);
        assertEq(themeToken.totalSupply(), handler.minted() - handler.burned());
    }

    function invariant_activeAndDeferredAssetsDoNotOverlap() public view {
        for (uint256 j; j < 2; ++j) {
            uint256 accounted = vault.activeBalance(j);
            for (uint256 i; i < 3; ++i) {
                accounted += vault.deferredBalance(handler.actors(i), j);
            }
            uint256 held = handler.stocks(j).balanceOf(address(vault));
            assertLe(accounted, held, "multiple owners promised the same backing");
            assertLe(held - accounted, 3, "backing has no active or deferred owner");
        }
    }

    function invariant_noLingeringRouterAllowancesOrUsdg() public view {
        assertEq(stockA.allowance(address(vault), address(venue)), 0);
        assertEq(stockB.allowance(address(vault), address(venue)), 0);
        assertEq(usdg.allowance(address(vault), address(venue)), 0);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    function afterInvariant() public {
        handler.closeAll();
    }

    function test_ownershipHandlerExercisesEverySuccessfulAction() public {
        handler.depositInKind(0, 1);
        handler.depositUsdg(1, 1000, false);
        handler.depositUsdg(2, 2000, true);
        handler.freeze(0, true);
        handler.exitInKind(0, 5000);
        handler.transferShares(0, 1, 10_000);
        handler.freeze(0, false);
        handler.market(200, 25, 1 days);
        handler.depositInKind(2, 2);
        handler.exitUsdg(1, 5000, false);
        handler.exitUsdg(2, 5000, true);
        handler.claim(0, 0, 2);
        assertGt(handler.inKindMints(), 0);
        assertGt(handler.routedMints(), 0);
        assertGt(handler.inKindExits(), 0);
        assertGt(handler.routedExits(), 0);
        assertGt(handler.frozenExits(), 0);
        assertGt(handler.claims(), 0);
        invariant_allSharesBelongToHolders();
        invariant_activeAndDeferredAssetsDoNotOverlap();
        invariant_noLingeringRouterAllowancesOrUsdg();
        handler.closeAll();
    }
}
