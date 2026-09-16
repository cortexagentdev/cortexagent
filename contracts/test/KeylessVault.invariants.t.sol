// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { KeylessVault } from "../src/KeylessVault.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { MockAggregator, MockERC20, MockStock, MockVenue } from "./mocks/Mocks.sol";
import { Test } from "forge-std/Test.sol";

/**
 * Stateful fuzz over mint / redeem / share transfers. Prices are held constant so the
 * only forces on NAV/share are the mint band and redeem floor dust,
 * which push it up or leave it flat — never down.
 *
 * Invariants:
 *   1. `ThemeToken.totalSupply()` equals the sum of shares this suite minted
 *      minus the shares it redeemed. No admin path forged supply.
 *   2. NAV/share never falls below par while shares exist.
 *   3. Shares outstanding implies backing: the vault still holds a constituent.
 */
contract KeylessVaultHandler is Test {
    KeylessVault public vault;
    ThemeToken public themeToken;
    MockStock public stockA;
    MockStock public stockB;
    MockAggregator public feedA;
    MockAggregator public feedB;
    MockVenue public venue;

    address[3] public actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];

    uint256 public ghostSharesMinted;
    uint256 public ghostSharesRedeemed;

    constructor(
        KeylessVault _vault,
        ThemeToken _themeToken,
        MockStock _a,
        MockStock _b,
        MockAggregator _fa,
        MockAggregator _fb,
        MockVenue _v
    ) {
        vault = _vault;
        themeToken = _themeToken;
        stockA = _a;
        stockB = _b;
        feedA = _fa;
        feedB = _fb;
        venue = _v;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function _refresh() internal {
        feedA.set(100e8, block.timestamp);
        feedB.set(50e8, block.timestamp);
    }

    function mint(uint256 seed, uint256 k) public {
        _refresh();
        k = bound(k, 1, 5000);
        address who = _actor(seed);

        uint256[] memory amt = new uint256[](2);
        amt[0] = 60e8 * k;
        amt[1] = 80e8 * k;
        stockA.mint(who, amt[0]);
        stockB.mint(who, amt[1]);

        vm.startPrank(who);
        stockA.approve(address(vault), amt[0]);
        stockB.approve(address(vault), amt[1]);
        try vault.mint(amt, who, 0) returns (uint256 shares) {
            ghostSharesMinted += shares;
        } catch { }
        vm.stopPrank();
    }

    function redeem(uint256 seed, uint256 pctBps) public {
        _refresh();
        address who = _actor(seed);
        uint256 bal = themeToken.balanceOf(who);
        if (bal == 0) return;
        uint256 shares = bal * bound(pctBps, 1, 10_000) / 10_000;
        if (shares == 0) return;

        vm.prank(who);
        try vault.redeem(shares, who) {
            ghostSharesRedeemed += shares;
        } catch { }
    }

    function transferShares(uint256 seed, uint256 toSeed, uint256 pctBps) public {
        address owner = _actor(seed);
        uint256 shares = themeToken.balanceOf(owner) * bound(pctBps, 1, 10_000) / 10_000;
        vm.prank(owner);
        themeToken.transfer(_actor(toSeed), shares);
    }
}

abstract contract KeylessVaultInvariantFixture is Test {
    KeylessVault internal vault;
    ThemeToken internal themeToken;
    MockERC20 internal usdg;
    MockStock internal stockA;
    MockStock internal stockB;
    MockAggregator internal feedA;
    MockAggregator internal feedB;
    MockVenue internal venue;

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("USDG", "USDG", 6);
        stockA = new MockStock("Stock A", "AAA", 8);
        stockB = new MockStock("Stock B", "BBB", 8);
        feedA = new MockAggregator(8, 100e8, block.timestamp);
        feedB = new MockAggregator(8, 50e8, block.timestamp);
        venue = new MockVenue();
        venue.setPrice(address(stockA), 100e18);
        venue.setPrice(address(stockB), 50e18);
        venue.setPrice(address(usdg), 1e18);

        address[] memory c = new address[](2);
        c[0] = address(stockA);
        c[1] = address(stockB);
        address[] memory f = new address[](2);
        f[0] = address(feedA);
        f[1] = address(feedB);
        uint256[] memory w = new uint256[](2);
        w[0] = 6000;
        w[1] = 4000;
        uint256[] memory caps = new uint256[](2);
        caps[0] = 9000;
        caps[1] = 9000;
        address[] memory venues = new address[](1);
        venues[0] = address(venue);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        themeToken = new ThemeToken("Cortex Test", "ctxTEST", 18, predicted);
        vault = new KeylessVault(
            KeylessVault.ThemePolicy({
                themeToken: address(themeToken),
                usdg: address(usdg),
                creator: makeAddr("creator"),
                constituents: c,
                feeds: f,
                targetWeightsBps: w,
                capsBps: caps,
                creatorFeeBps: 0, // Current shared presets have no creator fee.
                mintRedeemBandBps: 80,
                slippageCapBps: 100,
                maxRedeemUsd: 1e30,
                allowedVenues: venues
            })
        );
    }
}

contract KeylessVaultInvariants is KeylessVaultInvariantFixture {
    KeylessVaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new KeylessVaultHandler(vault, themeToken, stockA, stockB, feedA, feedB, venue);
        targetContract(address(handler));
    }

    function invariant_supplyMatchesGhostAccounting() public view {
        assertEq(
            themeToken.totalSupply(),
            handler.ghostSharesMinted() - handler.ghostSharesRedeemed(),
            "supply moved outside mint/redeem"
        );
    }

    function invariant_navPerShareNeverBelowPar() public view {
        if (themeToken.totalSupply() == 0) return;
        assertGe(vault.navPerShare(), 1e18, "NAV/share fell below par");
    }

    function invariant_sharesImplyBacking() public view {
        if (themeToken.totalSupply() == 0) return;
        uint256 held = stockA.balanceOf(address(vault)) + stockB.balanceOf(address(vault));
        assertGt(held, 0, "shares outstanding with an empty vault");
    }
}
