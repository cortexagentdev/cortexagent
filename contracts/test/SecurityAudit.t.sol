// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { KeylessVault } from "../src/KeylessVault.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { KeylessVaultTest } from "./KeylessVault.t.sol";
import { MockStock } from "./mocks/Mocks.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract FalseReturnAuditStock is MockStock {
    constructor() MockStock("False return", "FALSE", 8) { }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        return false;
    }
}

contract ReentrantAuditStock is MockStock {
    address private attackVault;
    uint256 private attackShares;
    bool public reentrySucceeded;
    constructor() MockStock("Attack", "ATTACK", 8) { }

    function setAttack(address vault, uint256 shares) external {
        attackVault = vault;
        attackShares = shares;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (attackVault != address(0) && (from == attackVault || to == attackVault)) {
            (reentrySucceeded,) = attackVault.call(
                abi.encodeWithSignature("redeem(uint256,address)", attackShares, address(this))
            );
        }
    }
}

contract GasBurningBalance {
    fallback() external {
        assembly { for { } 1 { } { } }
    }
}

interface IDeferredExit {
    function claimDeferred(uint256 index, address to) external returns (uint256);
    function deferredUnits(address owner, uint256 index) external view returns (uint256);
    function activeBalance(uint256 index) external view returns (uint256);
    function deferredBalance(address owner, uint256 index) external view returns (uint256);
}

contract SecurityAuditTest is KeylessVaultTest {
    // mode 0 is the oracle-free exit; modes 1 and 2 cover both routed ABIs.
    function _redeemMode(uint8 mode, uint256 shares, address to) private {
        if (mode == 0) vault.redeem(shares, to);
        else if (mode == 1) vault.redeemToUsdg(shares, address(venue), to, 1);
        else vault.redeemToUsdgUntil(shares, address(venue), to, 1, block.timestamp + 1);
    }

    function _ownershipState() private view returns (bytes32) {
        bytes memory state = abi.encode(themeToken.totalSupply());
        address[5] memory accounts = [alice, bob, keeper, address(vault), address(venue)];
        for (uint256 i; i < accounts.length; ++i) {
            address who = accounts[i];
            state = abi.encode(
                state,
                themeToken.balanceOf(who),
                stockA.balanceOf(who),
                stockB.balanceOf(who),
                usdg.balanceOf(who),
                vault.deferredUnits(who, 0),
                vault.deferredUnits(who, 1)
            );
        }
        return keccak256(state);
    }

    function testFuzz_audit_nonHolderCannotUseEitherUsdgExit(uint256 amount, address caller)
        public
    {
        vm.assume(
            caller != address(0) && caller != alice && caller != address(vault)
                && caller != address(themeToken)
        );
        uint256 shares = _mint(alice, 1);
        amount = bound(amount, 1, shares);
        bytes32 beforeState = _ownershipState();
        for (uint8 mode = 1; mode <= 2; ++mode) {
            vm.prank(caller);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, caller, 0, amount
                )
            );
            _redeemMode(mode, amount, bob);
            assertEq(_ownershipState(), beforeState);
            assertEq(usdg.balanceOf(caller), 0);
        }
    }

    function test_audit_approvalAndVictimRecipientDoNotAuthorizeAnyExit() public {
        _mint(alice, 1);
        vm.prank(alice);
        themeToken.approve(bob, type(uint256).max);
        bytes32 beforeState = _ownershipState();
        for (uint8 mode; mode < 3; ++mode) {
            vm.prank(bob);
            vm.expectRevert(
                abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 0, 1e18)
            );
            _redeemMode(mode, 1e18, alice);
            assertEq(_ownershipState(), beforeState);
        }
        // Approval permits transferFrom, not burning another wallet's shares.
        assertEq(themeToken.allowance(alice, bob), type(uint256).max);
    }

    function testFuzz_audit_holderCannotRedeemOtherHoldersShares(uint256 fraction) public {
        _mint(alice, 2);
        uint256 owned = _mint(bob, 1);
        uint256 amount = owned + bound(fraction, 1, themeToken.balanceOf(alice));
        bytes32 beforeState = _ownershipState();
        for (uint8 mode; mode < 3; ++mode) {
            vm.prank(bob);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, bob, owned, amount
                )
            );
            _redeemMode(mode, amount, bob);
            assertEq(_ownershipState(), beforeState);
        }
    }

    function testFuzz_audit_transferredSliceCannotBeRedeemedTwice(uint8 mode) public {
        mode = uint8(bound(mode, 0, 2));
        uint256 initial = _mint(alice, 1);
        uint256 slice = initial / 10;
        vm.prank(alice);
        themeToken.transfer(bob, slice);
        vm.prank(bob);
        _redeemMode(mode, slice, keeper);
        assertEq(themeToken.balanceOf(bob), 0);
        assertEq(themeToken.balanceOf(alice), initial - slice);
        if (mode == 0) {
            assertEq(stockA.balanceOf(keeper), 6e8);
            assertEq(stockB.balanceOf(keeper), 8e8);
        } else {
            assertEq(usdg.balanceOf(keeper), 1_000e6);
        }
        bytes32 afterExit = _ownershipState();
        // A successful USDG exit cannot be replayed as an in-kind exit or vice versa.
        for (uint8 replay; replay < 3; ++replay) {
            vm.prank(bob);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, bob, 0, slice
                )
            );
            _redeemMode(replay, slice, bob);
            assertEq(_ownershipState(), afterExit);
        }
        _exit(alice);
        assertEq(stockA.balanceOf(alice), 54e8);
        assertEq(stockB.balanceOf(alice), 72e8);
    }

    function test_audit_selfCallCannotBeForgedToStealDeferredClaim() public {
        _mint(alice, 1);
        stockA.setFrozen(true);
        _exit(alice);
        stockA.setFrozen(false);
        uint256 units = vault.deferredUnits(alice, 0);
        assertGt(units, 0);
        bytes32 beforeState = _ownershipState();
        vm.startPrank(bob);
        vm.expectRevert(KeylessVault.OnlySelf.selector);
        vault.redeemInKindLeg(0, units, alice, bob);
        vm.expectRevert(KeylessVault.NoDeferredClaim.selector);
        vault.claimDeferred(0, alice);
        vm.stopPrank();
        assertEq(_ownershipState(), beforeState);
        vm.prank(alice);
        assertEq(vault.claimDeferred(0, keeper), 60e8);
        assertEq(stockA.balanceOf(keeper), 60e8);
        vm.prank(alice);
        vm.expectRevert(KeylessVault.NoDeferredClaim.selector);
        vault.claimDeferred(0, keeper);
    }

    function test_audit_othersTokenApprovalsCannotFundAttackerMint() public {
        uint256[] memory amounts = _basket(1);
        stockA.mint(alice, amounts[0]);
        stockB.mint(alice, amounts[1]);
        usdg.mint(alice, 10_000e6);
        vm.startPrank(alice);
        stockA.approve(address(vault), type(uint256).max);
        stockB.approve(address(vault), type(uint256).max);
        usdg.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        bytes32 beforeState = _ownershipState();
        vm.startPrank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, amounts[0]
            )
        );
        vault.mint(amounts, bob, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 10_000e6
            )
        );
        vault.mintWithUsdg(10_000e6, address(venue), bob, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 10_000e6
            )
        );
        vault.mintWithUsdgUntil(10_000e6, address(venue), bob, 1, block.timestamp + 1);
        vm.stopPrank();
        assertEq(_ownershipState(), beforeState);
    }

    function testFuzz_audit_failedUsdgExitRestoresAllOwnership(bool withDeadline) public {
        uint256 shares = _mint(alice, 1);
        _mint(bob, 1);
        bytes32 beforeState = _ownershipState();
        // Failure happens after burning shares and executing both swaps, so
        // this checks atomic rollback, not just early input validation.
        vm.prank(alice);
        vm.expectRevert(KeylessVault.SlippageExceeded.selector);
        if (withDeadline) {
            vault.redeemToUsdgUntil(
                shares, address(venue), alice, type(uint256).max, block.timestamp + 1
            );
        } else {
            vault.redeemToUsdg(shares, address(venue), alice, type(uint256).max);
        }
        assertEq(_ownershipState(), beforeState);
        assertEq(stockA.allowance(address(vault), address(venue)), 0);
        assertEq(stockB.allowance(address(vault), address(venue)), 0);
        _exit(alice);
        _exit(bob);
        assertEq(stockA.balanceOf(address(vault)), 0);
        assertEq(stockB.balanceOf(address(vault)), 0);
    }

    struct RemovedRebalanceStep {
        address venue;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
    }

    function test_audit_removedRebalancingAndNativeFundingRejectOnEveryChain() public {
        _mint(alice, 10);
        _createDriftUpA();
        RemovedRebalanceStep[] memory steps = new RemovedRebalanceStep[](1);
        steps[0] = RemovedRebalanceStep(address(venue), address(stockA), address(stockB), 120e8);
        uint256[3] memory chains = [uint256(31337), uint256(46630), uint256(4663)];
        vm.deal(address(this), 1 ether);
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            (bool legacy,) = address(vault)
                .call(
                    abi.encodeWithSignature("rebalance((address,address,address,uint256)[])", steps)
                );
            (bool deadline,) = address(vault)
                .call(
                    abi.encodeWithSignature(
                        "rebalanceUntil((address,address,address,uint256)[],uint256)",
                        steps,
                        block.timestamp + 1
                    )
                );
            (bool funded,) = address(vault).call{ value: 1 wei }("");
            assertFalse(legacy);
            assertFalse(deadline);
            assertFalse(funded);
        }
        assertEq(stockA.balanceOf(address(vault)), 600e8);
        _exit(alice);
        assertEq(stockA.balanceOf(alice), 600e8);
    }

    function test_audit_transferredSharesRedeemByNewWallet() public {
        uint256 shares = _mint(alice, 1);
        vm.prank(alice);
        themeToken.transfer(bob, shares);
        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(shares, alice);
        _exit(bob);
        assertEq(stockA.balanceOf(bob), 60e8);
        assertEq(stockB.balanceOf(bob), 80e8);
        assertEq(themeToken.totalSupply(), 0);
    }

    function test_audit_transferredSharesCreateClaimsForNewWallet() public {
        uint256 shares = _mint(alice, 1);
        vm.prank(alice);
        themeToken.transfer(bob, shares);
        stockA.setFrozen(true);
        _exit(bob);
        assertEq(vault.deferredUnits(alice, 0), 0);
        assertGt(vault.deferredUnits(bob, 0), 0);
        stockA.setFrozen(false);
        vm.prank(alice);
        vm.expectRevert(KeylessVault.NoDeferredClaim.selector);
        vault.claimDeferred(0, alice);
        vm.prank(bob);
        assertEq(vault.claimDeferred(0, bob), 60e8);
        assertEq(stockB.balanceOf(bob), 80e8);
    }

    function test_audit_oldClaimsStaySeparateFromTransferredRemainingShares() public {
        uint256 shares = _mint(alice, 1);
        stockA.setFrozen(true);
        vm.startPrank(alice);
        vault.redeem(shares / 2, alice);
        themeToken.transfer(bob, themeToken.balanceOf(alice));
        vm.stopPrank();
        _exit(bob);
        assertEq(vault.deferredBalance(alice, 0), 30e8);
        assertEq(vault.deferredBalance(bob, 0), 30e8);
        stockA.setFrozen(false);
        vm.prank(bob);
        assertEq(vault.claimDeferred(0, bob), 30e8);
        vm.prank(alice);
        assertEq(vault.claimDeferred(0, alice), 30e8);
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    function test_audit_falseReturnRollsBackPaymentAndPreservesClaim() public {
        uint256 shares = _mint(alice, 1);
        bytes memory original = address(stockA).code;
        FalseReturnAuditStock broken = new FalseReturnAuditStock();
        vm.etch(address(stockA), address(broken).code);
        vm.prank(alice);
        vault.redeem(shares, alice);
        assertEq(stockA.balanceOf(alice), 0);
        assertEq(stockA.balanceOf(address(vault)), 60e8);
        assertEq(stockB.balanceOf(alice), 80e8);
        assertEq(vault.deferredBalance(alice, 0), 60e8);
        vm.etch(address(stockA), original);
        vm.prank(alice);
        assertEq(vault.claimDeferred(0, alice), 60e8);
        assertEq(stockA.balanceOf(alice), 60e8);
    }

    function test_audit_fractionalActiveBackingCannotOverissueShares() public {
        stockA = new MockStock("Integer A", "INTA", 0);
        stockB = new MockStock("Integer B", "INTB", 0);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        themeToken = new ThemeToken("Integer Theme", "INT", 18, predicted);
        vault = new KeylessVault(_policy());
        uint256 initial = _mintNativeBasket(alice);
        // Retain 3%: active backing is 1.8 A and 2.4 B, not the rounded
        // activeBalance values 1 and 2. Both failed exits retain their units.
        stockA.setFrozen(true);
        stockB.setFrozen(true);
        vm.prank(alice);
        vault.redeem(initial * 97 / 100, alice);
        assertEq(vault.activeBalance(0), 1);
        assertEq(vault.activeBalance(1), 2);
        stockA.setFrozen(false);
        stockB.setFrozen(false);
        uint256 minted = _mintNativeBasket(bob);
        assertLe(minted, initial * (10_000 - BAND_BPS) / 10_000);
        assertEq(vault.deferredBalance(alice, 0), 58);
        assertEq(vault.deferredBalance(alice, 1), 77);
    }

    function _mintNativeBasket(address owner) private returns (uint256) {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 60;
        amounts[1] = 80;
        stockA.mint(owner, amounts[0]);
        stockB.mint(owner, amounts[1]);
        vm.startPrank(owner);
        stockA.approve(address(vault), amounts[0]);
        stockB.approve(address(vault), amounts[1]);
        uint256 shares = vault.mint(amounts, owner, 0);
        vm.stopPrank();
        return shares;
    }

    function test_audit_tokenCallbackCannotReenterExit() public {
        uint256 shares = _mint(alice, 1);
        ReentrantAuditStock attack = new ReentrantAuditStock();
        vm.etch(address(stockA), address(attack).code);
        vm.prank(alice);
        themeToken.transfer(address(stockA), shares / 10);
        ReentrantAuditStock(address(stockA)).setAttack(address(vault), shares / 10);
        _mint(bob, 1);
        assertFalse(ReentrantAuditStock(address(stockA)).reentrySucceeded());
        assertEq(themeToken.balanceOf(address(stockA)), shares / 10);
    }

    function test_audit_gasBombCannotBrickOtherAssets() public {
        uint256 shares = _mint(alice, 1);
        GasBurningBalance bomb = new GasBurningBalance();
        vm.etch(address(stockA), address(bomb).code);
        vm.prank(alice);
        (bool ok,) =
            address(vault).call{ gas: 1_200_000 }(abi.encodeCall(vault.redeem, (shares, alice)));
        assertTrue(ok);
        assertEq(stockB.balanceOf(alice), 80e8);
        assertGt(IDeferredExit(address(vault)).deferredUnits(alice, 0), 0);
    }

    function test_audit_routedExitCannotStrandUsdgInShareToken() public {
        uint256 shares = _mint(alice, 1);
        vm.startPrank(alice);
        vm.expectRevert(KeylessVault.BadRecipient.selector);
        vault.redeemToUsdg(shares, address(venue), address(themeToken), 1);
        vm.expectRevert(KeylessVault.BadRecipient.selector);
        vault.redeemToUsdgUntil(shares, address(venue), address(themeToken), 1, block.timestamp + 1);
        vm.stopPrank();
        assertEq(themeToken.balanceOf(alice), shares);
    }

    function test_audit_donationCannotForceMaterialShareRounding() public {
        _mint(alice, 1);
        stockA.mint(address(vault), 60e30);
        stockB.mint(address(vault), 80e30);
        uint256[] memory amounts = _basket(1);
        stockA.mint(bob, amounts[0]);
        stockB.mint(bob, amounts[1]);
        vm.startPrank(bob);
        stockA.approve(address(vault), amounts[0]);
        stockB.approve(address(vault), amounts[1]);
        vm.expectRevert();
        vault.mint(amounts, bob, 0);
        vm.stopPrank();
        assertEq(stockA.balanceOf(bob), amounts[0]);
        assertEq(stockB.balanceOf(bob), amounts[1]);
    }

    function testFuzz_audit_deferredClaimsSurviveMixedUsers(uint256 a, uint256 b, uint256 c)
        public
    {
        a = bound(a, 1, 1e6);
        b = bound(b, 1, 1e6);
        c = bound(c, 1, 1e6);
        _mint(alice, a);
        _mint(bob, b);
        stockA.setFrozen(true);
        _exit(alice);
        uint256 claim = IDeferredExit(address(vault)).deferredBalance(alice, 0);
        stockA.setFrozen(false);
        _mint(keeper, c);
        _exit(bob);
        _exit(keeper);
        vm.prank(alice);
        uint256 paid = IDeferredExit(address(vault)).claimDeferred(0, alice);
        assertApproxEqAbs(paid, claim, 2);
        assertEq(
            stockA.balanceOf(alice) + stockA.balanceOf(bob) + stockA.balanceOf(keeper),
            (a + b + c) * 60e8
        );
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    function _exit(address owner) internal {
        uint256 shares = themeToken.balanceOf(owner);
        vm.prank(owner);
        vault.redeem(shares, owner);
    }

    function test_audit_newDepositsCannotAcquireDeferredAssets() public {
        _mint(alice, 1);
        _mint(bob, 1);
        stockA.setFrozen(true);
        _exit(alice);
        uint256 claim = IDeferredExit(address(vault)).deferredBalance(alice, 0);
        stockA.setFrozen(false);
        _mint(keeper, 3);
        assertApproxEqAbs(IDeferredExit(address(vault)).deferredBalance(alice, 0), claim, 1);
        _exit(bob);
        _exit(keeper);
        vm.prank(alice);
        uint256 paid = IDeferredExit(address(vault)).claimDeferred(0, alice);
        assertApproxEqAbs(paid, claim, 1);
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    function test_audit_restartEmptyVaultPreservesOldClaims() public {
        _mint(alice, 1);
        stockA.setFrozen(true);
        _exit(alice);
        stockA.setFrozen(false);
        _mint(bob, 1);
        _exit(bob);
        vm.prank(alice);
        uint256 paid = IDeferredExit(address(vault)).claimDeferred(0, alice);
        assertEq(paid, 60e8);
    }

    function test_audit_balanceReadFailureDoesNotEraseOwnership() public {
        _mint(alice, 1);
        vm.mockCallRevert(
            address(stockA), abi.encodeWithSignature("balanceOf(address)", address(vault)), "BROKEN"
        );
        _exit(alice);
        assertGt(IDeferredExit(address(vault)).deferredUnits(alice, 0), 0);
        assertEq(stockB.balanceOf(alice), 80e8);
        vm.clearMockedCalls();
        vm.prank(alice);
        assertEq(IDeferredExit(address(vault)).claimDeferred(0, alice), 60e8);
    }

    function test_audit_issuerBurnIsSharedProportionallyWithDeferredClaims() public {
        _mint(alice, 1);
        _mint(bob, 1);
        stockA.setFrozen(true);
        _exit(alice);
        uint256 entitlement = IDeferredExit(address(vault)).deferredBalance(alice, 0);
        stockA.setFrozen(false);
        stockA.adminBurn(address(vault), 60e8);
        uint256 reduced = IDeferredExit(address(vault)).deferredBalance(alice, 0);
        assertApproxEqAbs(reduced, entitlement / 2, 1);
        vm.prank(alice);
        uint256 paid = IDeferredExit(address(vault)).claimDeferred(0, alice);
        assertEq(paid, reduced);
        _exit(bob);
        assertEq(stockA.balanceOf(alice) + stockA.balanceOf(bob), 60e8);
    }

    function test_audit_deferredClaimCannotBeStolenOrSpentByRoutedExit() public {
        _mint(alice, 1);
        _mint(bob, 1);
        stockA.setFrozen(true);
        _exit(alice);
        stockA.setFrozen(false);
        uint256 entitlement = IDeferredExit(address(vault)).deferredBalance(alice, 0);
        vm.prank(bob);
        vm.expectRevert();
        IDeferredExit(address(vault)).claimDeferred(0, bob);
        uint256 shares = themeToken.balanceOf(bob);
        vm.prank(bob);
        vault.redeemToUsdg(shares, address(venue), bob, 1);
        vm.prank(alice);
        uint256 paid = IDeferredExit(address(vault)).claimDeferred(0, alice);
        assertApproxEqAbs(paid, entitlement, 1);
    }

    function test_audit_navIndicativeSurvivesBrokenMetadata() public {
        _mint(alice, 1);
        vm.mockCallRevert(address(stockA), abi.encodeWithSignature("uiMultiplier()"), "BROKEN");
        (uint256 value, bool stale) = vault.navIndicative();
        assertTrue(stale);
        assertGt(value, 0);
    }

    function test_audit_futureOracleTimestampRejected() public {
        _mint(alice, 1);
        feedA.set(100e8, block.timestamp + 1 days);
        vm.expectRevert();
        vault.navValue();
    }

    function test_audit_failedExitPreservesClaimAfterOtherHolderLeaves() public {
        _mint(alice, 1);
        _mint(bob, 1);
        uint256 entitlement = stockA.balanceOf(address(vault)) * themeToken.balanceOf(alice)
            / themeToken.totalSupply();
        stockA.setFrozen(true);
        uint256 aliceShares = themeToken.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice);
        stockA.setFrozen(false);
        uint256 bobShares = themeToken.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob);
        vm.prank(alice);
        uint256 paid = IDeferredExit(address(vault)).claimDeferred(0, alice);
        assertApproxEqAbs(paid, entitlement, 1);
        assertEq(themeToken.totalSupply(), 0);
        vm.prank(alice);
        vm.expectRevert();
        IDeferredExit(address(vault)).claimDeferred(0, alice);
    }

    function test_audit_cannotBurnClaimWithZeroRoundedPayout() public {
        _mint(alice, 1);
        uint256 beforeShares = themeToken.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(1, alice);
        assertEq(themeToken.balanceOf(alice), beforeShares - 1);
        assertGt(IDeferredExit(address(vault)).deferredUnits(alice, 0), 0);
    }

    function test_audit_mintCannotDiluteAnyExistingConstituent() public {
        _mint(alice, 1);
        // Different market prices make the target basket differ from the held
        // basket. An oracle-valued entry must not dilute either asset claim.
        feedA.set(200e8, block.timestamp);
        uint256 supply = themeToken.totalSupply();
        uint256 beforeA = stockA.balanceOf(address(vault));
        uint256 beforeB = stockB.balanceOf(address(vault));
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 30e8;
        amounts[1] = 80e8;
        stockA.mint(bob, amounts[0]);
        stockB.mint(bob, amounts[1]);
        vm.startPrank(bob);
        stockA.approve(address(vault), amounts[0]);
        stockB.approve(address(vault), amounts[1]);
        vault.mint(amounts, bob, 1);
        vm.stopPrank();
        assertGe(stockA.balanceOf(address(vault)) * supply / themeToken.totalSupply(), beforeA);
        assertGe(stockB.balanceOf(address(vault)) * supply / themeToken.totalSupply(), beforeB);
    }

    function test_audit_constructorRejectsUnmintableBand() public {
        KeylessVault.ThemePolicy memory p = _policy();
        p.mintRedeemBandBps = 10_000;
        vm.expectRevert();
        new KeylessVault(p);
    }

    function test_audit_sharesCannotBeMintedToTheirVault() public {
        uint256[] memory amounts = _basket(1);
        stockA.mint(alice, amounts[0]);
        stockB.mint(alice, amounts[1]);
        vm.startPrank(alice);
        stockA.approve(address(vault), amounts[0]);
        stockB.approve(address(vault), amounts[1]);
        vm.expectRevert();
        vault.mint(amounts, address(vault), 1);
        vm.stopPrank();
    }
}
