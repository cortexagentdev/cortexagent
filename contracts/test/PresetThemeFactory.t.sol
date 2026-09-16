// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { FeeController } from "../src/FeeController.sol";
import { KeylessVault } from "../src/KeylessVault.sol";
import { PresetThemeFactory } from "../src/PresetThemeFactory.sol";
import { ThemeFactory } from "../src/ThemeFactory.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { MockAggregator, MockERC20, MockStock, MockVenue } from "./mocks/Mocks.sol";
import { Test } from "forge-std/Test.sol";

contract PresetThemeFactoryTest is Test {
    PresetThemeFactory private factory;
    MockERC20 private usdg;
    MockStock private stock;
    MockAggregator private feed;
    MockVenue private venue;
    address private alice = makeAddr("alice");
    bytes32 private constant CATALOG = keccak256("reviewed-catalog");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdg = new MockERC20("USDG", "USDG", 6);
        stock = new MockStock("Stock", "STOCK", 8);
        feed = new MockAggregator(8, 100e8, block.timestamp);
        venue = new MockVenue();
        factory = new PresetThemeFactory(address(this), address(this), CATALOG, _ids());
    }

    function _ids() private pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = keccak256("one");
        ids[1] = keccak256("two");
    }

    function _params(string memory slug) private view returns (ThemeFactory.ThemeParams memory p) {
        p.slug = slug;
        p.name = "Preset";
        p.symbol = "PRE";
        p.decimals = 18;
        p.creator = address(this);
        p.usdg = address(usdg);
        p.constituents = new address[](1);
        p.constituents[0] = address(stock);
        p.feeds = new address[](1);
        p.feeds[0] = address(feed);
        p.targetWeightsBps = new uint256[](1);
        p.targetWeightsBps[0] = 10_000;
        p.capsBps = new uint256[](1);
        p.capsBps[0] = 10_000;
        p.mintRedeemBandBps = 60;
        p.slippageCapBps = 100;
        p.maxRedeemUsd = 1_000_000e18;
        p.allowedVenues = new address[](1);
        p.allowedVenues[0] = address(venue);
    }

    function test_publicCannotDeployOrConsumeSlotEvenThroughBaseInterface() public {
        ThemeFactory.ThemeParams memory p = _params("one");
        p.creator = alice;
        address predicted = factory.predictedNextVault();
        vm.prank(alice);
        vm.expectRevert(PresetThemeFactory.UnauthorizedDeployer.selector);
        ThemeFactory(address(factory)).deployTheme(p);
        assertEq(factory.deployedCount(), 0);
        assertEq(factory.predictedNextVault(), predicted);
        factory.deployTheme(_params("one"));
    }

    function test_onlyCatalogSlugsAndOneDeploymentPerSlot() public {
        vm.expectRevert(PresetThemeFactory.UnknownPreset.selector);
        factory.deployTheme(_params("custom"));
        (ThemeToken token, KeylessVault vault, FeeController fee) =
            factory.deployTheme(_params("one"));
        (
            address recordedToken,
            address recordedVault,
            address recordedFee,
            bytes32 policyHash,
            uint256 blockNumber
        ) = factory.presets(keccak256("one"));
        assertEq(recordedToken, address(token));
        assertEq(recordedVault, address(vault));
        assertEq(recordedFee, address(fee));
        assertTrue(policyHash != bytes32(0));
        assertEq(blockNumber, block.number);
        vm.expectRevert(PresetThemeFactory.PresetAlreadyDeployed.selector);
        factory.deployTheme(_params("one"));
        assertEq(factory.deployedCount(), 1);
        assertFalse(factory.presetsComplete());
    }

    function test_catalogExhaustionPermanentlyPreventsAdditionalDeployments() public {
        factory.deployTheme(_params("one"));
        factory.deployTheme(_params("two"));
        assertTrue(factory.presetsComplete());
        assertEq(factory.presetCount(), 2);
        assertEq(factory.presetIds(), _ids());
        vm.expectRevert(PresetThemeFactory.PresetAlreadyDeployed.selector);
        factory.deployTheme(_params("two"));
        vm.expectRevert(PresetThemeFactory.UnknownPreset.selector);
        factory.deployTheme(_params("three"));
        assertEq(factory.deployedCount(), 2);
    }

    function test_invalidDeploymentRollsBackReservationAndNonce() public {
        ThemeFactory.ThemeParams memory p = _params("one");
        p.creatorFeeBps = 1;
        address predicted = factory.predictedNextVault();
        vm.expectRevert(PresetThemeFactory.NonzeroCreatorFee.selector);
        factory.deployTheme(p);
        (, KeylessVault vault,) = factory.deployTheme(_params("one"));
        assertEq(address(vault), predicted);
    }

    function test_deployerCannotImpersonateCreator() public {
        ThemeFactory.ThemeParams memory p = _params("one");
        p.creator = alice;
        vm.expectRevert(ThemeFactory.CreatorMustBeCaller.selector);
        factory.deployTheme(p);
        assertEq(factory.deployedCount(), 0);
    }

    function test_creationRestrictionNeverRestrictsHolderDepositsAndExits() public {
        (ThemeToken token, KeylessVault vault,) = factory.deployTheme(_params("one"));
        factory.deployTheme(_params("two"));
        stock.mint(alice, 100e8);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e8;
        vm.startPrank(alice);
        stock.approve(address(vault), type(uint256).max);
        vault.mint(amounts, alice, 0);
        assertGt(token.balanceOf(alice), 0);
        vault.redeem(token.balanceOf(alice), alice);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 0);
        assertEq(stock.balanceOf(alice), 100e8);
    }

    function test_rejectsInvalidCatalogAndDeployer() public {
        vm.expectRevert(PresetThemeFactory.InvalidPresetCatalog.selector);
        new PresetThemeFactory(address(this), address(0), CATALOG, _ids());
        vm.expectRevert(PresetThemeFactory.InvalidPresetCatalog.selector);
        new PresetThemeFactory(address(this), address(this), bytes32(0), _ids());
        bytes32[] memory ids = new bytes32[](0);
        vm.expectRevert(PresetThemeFactory.InvalidPresetCatalog.selector);
        new PresetThemeFactory(address(this), address(this), CATALOG, ids);
        ids = _ids();
        ids[1] = ids[0];
        vm.expectRevert(PresetThemeFactory.InvalidPresetCatalog.selector);
        new PresetThemeFactory(address(this), address(this), CATALOG, ids);
    }
}
