// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ThemeFactory } from "../src/ThemeFactory.sol";
import {
    LocalAggregator,
    LocalERC20,
    LocalMulticall3,
    LocalStock,
    LocalVenue
} from "./local/LocalMocks.sol";
import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { console2 } from "forge-std/console2.sol";

/**
 * @title DeployLocal
 * @notice Stands up the whole C2 contract set on a local Anvil node.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 * `DeployFactory.s.sol` targets RHC testnet 46630 and needs three things that
 * do not exist yet: a funded deployer key, a settlement token on that chain,
 * and a swap venue allowlist. `contracts/deployments/46630.json` records
 * all three as null on purpose, because the vault is immutable and has no
 * rescue function, so a guessed address is permanent.
 *
 * A local chain has no such problem. Nothing here has value, so the settlement
 * token and the venue can simply be deployed, and the constituents and feeds
 * can be placed at the addresses the api already encodes.
 *
 * ── The address mirroring ─────────────────────────────────────────────────
 * `themeRouter.deployParams` encodes constituent and feed addresses read from
 * `universe`, which is **mainnet 4663** data, into a call it sends to chain
 * 46630. On a real testnet that is an open design gap. Here it is solved by
 * putting the code where the calldata already points: `anvil_setCode` at each
 * mainnet address, then one `init` call to give it state.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * The `anvil_setCode` probe below is the guard. It is not a convenience: no
 * real node implements that method, so a run pointed at RHC testnet or mainnet
 * by mistake fails on the first call instead of broadcasting anything. The
 * chain id check is a second, weaker fence (Anvil is expected to run with
 * `--chain-id 46630` so the api and the wallet need no special casing).
 *
 *   forge script script/DeployLocal.s.sol \
 *     --rpc-url http://anvil:8545 --broadcast --unlocked --sender <anvil acct 0>
 */
contract DeployLocal is Script {
    using stdJson for string;

    uint256 internal constant RHC_MAINNET = 4663;

    /// Canonical Multicall3, the address every batched read in the api is pinned to.
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    /**
     * @dev Read as parallel arrays through stdJson's typed accessors rather
     *      than `abi.decode` into a struct array.
     *
     *      Struct decoding depends on JSON keys sorting to the same order as
     *      the struct fields AND on every value coercing to the right width. It
     *      fails silently when either slips: an earlier pass of this script
     *      decoded a uiMultiplier of 448 and a feed answer of 320 out of
     *      correct input, then reverted outright once the integers moved to hex
     *      strings. Typed arrays have neither failure mode.
     */
    struct Constituents {
        address[] tokens;
        address[] feeds;
        uint256[] decimals;
        uint256[] feedDecimals;
        string[] names;
        string[] symbols;
        uint256[] priceAnswers;
        uint256[] uiMultipliers;
    }

    // Held in storage rather than threaded through the mirroring loop: the two
    // bytecode blobs plus the venue and the deployer made the pre-IR script
    // overflow the stack as locals. Keep this layout in the shared IR profile.
    bytes internal stockCode;
    bytes internal feedCode;
    LocalVenue internal venue;
    address internal deployer;

    function run() external {
        require(
            keccak256(bytes(vm.envString("LOCAL_CHAIN_MODE"))) == keccak256("mock"),
            "Explicit mock mode required"
        );
        require(
            block.chainid != RHC_MAINNET,
            "DeployLocal: RHC mainnet (4663) is never a deploy target (locked decision 5)."
        );
        _assertAnvil();

        deployer = msg.sender;
        string memory root = vm.projectRoot();
        string memory raw = vm.readFile(string.concat(root, "/script/local/constituents.json"));

        Constituents memory items = Constituents({
            tokens: raw.readAddressArray(".tokens"),
            feeds: raw.readAddressArray(".feeds"),
            decimals: raw.readUintArray(".decimals"),
            feedDecimals: raw.readUintArray(".feedDecimals"),
            names: raw.readStringArray(".names"),
            symbols: raw.readStringArray(".symbols"),
            priceAnswers: raw.readUintArray(".priceAnswers"),
            uiMultipliers: raw.readUintArray(".uiMultipliers")
        });
        uint256 count = items.tokens.length;
        require(count > 0, "DeployLocal: constituents.json is empty");
        require(
            items.feeds.length == count && items.decimals.length == count
                && items.feedDecimals.length == count && items.names.length == count
                && items.symbols.length == count && items.priceAnswers.length == count
                && items.uiMultipliers.length == count,
            "DeployLocal: constituents.json arrays are ragged"
        );

        // Templates. Deployed normally, then copied to the addresses the api
        // will name. Their own addresses are throwaway.
        vm.startBroadcast();
        LocalStock stockTemplate = new LocalStock();
        LocalAggregator feedTemplate = new LocalAggregator();
        LocalMulticall3 multicallTemplate = new LocalMulticall3();

        LocalERC20 usdg = new LocalERC20();
        usdg.init("Local USDG", "USDG", 6);

        venue = new LocalVenue();
        venue.setPrice(address(usdg), 1e18);

        ThemeFactory factory = new ThemeFactory(deployer);
        vm.stopBroadcast();

        stockCode = address(stockTemplate).code;
        feedCode = address(feedTemplate).code;

        // Before the constituents: with nothing at the canonical Multicall3
        // address every batched read in the api fails as a group, which reads
        // as a dead NAV rather than a missing contract.
        _setCode(MULTICALL3, address(multicallTemplate).code);

        for (uint256 i; i < count; ++i) {
            _placeConstituent(items, i);
        }

        console2.log("");
        console2.log("=== Cortex local chain ===");
        console2.log("chain id            :", block.chainid);
        console2.log("ThemeFactory        :", address(factory));
        console2.log("USDG                :", address(usdg));
        console2.log("SwapVenue      :", address(venue));
        console2.log("protocol fee sink   :", deployer);
        console2.log("constituents mirrored:", count);
    }

    /// @dev Places one constituent and its feed at their mainnet addresses.
    function _placeConstituent(Constituents memory c, uint256 i) private {
        address token = c.tokens[i];
        address feed = c.feeds[i];
        _setCode(token, stockCode);
        _setCode(feed, feedCode);

        vm.startBroadcast();
        LocalStock(token)
            .initStock(c.names[i], c.symbols[i], uint8(c.decimals[i]), c.uiMultipliers[i]);
        LocalAggregator(feed)
            .init(uint8(c.feedDecimals[i]), int256(c.priceAnswers[i]), block.timestamp);

        // Price the venue in USD 1e18 per whole token, from the same answer the
        // feed reports, so a routed leg and an on-chain NAV agree by
        // construction rather than by coincidence.
        venue.setPrice(token, (c.priceAnswers[i] * 1e18) / (10 ** c.feedDecimals[i]));

        // A working float, so mint and redeem have something to move.
        LocalStock(token).mint(deployer, 1_000_000 * (10 ** c.decimals[i]));
        vm.stopBroadcast();
    }

    /**
     * @dev Places runtime bytecode at `target` on BOTH the node and the local
     *      script EVM.
     *
     *      `anvil_setCode` changes the node. `vm.etch` changes the in-process
     *      state the script body runs against. Both are needed and neither is
     *      redundant: without the rpc the node never gets the code and the
     *      broadcast `init` call reverts on chain, and without the etch the
     *      script's own next line reverts with "call to non-contract address"
     *      before any transaction is ever built. `--skip-simulation` does not
     *      help, because that skips the on-chain simulation and not the script
     *      execution that produces the transaction list.
     */
    function _setCode(address target, bytes memory code) private {
        vm.rpc(
            "anvil_setCode",
            string.concat("[\"", vm.toString(target), "\",\"", vm.toString(code), "\"]")
        );
        vm.etch(target, code);
    }

    /// @dev Fails closed against any node that is not Anvil. `anvil_setCode` on
    ///      a real RPC is an unknown method, so this reverts before broadcast.
    function _assertAnvil() private {
        try vm.rpc("anvil_nodeInfo", "[]") returns (bytes memory) { }
        catch {
            revert(
                "DeployLocal: the RPC did not answer anvil_nodeInfo, so it is not a local Anvil node. This script only ever runs against Anvil."
            );
        }
    }
}
