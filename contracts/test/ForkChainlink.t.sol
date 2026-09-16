// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

/// Minimal Chainlink AggregatorV3 surface. The vault (BE-25b) reads exactly
/// these four getters to price a constituent.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/**
 * Proves the `rhc_mainnet` fork endpoint in foundry.toml works and that a real
 * Chainlink equity feed on Robinhood Chain (4663) can be read from a fork. This
 * is the harness BE-25b needs: its NAV math reverts on `answer <= 0`,
 * `updatedAt == 0`, and `block.timestamp - updatedAt > MAX_STALENESS`, and it
 * cannot be tested without a fork against the real feeds.
 *
 * RHC mainnet is READ-ONLY here. Never a deploy target. Locked decision 5.
 *
 * The feed address is Chainlink's "Robinhood GOOGL / USD" proxy from the public
 * `feeds-robinhood-mainnet` reference directory (CortexBackend.md PART 9). If
 * the public RPC is unreachable the fork cannot be created; the test skips
 * rather than fails, so `forge test` stays green offline. CI with network
 * access exercises it for real.
 */
contract ForkChainlinkTest is Test {
    // Chainlink "Robinhood GOOGL / USD" AggregatorV3 proxy on RHC mainnet.
    address internal constant GOOGL_USD_FEED = 0xF6f373a037c30F0e5010d854385cA89185AE638b;

    AggregatorV3Interface internal feed;

    function setUp() public {
        try vm.createSelectFork("rhc_mainnet") {
            feed = AggregatorV3Interface(GOOGL_USD_FEED);
        } catch {
            // RPC endpoint unreachable (offline / CI without network). Leave
            // `feed` unset; every test guards on it and skips.
        }
    }

    modifier onFork() {
        if (address(feed) == address(0)) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_isRhcMainnet() public onFork {
        assertEq(block.chainid, 4663, "fork must be RHC mainnet");
    }

    function test_fork_feedDecimalsAreEight() public onFork {
        // Every observed RHC equity feed reports 8. The vault still calls
        // decimals() and never hardcodes it (CortexBackend.md PART 9).
        assertEq(feed.decimals(), 8);
    }

    function test_fork_latestRoundDataIsSane() public onFork {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt,) =
            feed.latestRoundData();

        assertGt(answer, 0, "answer must be positive");
        assertGt(updatedAt, 0, "round must be complete");
        assertGt(roundId, 0, "roundId must be set");
        assertLe(startedAt, updatedAt, "startedAt precedes updatedAt");

        // Liveness bound the vault will enforce: feed heartbeat (86400s) + grace
        // = 90000s. A LIVENESS check, not an accuracy one. Not tightened to
        // minutes (global do-not 1). A live mainnet feed clears this comfortably.
        assertLe(block.timestamp - updatedAt, 90_000, "feed within heartbeat + grace");
    }
}
