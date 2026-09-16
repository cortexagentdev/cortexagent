// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { KeylessVault } from "../src/KeylessVault.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { MockAggregator, MockERC20, MockStock, MockVenue } from "./mocks/Mocks.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Test } from "forge-std/Test.sol";

/**
 * Unit + fuzz coverage for the PART 7 vault invariants. The fork half
 * (`KeylessVaultForkTest`) proves `MAX_STALENESS = 90000` is the bound that
 * binds against a real 86400-heartbeat feed.
 */
contract KeylessVaultTest is Test {
    KeylessVault internal vault;
    ThemeToken internal themeToken;

    MockERC20 internal usdg;
    MockStock internal stockA;
    MockStock internal stockB;
    MockAggregator internal feedA;
    MockAggregator internal feedB;
    MockVenue internal venue;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant BAND_BPS = 80; // > 0.5% (50) + fee (20)
    uint256 internal constant FEE_BPS = 20;

    function setUp() public {
        vm.warp(1_700_000_000);

        usdg = new MockERC20("USDG", "USDG", 6);
        stockA = new MockStock("Stock A", "AAA", 8);
        stockB = new MockStock("Stock B", "BBB", 8);
        feedA = new MockAggregator(8, 100e8, block.timestamp); // $100
        feedB = new MockAggregator(8, 50e8, block.timestamp); //  $50
        venue = new MockVenue();
        venue.setPrice(address(stockA), 100e18);
        venue.setPrice(address(stockB), 50e18);
        venue.setPrice(address(usdg), 1e18);

        // Break the token <-> vault cycle: predict the vault address (this
        // contract's next-but-one CREATE) and hand it to the token now.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        themeToken = new ThemeToken("Cortex Test", "ctxTEST", 18, predicted);
        vault = new KeylessVault(_policy());
        assertEq(address(vault), predicted, "vault landed at the predicted address");
    }

    function _policy() internal returns (KeylessVault.ThemePolicy memory p) {
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
        caps[0] = 8000;
        caps[1] = 8000;
        address[] memory venues = new address[](1);
        venues[0] = address(venue);

        p = KeylessVault.ThemePolicy({
            themeToken: address(themeToken),
            usdg: address(usdg),
            creator: makeAddr("creator"),
            constituents: c,
            feeds: f,
            targetWeightsBps: w,
            capsBps: caps,
            creatorFeeBps: FEE_BPS,
            mintRedeemBandBps: BAND_BPS,
            slippageCapBps: 100,
            maxRedeemUsd: 1_000_000e18,
            allowedVenues: venues
        });
    }

    // A deposit basket at exact 60/40 weights: k * ($6000 A + $4000 B).
    function _basket(uint256 k) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = 60e8 * k; // 60k tokens @ $100 = $6000k
        a[1] = 80e8 * k; // 80k tokens @ $50  = $4000k
    }

    function _mint(address who, uint256 k) internal returns (uint256 shares) {
        uint256[] memory amt = _basket(k);
        stockA.mint(who, amt[0]);
        stockB.mint(who, amt[1]);
        vm.startPrank(who);
        stockA.approve(address(vault), amt[0]);
        stockB.approve(address(vault), amt[1]);
        shares = vault.mint(amt, who, 0);
        vm.stopPrank();
    }

    function _freshenFeeds() internal {
        feedA.set(feedA.answer(), block.timestamp);
        feedB.set(feedB.answer(), block.timestamp);
    }

    // ─────────────────── construction / policy ────────────────────────────

    function test_maxStalenessConstantIs90000() public view {
        // A test asserts the constant so a future "tightening" fails loudly.
        assertEq(vault.MAX_STALENESS(), 90_000);
    }

    function test_constructor_storesPolicyImmutably() public view {
        assertEq(address(vault.themeToken()), address(themeToken));
        assertEq(vault.usdg(), address(usdg));
        assertEq(vault.mintRedeemBandBps(), BAND_BPS);
        assertEq(vault.constituentCount(), 2);
        assertTrue(vault.isAllowedVenue(address(venue)));
        assertEq(vault.targetWeightsBps()[0], 6000);
    }

    function test_constructor_rejectsConstituentWithNoFeed() public {
        KeylessVault.ThemePolicy memory p = _policy();
        p.feeds[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.ConstituentHasNoFeed.selector, 1));
        new KeylessVault(p);
    }

    function test_constructor_rejectsNonFeedAddress() public {
        KeylessVault.ThemePolicy memory p = _policy();
        p.feeds[0] = address(0xBEEF); // no code -> probe reverts
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.FeedNotResponding.selector, 0));
        new KeylessVault(p);
    }

    function test_constructor_rejectsBandNotAboveThresholdPlusFee() public {
        KeylessVault.ThemePolicy memory p = _policy();
        p.creatorFeeBps = 20;
        p.mintRedeemBandBps = 70; // == 50 + 20, must strictly exceed
        vm.expectRevert(KeylessVault.BandNotAboveThreshold.selector);
        new KeylessVault(p);

        p.mintRedeemBandBps = 71;
        new KeylessVault(p); // ok
    }

    function test_constructor_rejectsWeightsNotSummingToBps() public {
        KeylessVault.ThemePolicy memory p = _policy();
        p.targetWeightsBps[0] = 5999;
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.WeightsMustSumToBps.selector, 9999));
        new KeylessVault(p);
    }

    function test_bandExceedsHalfPercentPlusFee() public view {
        assertGt(vault.mintRedeemBandBps(), vault.DEVIATION_THRESHOLD_BPS() + vault.creatorFeeBps());
    }

    // ─────────────────── navPerShare guards ──────────────────────────────

    function test_navPerShare_revertsOnStaleFeed() public {
        _mint(alice, 1);
        vm.warp(block.timestamp + vault.MAX_STALENESS() + 1);
        vm.expectRevert();
        vault.navPerShare();
    }

    function test_navPerShare_okJustInsideStalenessBound() public {
        _mint(alice, 1);
        vm.warp(block.timestamp + vault.MAX_STALENESS()); // age == MAX_STALENESS, not >
        vault.navPerShare();
    }

    function test_navPerShare_revertsOnNonPositiveAnswer() public {
        _mint(alice, 1);
        feedA.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.BadAnswer.selector, 0, int256(0)));
        vault.navPerShare();

        feedA.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.BadAnswer.selector, 0, int256(-1)));
        vault.navPerShare();
    }

    function test_navPerShare_revertsOnIncompleteRound() public {
        _mint(alice, 1);
        feedA.set(100e8, 0);
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.RoundIncomplete.selector, 0));
        vault.navPerShare();
    }

    function test_navPerShare_clampsFutureUpdatedAt() public {
        _mint(alice, 1);
        feedA.set(100e8, block.timestamp + 14); // clock skew observed on RHC
        vault.navPerShare(); // must not underflow / revert
    }

    function test_navIndicative_neverReverts_flagsStale() public {
        _mint(alice, 1);
        vm.warp(block.timestamp + vault.MAX_STALENESS() + 100);
        (uint256 value, bool stale) = vault.navIndicative();
        assertTrue(stale);
        assertGt(value, 0); // still priced at last answer, never zero
    }

    function test_navIndicative_flagsStaleOnAdvisoryPause() public {
        _mint(alice, 1);
        _freshenFeeds();
        stockA.pauseOracle();
        (, bool stale) = vault.navIndicative();
        assertTrue(stale);
    }

    // ─────────────────── mint / redeem conserve NAV ──────────────────────

    function test_mint_bootstrapAppliesBand() public {
        uint256 shares = _mint(alice, 1);
        // $10,000 deposit, band 80bps retained -> 9920 shares.
        assertEq(shares, 9920e18);
        assertEq(vault.navValue(), 10_000e18);
        assertGt(vault.navPerShare(), 1e18); // band lifted NAV/share above par
    }

    function test_mintThenRedeem_conservesNav() public {
        _mint(alice, 1);
        _mint(bob, 2);

        uint256 navBefore = vault.navValue();
        uint256 npsBefore = vault.navPerShare();

        uint256 aShares = themeToken.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aShares, alice);

        // Alice's basket left; remaining AUM fell by at most her pro-rata value,
        // and NAV/share never dropped (floor dust favours the pool).
        assertLt(vault.navValue(), navBefore);
        assertGe(vault.navPerShare(), npsBefore);

        // Alice got real constituent tokens back, in kind.
        assertGt(stockA.balanceOf(alice), 0);
        assertGt(stockB.balanceOf(alice), 0);
    }

    function test_mint_addsExactlyDepositValueToAum() public {
        _mint(alice, 1);
        uint256 navBefore = vault.navValue();
        _mint(bob, 3);
        assertEq(vault.navValue(), navBefore + 30_000e18);
    }

    function testFuzz_mintRedeemRoundTrip_neverMintsValue(uint256 k1, uint256 k2) public {
        k1 = bound(k1, 1, 1e6);
        k2 = bound(k2, 1, 1e6);
        _mint(alice, k1);
        _mint(bob, k2);

        uint256 npsBefore = vault.navPerShare();
        uint256 bobShares = themeToken.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob);
        assertGe(vault.navPerShare(), npsBefore);
    }

    function test_mint_revertsOffTargetWeight() public {
        uint256[] memory amt = _basket(1);
        amt[0] = amt[0] * 2; // way overweight A
        stockA.mint(alice, amt[0]);
        stockB.mint(alice, amt[1]);
        vm.startPrank(alice);
        stockA.approve(address(vault), amt[0]);
        stockB.approve(address(vault), amt[1]);
        vm.expectRevert(abi.encodeWithSelector(KeylessVault.DepositOffTargetWeight.selector, 0));
        vault.mint(amt, alice, 0);
        vm.stopPrank();
    }

    function test_mint_revertsWhenFeedStale_safeFailure() public {
        _mint(alice, 1);
        vm.warp(block.timestamp + vault.MAX_STALENESS() + 1);
        uint256[] memory amt = _basket(1);
        stockA.mint(bob, amt[0]);
        stockB.mint(bob, amt[1]);
        vm.startPrank(bob);
        stockA.approve(address(vault), amt[0]);
        stockB.approve(address(vault), amt[1]);
        vm.expectRevert();
        vault.mint(amt, bob, 0);
        vm.stopPrank();
        // Bob keeps his funds.
        assertEq(stockA.balanceOf(bob), amt[0]);
    }

    function test_mintWithUsdg_routesAndMints() public {
        _mint(alice, 1); // bootstrap in kind first
        _freshenFeeds();

        uint256 usdgIn = 10_000e6;
        usdg.mint(bob, usdgIn);
        vm.startPrank(bob);
        usdg.approve(address(vault), usdgIn);
        uint256 shares = vault.mintWithUsdg(usdgIn, address(venue), bob, 0);
        vm.stopPrank();
        assertGt(shares, 0);
        assertEq(themeToken.balanceOf(bob), shares);
    }

    function test_mintWithUsdg_revertsOnUnknownVenue() public {
        usdg.mint(bob, 1e6);
        vm.startPrank(bob);
        usdg.approve(address(vault), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(KeylessVault.VenueNotAllowed.selector, address(0xABCD))
        );
        vault.mintWithUsdg(1e6, address(0xABCD), bob, 0);
        vm.stopPrank();
    }

    // ─────────────────── in-kind redeem: exit of last resort ─────────────

    function test_inKindRedeem_succeedsWhenEveryOracleStale() public {
        _mint(alice, 2);
        // Force every feed far past the bound, and incomplete for good measure.
        vm.warp(block.timestamp + 10 * vault.MAX_STALENESS());
        feedA.set(0, 0);
        feedB.set(0, 0);

        vm.expectRevert();
        vault.navPerShare(); // NAV is dead...

        uint256 shares = themeToken.balanceOf(alice);
        vm.prank(alice);
        (, uint256[] memory amounts,) = vault.redeem(shares, alice); // ...redeem still works

        assertEq(amounts[0], 120e8);
        assertEq(amounts[1], 160e8);
        assertEq(themeToken.totalSupply(), 0);
    }

    function test_inKindRedeem_frozenConstituentDoesNotBrickOthers() public {
        _mint(alice, 1);
        _mint(bob, 1);

        stockA.setFrozen(true); // Robinhood freezes A

        uint256 shares = themeToken.balanceOf(alice);
        vm.prank(alice);
        (address[] memory tokens, uint256[] memory amounts, address[] memory failed) =
            vault.redeem(shares, alice);

        assertEq(failed.length, 1);
        assertEq(failed[0], address(stockA));
        assertEq(amounts[0], 0); // A leg skipped
        assertGt(amounts[1], 0); // B leg still paid
        assertEq(tokens[1], address(stockB));
        assertEq(themeToken.balanceOf(alice), 0); // shares still burned

        // Bob can still redeem his share of B afterwards.
        stockA.setFrozen(false);
        uint256 bobShares = themeToken.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob);
    }

    function test_inKindRedeem_issuerPausedConstituentDoesNotBrickOthers() public {
        _mint(alice, 1);
        _mint(bob, 1);

        stockA.pause(); // Stock.pause() halts A transfers

        uint256 shares = themeToken.balanceOf(alice);
        vm.prank(alice);
        (,, address[] memory failed) = vault.redeem(shares, alice);

        assertEq(failed.length, 1);
        assertEq(failed[0], address(stockA));
        assertGt(stockB.balanceOf(alice), 0); // B paid despite A paused
        assertEq(themeToken.balanceOf(alice), 0);
    }

    function test_inKindRedeem_adminBurnedConstituentDoesNotBrickOthers() public {
        _mint(alice, 1);
        _mint(bob, 1);

        // Robinhood burns the vault's entire A holding.
        stockA.adminBurn(address(vault), stockA.balanceOf(address(vault)));

        uint256 shares = themeToken.balanceOf(alice);
        vm.prank(alice);
        (, uint256[] memory amounts,) = vault.redeem(shares, alice);

        assertEq(amounts[0], 0); // nothing left of A
        assertGt(amounts[1], 0); // B still paid pro-rata
        assertEq(themeToken.balanceOf(alice), 0);
    }

    function test_redeem_revertsOnZeroSharesOrBadRecipient() public {
        _mint(alice, 1);
        vm.prank(alice);
        vm.expectRevert(KeylessVault.ZeroShares.selector);
        vault.redeem(0, alice);

        vm.prank(alice);
        vm.expectRevert(KeylessVault.BadRecipient.selector);
        vault.redeem(1e18, address(0));
    }

    function test_redeemToUsdg_revertsPastMaxRedeemUsd() public {
        // Tight cap so a normal redeem trips it.
        KeylessVault.ThemePolicy memory p = _policy();
        p.maxRedeemUsd = 100e18;
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        ThemeToken tt = new ThemeToken("T2", "T2", 18, predicted);
        p.themeToken = address(tt);
        KeylessVault v2 = new KeylessVault(p);

        uint256[] memory amt = _basket(1);
        stockA.mint(alice, amt[0]);
        stockB.mint(alice, amt[1]);
        vm.startPrank(alice);
        stockA.approve(address(v2), amt[0]);
        stockB.approve(address(v2), amt[1]);
        uint256 sh = v2.mint(amt, alice, 0);
        vm.expectRevert(KeylessVault.MaxRedeemExceeded.selector);
        v2.redeemToUsdg(sh, address(venue), alice, 0);
        vm.stopPrank();
    }

    function test_redeemToUsdg_happyPath() public {
        _mint(alice, 1);
        _freshenFeeds();
        uint256 shares = themeToken.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeemToUsdg(shares, address(venue), alice, 0);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(alice), out);
    }

    // ─────────────────── price movement fixture ───────────────────────

    function _createDriftUpA() internal {
        // A doubles: 60/40 -> 75/25, allocation drift 1500bps.
        feedA.set(200e8, block.timestamp);
        feedB.set(50e8, block.timestamp);
        venue.setPrice(address(stockA), 200e18);
    }

    // ─────────────────── no admin path to funds ─────────────────────────

    function test_source_hasNoRescueOrAdminSurface() public view {
        string memory src = vm.readFile("src/KeylessVault.sol");
        string[8] memory forbidden = [
            "sweep",
            "rescue",
            "withdraw",
            "emergency",
            " onlyOwner",
            "selfdestruct",
            "delegatecall",
            "Ownable"
        ];
        for (uint256 i; i < forbidden.length; i++) {
            assertFalse(_contains(src, forbidden[i]), forbidden[i]);
        }
    }

    function test_source_sequencerCheckIsCommentedOut() public view {
        string memory src = vm.readFile("src/KeylessVault.sol");
        // The reference exists, but only as an inert comment: every line that
        // names the sequencer feed is prefixed with `//`.
        assertTrue(_contains(src, "//   AggregatorV3Interface sequencerUptimeFeed"));
        assertTrue(_contains(src, "//   (, int256 sequencerStatus"));
        assertTrue(_contains(src, "//   if (sequencerStatus != 0) revert SequencerDown();"));
        // No executable statement references it (no such error is declared).
        assertFalse(_contains(src, "error SequencerDown"));
    }

    function testFuzz_noArbitraryCallerCanDrainVault(address caller, uint256 amount) public {
        vm.assume(
            caller != address(0) && caller != address(vault) && caller != address(themeToken)
                && caller != alice
        );
        uint256 supply = _mint(alice, 5);
        _freshenFeeds();
        vm.deal(address(vault), 1 ether);

        uint256 aBefore = stockA.balanceOf(address(vault));
        uint256 bBefore = stockB.balanceOf(address(vault));
        uint256 ethBefore = address(vault).balance;

        amount = bound(amount, 1, supply);
        // A caller with no shares and no deposit cannot pull anything.
        vm.startPrank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, caller, 0, amount
            )
        );
        vault.redeem(amount, caller);
        (bool okNav,) = address(vault).call(abi.encodeWithSignature("navPerShare()"));
        okNav; // view, no state change regardless
        vm.stopPrank();

        assertEq(stockA.balanceOf(address(vault)), aBefore);
        assertEq(stockB.balanceOf(address(vault)), bBefore);
        assertEq(address(vault).balance, ethBefore);
        assertEq(stockA.balanceOf(caller), 0);
    }

    function test_creatorHasNoPower() public {
        address creator = vault.creator();
        _mint(alice, 1);
        _freshenFeeds();
        vm.startPrank(creator);
        vm.expectRevert();
        vault.redeem(1e18, creator); // creator holds no shares
        vm.stopPrank();
    }

    // ─────────────────── helpers ────────────────────────────────────────

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}

/**
 * Fork half. Proves `MAX_STALENESS = 90000` is the bound that binds: against a
 * real RHC equity feed (86400 heartbeat), NAV is live now, still live at an age
 * a minutes-scale bound would have rejected, and dead only once age passes
 * 90000s. Skips when the public RPC is unreachable so `forge test` stays green
 * offline (matches ForkChainlink.t.sol).
 */
contract KeylessVaultForkTest is Test {
    // Chainlink "Robinhood GOOGL / USD" AggregatorV3 proxy on RHC mainnet 4663.
    address internal constant GOOGL_USD_FEED = 0xF6f373a037c30F0e5010d854385cA89185AE638b;

    KeylessVault internal vault;
    ThemeToken internal themeToken;
    MockStock internal stock;
    MockERC20 internal usdg;
    MockVenue internal venue;
    bool internal forked;

    address internal alice = makeAddr("alice");

    function setUp() public {
        try vm.createSelectFork("rhc_mainnet") {
            forked = true;
        } catch {
            return;
        }

        usdg = new MockERC20("USDG", "USDG", 6);
        stock = new MockStock("GOOGL", "GOOGL", 8);
        venue = new MockVenue();

        address[] memory c = new address[](1);
        c[0] = address(stock);
        address[] memory f = new address[](1);
        f[0] = GOOGL_USD_FEED;
        uint256[] memory w = new uint256[](1);
        w[0] = 10_000;
        uint256[] memory caps = new uint256[](1);
        caps[0] = 10_000;
        address[] memory venues = new address[](1);
        venues[0] = address(venue);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        themeToken = new ThemeToken("Cortex GOOGL", "ctxGOOGL", 18, predicted);
        vault = new KeylessVault(
            KeylessVault.ThemePolicy({
                themeToken: address(themeToken),
                usdg: address(usdg),
                creator: address(this),
                constituents: c,
                feeds: f,
                targetWeightsBps: w,
                capsBps: caps,
                creatorFeeBps: 20,
                mintRedeemBandBps: 80,
                slippageCapBps: 100,
                maxRedeemUsd: 1e30,
                allowedVenues: venues
            })
        );

        // Give the vault a holding and mint shares directly (single constituent,
        // so the target-weight check is trivially satisfied).
        stock.mint(alice, 100e8);
        vm.startPrank(alice);
        stock.approve(address(vault), 100e8);
        uint256[] memory amt = new uint256[](1);
        amt[0] = 100e8;
        vault.mint(amt, alice, 0);
        vm.stopPrank();
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_navLiveNow() public onFork {
        assertGt(vault.navPerShare(), 0);
    }

    function test_fork_navStillLiveAtMinutesScaleAge() public onFork {
        // A 1-hour bound would reject a calm feed here; the heartbeat bound does not.
        vm.warp(block.timestamp + 3600);
        vault.navPerShare();
    }

    function test_fork_navRevertsOncePast90000() public onFork {
        vm.warp(block.timestamp + 90_001);
        vm.expectRevert();
        vault.navPerShare();
    }

    function test_fork_inKindRedeemWorksWhenFeedForcedDead() public onFork {
        vm.warp(block.timestamp + 200_000);
        uint256 shares = themeToken.balanceOf(alice);
        vm.prank(alice);
        (, uint256[] memory amounts,) = vault.redeem(shares, alice);
        assertEq(amounts[0], 100e8);
    }
}
