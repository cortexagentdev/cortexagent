// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { FeeController } from "../src/FeeController.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { Test } from "forge-std/Test.sol";

/// @dev This test contract stands in as the ThemeToken's `vault`, so it can mint
///      and burn shares directly to drive supply. FeeController never reads the
///      vault, so no vault deployment is needed.
contract FeeControllerTest is Test {
    FeeController internal fc;
    ThemeToken internal token;

    address internal creator = makeAddr("creator");
    address internal protocol = makeAddr("protocol");
    address internal keeper = makeAddr("keeper");
    address internal holder = makeAddr("holder");

    uint256 internal constant FEE_BPS = 100; // 1% / year, == MAX_FEE_BPS
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PROTOCOL_CUT_BPS = 1_500;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant SUPPLY = 1_000_000e18;

    function setUp() public {
        token = new ThemeToken("Cortex AI Infrastructure", "ctxAIINFRA", 18, address(this));
        fc = new FeeController(token, creator, protocol, FEE_BPS);
        token.mint(holder, SUPPLY);
    }

    // --- construction ----------------------------------------------------

    function test_constructor_setsImmutables() public view {
        assertEq(address(fc.themeToken()), address(token));
        assertEq(fc.creator(), creator);
        assertEq(fc.protocol(), protocol);
        assertEq(fc.creatorFeeBps(), FEE_BPS);
        assertEq(fc.lastAccrualAt(), block.timestamp);
        assertEq(fc.MAX_FEE_BPS(), 100);
    }

    function test_audit_supplyChangesCannotRewritePastAccrual() public {
        skip(YEAR / 2);
        token.burn(holder, SUPPLY);
        skip(YEAR / 2);
        assertEq(fc.pendingShares(), SUPPLY * FEE_BPS / BPS / 2);
    }

    function test_audit_mintCannotChargeForTimeBeforeDeposit() public {
        token.burn(holder, SUPPLY);
        skip(YEAR);
        token.mint(holder, SUPPLY);
        assertEq(fc.pendingShares(), 0);
    }

    function test_audit_frequentCheckpointsPreserveRemainders() public {
        token.burn(holder, SUPPLY - 1);
        for (uint256 i; i < 100; ++i) {
            skip(YEAR);
            fc.accrue();
        }
        assertEq(fc.accruedShares(), 1);
    }

    function test_constructor_revertsFeeAboveCap() public {
        vm.expectRevert(FeeController.FeeAboveCap.selector);
        new FeeController(token, creator, protocol, FEE_BPS + 1);
    }

    function test_constructor_acceptsFeeAtCap() public {
        FeeController f = new FeeController(token, creator, protocol, 100);
        assertEq(f.creatorFeeBps(), 100);
    }

    function test_constructor_acceptsZeroFee() public {
        FeeController f = new FeeController(token, creator, protocol, 0);
        assertEq(f.creatorFeeBps(), 0);
        skip(YEAR);
        assertEq(f.pendingShares(), 0);
    }

    function test_constructor_revertsZeroAddress() public {
        vm.expectRevert(FeeController.ZeroAddress.selector);
        new FeeController(ThemeToken(address(0)), creator, protocol, FEE_BPS);

        vm.expectRevert(FeeController.ZeroAddress.selector);
        new FeeController(token, address(0), protocol, FEE_BPS);

        vm.expectRevert(FeeController.ZeroAddress.selector);
        new FeeController(token, creator, address(0), FEE_BPS);
    }

    function testFuzz_constructor_feeBoundary(uint256 bps) public {
        if (bps > fc.MAX_FEE_BPS()) {
            vm.expectRevert(FeeController.FeeAboveCap.selector);
            new FeeController(token, creator, protocol, bps);
        } else {
            FeeController f = new FeeController(token, creator, protocol, bps);
            assertEq(f.creatorFeeBps(), bps);
        }
    }

    // --- accrual is streaming (time x AUM), not per mint ----------------

    function test_accrues_againstAumOverTime() public {
        assertEq(fc.pendingShares(), 0);

        skip(YEAR);
        // supply * feeBps * dt / (YEAR * BPS) == SUPPLY * 100 / 10000 == SUPPLY / 100
        assertEq(fc.pendingShares(), SUPPLY / 100);

        fc.accrue();
        assertEq(fc.accruedShares(), SUPPLY / 100);
        assertEq(fc.pendingShares(), 0);
        assertEq(fc.lastAccrualAt(), block.timestamp);
    }

    function test_accrual_scalesLinearlyWithTime() public {
        skip(YEAR / 4);
        assertEq(fc.pendingShares(), SUPPLY / 100 / 4);
        skip(YEAR / 4);
        assertEq(fc.pendingShares(), SUPPLY / 100 / 2);
    }

    function test_accrual_isNotChargedPerMint() public {
        // Many mints inside one block must not move accrual at all.
        uint256 before = fc.pendingShares();
        for (uint256 i; i < 10; ++i) {
            token.mint(holder, 50_000e18);
        }
        assertEq(fc.pendingShares(), before);
        assertEq(fc.accruedShares(), 0);

        // Only the passage of time accrues.
        skip(1 days);
        assertGt(fc.pendingShares(), 0);
    }

    function test_accrual_tracksSupplyChanges() public {
        skip(YEAR);
        fc.accrue(); // fold in a year at SUPPLY
        uint256 first = fc.accruedShares();

        token.mint(holder, SUPPLY); // supply doubles
        skip(YEAR);
        fc.accrue();

        // second year accrues on 2 * SUPPLY
        assertEq(fc.accruedShares() - first, (2 * SUPPLY) / 100);
    }

    function test_accrue_idempotentWithinBlock() public {
        skip(YEAR);
        fc.accrue();
        uint256 a = fc.accruedShares();
        fc.accrue();
        fc.accrue();
        assertEq(fc.accruedShares(), a);
    }

    function test_accrue_pathIndependent_uptoDust() public {
        // one big step vs many small steps land on the same total, save for
        // per-step division dust (many small floors <= one big floor).
        FeeController stepwise = new FeeController(token, creator, protocol, FEE_BPS);
        uint256 steps = 12;
        for (uint256 i; i < steps; ++i) {
            skip(30 days);
            stepwise.accrue();
        }
        uint256 many = stepwise.accruedShares();

        // fc was left alone the whole time -> single accrual over 360 days
        fc.accrue();
        uint256 single = fc.accruedShares();

        assertLe(many, single);
        assertLe(single - many, steps);
    }

    // --- claim() splits with no rounding leak --------------------------

    function test_claim_splitsCreatorAndProtocol() public {
        skip(YEAR);
        uint256 expected = SUPPLY / 100;

        vm.expectEmit(true, false, false, true, address(fc));
        emit FeeController.Claimed(
            address(this),
            expected - (expected * PROTOCOL_CUT_BPS / BPS),
            expected * PROTOCOL_CUT_BPS / BPS
        );
        (uint256 creatorShares, uint256 protocolShares) = fc.claim();

        assertEq(protocolShares, expected * PROTOCOL_CUT_BPS / BPS);
        assertEq(creatorShares, expected - protocolShares);
        // the whole accrued total is accounted for, nothing stranded
        assertEq(creatorShares + protocolShares, expected);
        assertEq(fc.claimedShares(), expected);
        assertEq(fc.creatorClaimedShares(), creatorShares);
        assertEq(fc.protocolClaimedShares(), protocolShares);
        assertEq(fc.unclaimedShares(), 0);
    }

    function testFuzz_claim_noRoundingLeak(uint256 supply, uint256 dt, uint256 bps) public {
        supply = bound(supply, 1, 1e30);
        dt = bound(dt, 0, 20 * YEAR);
        bps = bound(bps, 0, 100);

        ThemeToken t = new ThemeToken("x", "x", 18, address(this));
        FeeController f = new FeeController(t, creator, protocol, bps);
        t.mint(holder, supply);

        skip(dt);
        uint256 accrued = f.accruedShares();
        (uint256 c, uint256 p) = f.claim();

        assertEq(c + p, accrued, "split must equal accrued exactly");
        assertEq(f.claimedShares(), accrued);
        assertEq(f.unclaimedShares(), 0);
    }

    function test_claim_multipleRoundsStayConsistent() public {
        uint256 totalCreator;
        uint256 totalProtocol;

        for (uint256 i; i < 5; ++i) {
            skip(73 days);
            (uint256 c, uint256 p) = fc.claim();
            totalCreator += c;
            totalProtocol += p;
        }

        assertEq(fc.creatorClaimedShares(), totalCreator);
        assertEq(fc.protocolClaimedShares(), totalProtocol);
        assertEq(fc.claimedShares(), totalCreator + totalProtocol);
        assertEq(fc.claimedShares(), fc.accruedShares());
        assertEq(fc.unclaimedShares(), 0);
    }

    function test_claim_zeroWhenNothingAccrued() public {
        (uint256 c, uint256 p) = fc.claim();
        assertEq(c, 0);
        assertEq(p, 0);
        assertEq(fc.claimedShares(), 0);

        // and a second claim right after a real claim yields nothing more
        skip(YEAR);
        fc.claim();
        (uint256 c2, uint256 p2) = fc.claim();
        assertEq(c2, 0);
        assertEq(p2, 0);
    }

    // --- claim() is permissionless, destinations are fixed -------------

    function test_claim_callableByAnyone() public {
        skip(YEAR);
        vm.prank(keeper);
        (uint256 c, uint256 p) = fc.claim();
        assertGt(c, 0);
        assertGt(p, 0);
        // credited to the fixed destinations, regardless of who called
        assertEq(fc.creatorClaimedShares(), c);
        assertEq(fc.protocolClaimedShares(), p);
    }

    function testFuzz_claim_anyCallerSameDestinations(address caller) public {
        vm.assume(caller != address(0));
        skip(YEAR);
        vm.prank(caller);
        fc.claim();
        assertEq(fc.creator(), creator);
        assertEq(fc.protocol(), protocol);
    }

    function test_destinations_stableAcrossClaims() public {
        address c0 = fc.creator();
        address p0 = fc.protocol();
        for (uint256 i; i < 3; ++i) {
            skip(100 days);
            fc.claim();
        }
        assertEq(fc.creator(), c0);
        assertEq(fc.protocol(), p0);
    }

    // --- split-rate helpers for feeRouter (BE-27) ----------------------

    function test_bpsHelpers_sumToFee() public view {
        assertEq(fc.creatorBps() + fc.protocolBps(), fc.creatorFeeBps());
        assertEq(fc.protocolBps(), FEE_BPS * PROTOCOL_CUT_BPS / BPS);
    }

    // --- immutability: no setter raises the fee or redirects the cut ---

    /**
     * Acceptance criterion: "There is no function that raises the fee after
     * deploy. Grep and assert in a test." `creatorFeeBps` is `immutable`, so the
     * compiler already forbids a post-construction write; this reads the shipped
     * source and fails if a setter or an authority hook is ever added.
     */
    function test_source_hasNoFeeSetterOrOwner() public view {
        string memory src = vm.readFile("src/FeeController.sol");

        assertTrue(
            _contains(src, "uint256 public immutable creatorFeeBps"),
            "creatorFeeBps must stay immutable"
        );
        assertTrue(
            _contains(src, "address public immutable creator"), "creator must stay immutable"
        );
        assertTrue(
            _contains(src, "address public immutable protocol"), "protocol must stay immutable"
        );

        string[14] memory forbidden = [
            "function setFee",
            "function setCreatorFee",
            "function setFeeBps",
            "function raiseFee",
            "function updateFee",
            "function bumpFee",
            "function setCreator",
            "function setProtocol",
            "function setDestination",
            "function setBeneficiary",
            "onlyOwner",
            "Ownable",
            "delegatecall",
            "selfdestruct"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            assertFalse(_contains(src, forbidden[i]), forbidden[i]);
        }

        // Each immutable is assigned exactly once, only in the constructor.
        assertEq(_count(src, "creatorFeeBps = "), 1, "creatorFeeBps assigned once");
        assertEq(_count(src, "creator = "), 1, "creator assigned once");
        assertEq(_count(src, "protocol = "), 1, "protocol assigned once");
        assertTrue(_contains(src, "creatorFeeBps = creatorFeeBps_;"), "ctor assignment expected");
    }

    function test_fee_cannotBeRaised_noInterfaceForIt() public {
        // There is no ABI entrypoint that mutates the rate. The rate read before
        // and after an arbitrary year of activity is identical.
        uint256 rate = fc.creatorFeeBps();
        skip(YEAR);
        fc.accrue();
        fc.claim();
        skip(YEAR);
        fc.claim();
        assertEq(fc.creatorFeeBps(), rate);
    }

    // --- helpers -------------------------------------------------------

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        return _count(haystack, needle) > 0;
    }

    function _count(string memory haystack, string memory needle) internal pure returns (uint256) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return 0;

        uint256 hits;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool matchHere = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matchHere = false;
                    break;
                }
            }
            if (matchHere) hits++;
        }
        return hits;
    }
}
