// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { CTX } from "../src/CTX.sol";
import { Test } from "forge-std/Test.sol";

contract CTXTest is Test {
    CTX internal ctx;

    address internal community = makeAddr("community");
    address internal contributors = makeAddr("contributors");
    address internal treasury = makeAddr("treasury");
    address internal liquidity = makeAddr("liquidity");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        ctx = new CTX(community, contributors, treasury, liquidity);
    }

    // --- construction ----------------------------------------------------

    function test_constructor_metadata() public view {
        assertEq(ctx.name(), "Cortex");
        assertEq(ctx.symbol(), "CTX");
        assertEq(ctx.decimals(), 18);
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(CTX.ZeroAddress.selector);
        new CTX(address(0), contributors, treasury, liquidity);

        vm.expectRevert(CTX.ZeroAddress.selector);
        new CTX(community, address(0), treasury, liquidity);

        vm.expectRevert(CTX.ZeroAddress.selector);
        new CTX(community, contributors, address(0), liquidity);

        vm.expectRevert(CTX.ZeroAddress.selector);
        new CTX(community, contributors, treasury, address(0));
    }

    // --- the 80/10/5/5 split -------------------------------------------

    function test_allocation_splitIsExact() public view {
        assertEq(ctx.balanceOf(community), (ctx.TOTAL_SUPPLY() * 80) / 100);
        assertEq(ctx.balanceOf(contributors), (ctx.TOTAL_SUPPLY() * 10) / 100);
        assertEq(ctx.balanceOf(treasury), (ctx.TOTAL_SUPPLY() * 5) / 100);
        assertEq(ctx.balanceOf(liquidity), (ctx.TOTAL_SUPPLY() * 5) / 100);
    }

    function test_allocation_sumsToTotalSupplyWithNoDust() public view {
        uint256 sum = ctx.balanceOf(community) + ctx.balanceOf(contributors)
            + ctx.balanceOf(treasury) + ctx.balanceOf(liquidity);

        assertEq(sum, ctx.TOTAL_SUPPLY());
        assertEq(sum, ctx.totalSupply());
        // no allocation stranded in the contract itself
        assertEq(ctx.balanceOf(address(ctx)), 0);
    }

    function test_allocation_constantsMatchBalances() public view {
        assertEq(ctx.balanceOf(community), ctx.COMMUNITY_ALLOCATION());
        assertEq(ctx.balanceOf(contributors), ctx.CONTRIBUTORS_ALLOCATION());
        assertEq(ctx.balanceOf(treasury), ctx.TREASURY_ALLOCATION());
        assertEq(ctx.balanceOf(liquidity), ctx.LIQUIDITY_ALLOCATION());

        assertEq(
            ctx.COMMUNITY_ALLOCATION() + ctx.CONTRIBUTORS_ALLOCATION() + ctx.TREASURY_ALLOCATION()
                + ctx.LIQUIDITY_ALLOCATION(),
            ctx.TOTAL_SUPPLY()
        );
    }

    // --- total supply is fixed at construction, forever ----------------

    function test_totalSupply_fixedAtConstruction() public view {
        assertEq(ctx.totalSupply(), 1_000_000_000e18);
    }

    function test_totalSupply_unchangedByTransfers() public {
        uint256 before = ctx.totalSupply();

        vm.prank(community);
        ctx.transfer(alice, 1_000e18);
        vm.prank(alice);
        ctx.approve(bob, 500e18);
        vm.prank(bob);
        ctx.transferFrom(alice, bob, 500e18);

        assertEq(ctx.totalSupply(), before);
    }

    // --- no mint function exists post-construction ---------------------

    /**
     * Acceptance criterion: "No `mint` function exists post-construction. Grep
     * and assert in a test." The compiler already guarantees it (there is no
     * such declaration), this reads the shipped source and fails if one is
     * ever added.
     */
    function test_source_hasNoMintOrKeys() public view {
        string memory src = vm.readFile("src/CTX.sol");

        string[10] memory forbidden = [
            "function mint",
            "function _mint(",
            "function burn",
            "function setOwner",
            "function transferOwnership",
            "Ownable",
            "AccessControl",
            "Pausable",
            "function pause",
            "delegatecall"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(_contains(src, forbidden[i]), forbidden[i]);
        }

        // `_mint` is called exactly four times, all inside the constructor.
        assertEq(_count(src, "_mint("), 4, "supply is minted by exactly four constructor calls");
    }

    function test_noPublicMintSelector() public {
        // Any of the usual mint signatures must not be a live function.
        (bool ok,) =
            address(ctx).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1e18));
        assertFalse(ok);
        (ok,) = address(ctx).call(abi.encodeWithSignature("mint(uint256)", 1e18));
        assertFalse(ok);
        (ok,) = address(ctx).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
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
