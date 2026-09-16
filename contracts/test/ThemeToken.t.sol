// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ThemeToken } from "../src/ThemeToken.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Test } from "forge-std/Test.sol";

contract ThemeTokenTest is Test {
    ThemeToken internal token;

    address internal vault = makeAddr("vault");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new ThemeToken("Cortex AI Infrastructure", "ctxAIINFRA", 18, vault);
    }

    // --- construction ------------------------------------------------------

    function test_constructor_setsMetadataAndVault() public view {
        assertEq(token.name(), "Cortex AI Infrastructure");
        assertEq(token.symbol(), "ctxAIINFRA");
        assertEq(token.decimals(), 18);
        assertEq(token.vault(), vault);
        assertEq(token.totalSupply(), 0);
    }

    function test_constructor_customDecimals() public {
        ThemeToken t = new ThemeToken("Six", "SIX", 6, vault);
        assertEq(t.decimals(), 6);
    }

    function test_constructor_revertsOnZeroVault() public {
        vm.expectRevert(ThemeToken.ZeroVault.selector);
        new ThemeToken("Bad", "BAD", 18, address(0));
    }

    // --- mint / burn are vault-only --------------------------------------

    function test_mint_onlyVault() public {
        vm.prank(vault);
        token.mint(alice, 1_000e18);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(token.totalSupply(), 1_000e18);
    }

    function test_burn_onlyVault() public {
        vm.prank(vault);
        token.mint(alice, 1_000e18);

        vm.prank(vault);
        token.burn(alice, 400e18);
        assertEq(token.balanceOf(alice), 600e18);
        assertEq(token.totalSupply(), 600e18);
    }

    function test_mint_revertsForNonVault() public {
        // a random user, the test contract, and the token itself
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, alice));
        token.mint(alice, 1e18);

        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, address(this)));
        token.mint(alice, 1e18);

        vm.prank(address(token));
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, address(token)));
        token.mint(alice, 1e18);
    }

    function test_burn_revertsForNonVault() public {
        vm.prank(vault);
        token.mint(alice, 1_000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, alice));
        token.burn(alice, 1e18);

        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, address(this)));
        token.burn(alice, 1e18);
    }

    function testFuzz_mint_revertsForAnyNonVault(address caller) public {
        vm.assume(caller != vault);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, caller));
        token.mint(caller, 1e18);
    }

    function testFuzz_burn_revertsForAnyNonVault(address caller) public {
        vm.assume(caller != vault && caller != address(0) && caller != address(token));
        vm.prank(vault);
        token.mint(caller, 5e18);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, caller));
        token.burn(caller, 1e18);
    }

    // --- total supply moves ONLY through vault mint / burn ---------------

    function test_totalSupply_unchangedByTransfers() public {
        vm.prank(vault);
        token.mint(alice, 1_000e18);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(bob, 250e18);

        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(bob), 250e18);
    }

    function testFuzz_transferFrom_withoutApprovalCannotStealShares(uint256 shares) public {
        shares = bound(shares, 1, 1e30);
        vm.prank(vault);
        token.mint(alice, shares);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, shares)
        );
        token.transferFrom(alice, bob, shares);

        assertEq(token.balanceOf(alice), shares);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.totalSupply(), shares);
    }

    function test_transferFrom_cannotExceedOrReuseSpentAllowance() public {
        vm.prank(vault);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, 10e18);

        vm.startPrank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, bob, 10e18, 10e18 + 1
            )
        );
        token.transferFrom(alice, bob, 10e18 + 1);
        token.transferFrom(alice, bob, 10e18);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1)
        );
        token.transferFrom(alice, bob, 1);
        vm.stopPrank();

        assertEq(token.allowance(alice, bob), 0);
        assertEq(token.balanceOf(alice), 90e18);
        assertEq(token.balanceOf(bob), 10e18);
        assertEq(token.totalSupply(), 100e18);
    }

    function test_transferFrom_revokedApprovalCannotBeUsed() public {
        vm.prank(vault);
        token.mint(alice, 100e18);
        vm.startPrank(alice);
        token.approve(bob, type(uint256).max);
        token.approve(bob, 0);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1)
        );
        token.transferFrom(alice, bob, 1);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_totalSupply_hasNoOtherMutator() public {
        // The only external entrypoints that touch supply are mint and burn,
        // both onlyVault. ERC20 exposes no public _mint/_burn, and this contract
        // adds no other. Exhaustive walk of the mutating surface:
        vm.startPrank(vault);
        token.mint(alice, 100e18);
        assertEq(token.totalSupply(), 100e18);
        token.burn(alice, 100e18);
        assertEq(token.totalSupply(), 0);
        vm.stopPrank();

        // approve / transfer / transferFrom never move supply
        vm.prank(vault);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, 100e18);
        vm.prank(bob);
        token.transferFrom(alice, bob, 100e18);
        assertEq(token.totalSupply(), 100e18);
    }

    // --- the vault address cannot change after construction --------------

    /**
     * Grep the contract source and assert it. Acceptance criterion: "There is no
     * function that changes the vault address after construction."
     *
     * `vault` is declared `immutable`, so the compiler already forbids any
     * post-construction write. This test is the belt to that suspenders: it
     * reads the shipped source and fails if a setter is ever added.
     */
    function test_source_hasNoVaultSetter() public view {
        string memory src = vm.readFile("src/ThemeToken.sol");

        assertTrue(_contains(src, "address public immutable vault"), "vault must stay immutable");

        string[5] memory forbidden = [
            "function setVault",
            "function updateVault",
            "function changeVault",
            "function setMinter",
            "function transferVault"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(_contains(src, forbidden[i]), forbidden[i]);
        }

        // `vault` is assigned exactly once, and only as the constructor's
        // `vault = vault_;`. Any second assignment is a post-construction write.
        assertEq(_count(src, "vault = "), 1, "only the constructor may assign vault");
        assertTrue(_contains(src, "vault = vault_;"), "constructor assignment expected");
    }

    function test_vault_stableAcrossOperations() public {
        address v0 = token.vault();
        vm.prank(vault);
        token.mint(alice, 1e18);
        vm.prank(vault);
        token.burn(alice, 1e18);
        assertEq(token.vault(), v0);
    }

    // --- helpers ---------------------------------------------------------

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
