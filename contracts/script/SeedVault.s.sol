// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

interface IVaultReads {
    function constituents() external view returns (address[] memory);
    function feeds() external view returns (address[] memory);
    function targetWeightsBps() external view returns (uint256[] memory);
    function themeToken() external view returns (address);
    function navPerShare() external view returns (uint256);
    function mint(uint256[] calldata amountsIn, address to, uint256 minSharesOut)
        external
        returns (uint256);
}

interface IFeedReads {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface ITokenReads {
    function decimals() external view returns (uint8);
    function uiMultiplier() external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/**
 * @title SeedVault
 * @notice Puts a first deposit into a freshly deployed local vault.
 *
 * A vault with no supply has no NAV: `navPerShare()` reverts with `NoSupply`
 * by design, and `vaultRouter.summary` turns that into "Vault NAV is not
 * available yet", so every vault surface in the terminal stays empty until
 * somebody mints. This is that somebody, for a local chain.
 *
 * ── Why the amounts are computed and not written down ──────────────────────
 * `mint` requires the deposit to sit within `mintRedeemBandBps` of the policy
 * weights **by value**, not by token count (`_assertOnTargetWeight`). Equal
 * token counts across constituents priced from $200 to $500 are nowhere near
 * the target, which is `DepositOffTargetWeight`. So the amounts come from the
 * vault's own policy and its own feeds:
 *
 *     wholeTokenValueWad = feedAnswer · 1e18 / 10^feedDecimals · uiMultiplier / 1e18
 *     amount_i           = targetValue_i · 10^tokenDecimals / wholeTokenValueWad_i
 *
 * which is `_valueOf` inverted. Reading the weights off the vault rather than
 * restating them also means this keeps working for any theme, not just the one
 * that happened to be deployed first.
 *
 *   forge script script/SeedVault.s.sol --rpc-url http://anvil:8545 --broadcast \
 *     --unlocked --sender <acct> --sig "run(address,uint256)" <vault> <usd>
 */
contract SeedVault is Script {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    function run(address vault, uint256 depositUsd) external {
        require(
            keccak256(bytes(vm.envString("LOCAL_CHAIN_MODE"))) == keccak256("mock"),
            "Explicit mock mode required"
        );
        require(block.chainid == 46_630, "Local chain required");
        vm.rpc("anvil_nodeInfo", "[]");
        IVaultReads v = IVaultReads(vault);
        address[] memory tokens = v.constituents();
        address[] memory feedList = v.feeds();
        uint256[] memory weights = v.targetWeightsBps();
        uint256 n = tokens.length;
        require(n > 0, "SeedVault: vault has no constituents");

        uint256 totalWad = depositUsd * WAD;
        uint256[] memory amounts = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            (, int256 answer,,,) = IFeedReads(feedList[i]).latestRoundData();
            require(answer > 0, "SeedVault: feed answer is not positive");

            uint256 priceWad = uint256(answer) * WAD / (10 ** IFeedReads(feedList[i]).decimals());
            uint256 wholeTokenValueWad = priceWad * ITokenReads(tokens[i]).uiMultiplier() / WAD;
            require(wholeTokenValueWad > 0, "SeedVault: constituent prices to zero");

            uint256 targetValueWad = totalWad * weights[i] / BPS;
            amounts[i] =
                targetValueWad * (10 ** ITokenReads(tokens[i]).decimals()) / wholeTokenValueWad;
            require(amounts[i] > 0, "SeedVault: deposit too small for one constituent");
        }

        vm.startBroadcast();
        for (uint256 i; i < n; ++i) {
            ITokenReads(tokens[i]).approve(vault, amounts[i]);
        }
        // minSharesOut of 0: this is a local chain with a deterministic venue and
        // no other actor, so there is no front-run to protect against.
        uint256 shares = v.mint(amounts, msg.sender, 0);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Vault seeded ===");
        console2.log("vault           :", vault);
        console2.log("deposited USD   :", depositUsd);
        console2.log("shares minted   :", shares);
        console2.log("theme supply    :", ITokenReads(v.themeToken()).totalSupply());
        console2.log("nav per share   :", v.navPerShare());
    }
}
