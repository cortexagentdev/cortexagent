// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DeployFactory } from "../script/DeployFactory.s.sol";
import { DeployTheme } from "../script/DeployTheme.s.sol";
import { FeeController } from "../src/FeeController.sol";
import { KeylessVault } from "../src/KeylessVault.sol";
import { ThemeFactory } from "../src/ThemeFactory.sol";
import { ThemeToken } from "../src/ThemeToken.sol";
import { MockAggregator, MockERC20, MockStock, MockVenue } from "./mocks/Mocks.sol";
import { Test, Vm } from "forge-std/Test.sol";

contract ThemeFactoryTest is Test {
    ThemeFactory internal factory;

    MockERC20 internal usdg;
    MockStock internal stockA;
    MockStock internal stockB;
    MockAggregator internal feedA;
    MockAggregator internal feedB;
    MockVenue internal venue;

    address internal protocolSink = makeAddr("protocolSink");
    address internal creator = address(this);
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.chainId(46_630);

        usdg = new MockERC20("USDG", "USDG", 6);
        stockA = new MockStock("Stock A", "AAA", 8);
        stockB = new MockStock("Stock B", "BBB", 8);
        feedA = new MockAggregator(8, 100e8, block.timestamp);
        feedB = new MockAggregator(8, 50e8, block.timestamp);
        venue = new MockVenue();

        factory = new ThemeFactory(protocolSink);
    }

    function _params() internal view returns (ThemeFactory.ThemeParams memory p) {
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

        p = ThemeFactory.ThemeParams({
            slug: "ai-infrastructure",
            name: "Cortex AI Infrastructure",
            symbol: "ctxAIINFRA",
            decimals: 18,
            creator: creator,
            usdg: address(usdg),
            constituents: c,
            feeds: f,
            targetWeightsBps: w,
            capsBps: caps,
            creatorFeeBps: 20,
            mintRedeemBandBps: 80,
            slippageCapBps: 100,
            maxRedeemUsd: 1_000_000e18,
            allowedVenues: venues
        });
    }

    // ─────────────────── one call, wired ────────────────────────────────

    function test_deployTheme_wiresTokenVaultFeeController() public {
        (ThemeToken token, KeylessVault vault, FeeController fc) = factory.deployTheme(_params());

        // token <-> vault cycle resolved, both point at each other
        assertEq(token.vault(), address(vault), "token.vault == vault");
        assertEq(address(vault.themeToken()), address(token), "vault.themeToken == token");

        // token metadata
        assertEq(token.name(), "Cortex AI Infrastructure");
        assertEq(token.symbol(), "ctxAIINFRA");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0);

        // vault policy
        assertEq(vault.usdg(), address(usdg));
        assertEq(vault.creator(), creator);
        assertEq(vault.creatorFeeBps(), 20);
        assertEq(vault.mintRedeemBandBps(), 80);
        assertEq(vault.constituentCount(), 2);
        assertTrue(vault.isAllowedVenue(address(venue)));

        // fee controller
        assertEq(address(fc.themeToken()), address(token));
        assertEq(fc.creator(), creator);
        assertEq(fc.protocol(), protocolSink);
        assertEq(fc.creatorFeeBps(), 20);

        assertEq(factory.deployedCount(), 1);
        assertEq(factory.deployedVaults(0), address(vault));
    }

    function test_deployTheme_predictionMatchesAcrossManyThemes() public {
        for (uint256 i; i < 4; ++i) {
            address predicted = factory.predictedNextVault();
            (, KeylessVault vault,) = factory.deployTheme(_params());
            assertEq(address(vault), predicted, "vault landed at the predicted address");
        }
        assertEq(factory.deployedCount(), 4);
    }

    function test_deployedTheme_isFunctional() public {
        (ThemeToken token, KeylessVault vault,) = factory.deployTheme(_params());

        uint256[] memory amt = new uint256[](2);
        amt[0] = 60e8; // $6000 A
        amt[1] = 80e8; // $4000 B
        stockA.mint(alice, amt[0]);
        stockB.mint(alice, amt[1]);

        vm.startPrank(alice);
        stockA.approve(address(vault), amt[0]);
        stockB.approve(address(vault), amt[1]);
        uint256 shares = vault.mint(amt, alice, 0);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(token.balanceOf(alice), shares);
        assertEq(vault.navValue(), 10_000e18);
    }

    // ─────────────────── the emitted event ─────────────────────────────

    function test_deployTheme_emitsThemeDeployedWithRequiredFields() public {
        vm.recordLogs();
        (ThemeToken token, KeylessVault vault, FeeController fc) = factory.deployTheme(_params());

        Vm.Log memory e = _find(
            keccak256(
                "ThemeDeployed(bytes32,address,address,string,address,address,address,uint256,uint256)"
            )
        );

        assertTrue(e.topics[1] != bytes32(0), "policyHash set");
        assertEq(address(uint160(uint256(e.topics[2]))), creator, "creator");
        assertEq(address(uint160(uint256(e.topics[3]))), address(token), "themeToken");

        (string memory slug, address vaultAddr, address fcAddr, address usdgAddr) =
            abi.decode(e.data, (string, address, address, address));
        assertEq(slug, "ai-infrastructure");
        assertEq(vaultAddr, address(vault));
        assertEq(fcAddr, address(fc));
        assertEq(usdgAddr, address(usdg));
    }

    function test_deployTheme_emitsThemeCompositionBasket() public {
        vm.recordLogs();
        (ThemeToken token,,) = factory.deployTheme(_params());

        Vm.Log memory e = _find(
            keccak256("ThemeComposition(bytes32,address,address[],address[],uint256[],uint256[])")
        );

        assertEq(address(uint160(uint256(e.topics[2]))), address(token), "themeToken topic");
        (
            address[] memory constituents,
            address[] memory feeds,
            uint256[] memory weights,
            uint256[] memory caps
        ) = abi.decode(e.data, (address[], address[], uint256[], uint256[]));
        assertEq(constituents.length, 2);
        assertEq(constituents[0], address(stockA));
        assertEq(feeds[1], address(feedB));
        assertEq(weights[0], 6000);
        assertEq(weights[1], 4000);
        assertEq(caps[0], 8000);
    }

    function _find(bytes32 sig) internal view returns (Vm.Log memory) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) return logs[i];
        }
        revert("event not found");
    }

    // ─────────────────── policy rejected BEFORE deployment ─────────────

    function test_rejectsFeedlessConstituent_beforeDeploy() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.feeds[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(ThemeFactory.ConstituentHasNoFeed.selector, 1));
        factory.deployTheme(p);
        assertEq(factory.deployedCount(), 0, "nothing deployed");
    }

    function test_rejectsNoCodeFeedAddress_beforeDeploy() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.feeds[0] = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(ThemeFactory.FeedNotResponding.selector, 0));
        factory.deployTheme(p);
    }

    function test_rejectsWeightsNotSummingTo100_beforeDeploy() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.targetWeightsBps[0] = 5999;
        vm.expectRevert(abi.encodeWithSelector(ThemeFactory.WeightsMustSumToBps.selector, 9999));
        factory.deployTheme(p);
        assertEq(factory.deployedCount(), 0);
    }

    function test_rejectsFeeAboveCap_beforeDeploy() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.creatorFeeBps = 101;
        vm.expectRevert(ThemeFactory.FeeAboveCap.selector);
        factory.deployTheme(p);
    }

    function test_rejectsMintRedeemBandNotAboveHalfPercentPlusFee() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.creatorFeeBps = 20;
        p.mintRedeemBandBps = 70; // == 50 + 20, must strictly exceed
        vm.expectRevert(ThemeFactory.MintRedeemBandTooTight.selector);
        factory.deployTheme(p);
    }

    function test_rejectsLengthMismatch() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.feeds = new address[](1);
        p.feeds[0] = address(feedA);
        vm.expectRevert(ThemeFactory.LengthMismatch.selector);
        factory.deployTheme(p);
    }

    function test_rejectsNoVenues() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.allowedVenues = new address[](0);
        vm.expectRevert(ThemeFactory.NoVenues.selector);
        factory.deployTheme(p);
    }

    function test_constructor_rejectsZeroProtocolSink() public {
        vm.expectRevert(ThemeFactory.ZeroProtocolFeeSink.selector);
        new ThemeFactory(address(0));
    }

    // ─────────────────── factory holds NO authority ───────────────────

    function test_factoryHoldsNoAuthorityOverDeployedContracts() public {
        (ThemeToken token, KeylessVault vault, FeeController fc) = factory.deployTheme(_params());

        // the factory is not the minter/burner
        assertTrue(token.vault() != address(factory));
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, address(factory)));
        token.mint(alice, 1e18);

        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(ThemeToken.NotVault.selector, address(factory)));
        token.burn(alice, 1e18);

        // the factory is nobody special to the vault: it holds no shares, so a
        // redeem from it reverts exactly as it would for any other stranger
        vm.prank(address(factory));
        vm.expectRevert();
        vault.redeem(1e18, address(factory));

        // fee-controller destinations are the creator and the protocol sink,
        // never the factory
        assertTrue(fc.creator() != address(factory));
        assertTrue(fc.protocol() != address(factory));

        // no field on any of the three can be pointed back at the factory later:
        // there are no setters. Source-level assertion.
        string memory vaultSrc = vm.readFile("src/KeylessVault.sol");
        string memory tokenSrc = vm.readFile("src/ThemeToken.sol");
        assertFalse(_contains(vaultSrc, "onlyOwner"));
        assertFalse(_contains(tokenSrc, "onlyOwner"));
    }

    function test_factorySource_hasNoAuthoritySurface() public view {
        string memory src = vm.readFile("src/ThemeFactory.sol");
        string[6] memory forbidden = [
            "onlyOwner", "Ownable", "selfdestruct", "delegatecall", "function upgrade", " setPolicy"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            assertFalse(_contains(src, forbidden[i]), forbidden[i]);
        }
    }

    function test_audit_creatorCannotBeImpersonated() public {
        ThemeFactory.ThemeParams memory p = _params();
        p.creator = makeAddr("victim");
        vm.expectRevert(ThemeFactory.CreatorMustBeCaller.selector);
        factory.deployTheme(p);
    }

    // ─────────────────── deploy scripts bind the chosen chain ───────────

    function test_deployFactoryScript_rejectsChainMismatch() public {
        vm.chainId(4663);
        vm.setEnv("EXECUTION_CHAIN_ID", "46630");
        DeployFactory s = new DeployFactory();
        vm.expectRevert(bytes("Execution chain mismatch"));
        s.run();
    }

    function test_deployThemeScript_rejectsChainMismatch() public {
        vm.chainId(4663);
        vm.setEnv("EXECUTION_CHAIN_ID", "46630");
        DeployTheme s = new DeployTheme();
        vm.expectRevert(bytes("Execution chain mismatch"));
        s.run();
    }

    // ─────────────────── helpers ──────────────────────────────────────

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
