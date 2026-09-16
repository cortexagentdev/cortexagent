// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { FeeController } from "./FeeController.sol";
import { KeylessVault } from "./KeylessVault.sol";
import { ThemeToken } from "./ThemeToken.sol";
import { VaultDeployer } from "./VaultDeployer.sol";

/**
 * @title ThemeFactory
 * @notice One transaction deploys a complete, immutable Cortex theme: the
 *         `ThemeToken` share, the `KeylessVault` that backs it, and the
 *         `FeeController` that streams the creator fee. `CortexBackend.md` PART 4
 *         ends the construction sequence with "a `StrataFactory`-style factory
 *         deploys token + vault + fee controller"; this is that factory. No pool
 *         is seeded: the share's exit is `KeylessVault.redeem()` in kind at NAV,
 *         and a secondary AMM pool would be a second, worse exit priced by
 *         whoever seeded it (BE-29 amended the PART 4 line, which read
 *         "token + vault + pool" until then).
 *
 *         New production artifacts use PresetThemeFactory. This base retains
 *         the legacy fee-policy ABI and behavior; existing deployments remain
 *         immutable. FeeController is recorded accounting, not a value payout.
 *
 * ── The factory is NOT an owner ────────────────────────────────────────────
 * It deploys and forgets. None of the three contracts it creates has an owner,
 * an admin, a role or a setter (Design Law 4), so there is nothing for the
 * factory to hold and it holds nothing. After `deployTheme` returns, the factory
 * has exactly the same (zero) authority over the theme as any other address.
 * `ThemeFactory.t.sol` asserts this.
 *
 * ── Resolving the token ↔ vault construction cycle ─────────────────────────
 * `ThemeToken` needs the vault address; `KeylessVault` needs the token address.
 * Neither accepts a settable address (`BE-25a`, `BE-25b`), so the cycle is
 * broken by ADDRESS PRECOMPUTATION, not mutation:
 *
 *   1. The factory tracks its own account nonce (`_deployNonce`, seeded at 1 per
 *      EIP-161 and advanced by exactly 3 per successful theme).
 *   2. It computes the vault's future CREATE address — `keccak256(rlp(factory,
 *      nonce + 1))` — before deploying anything.
 *   3. It deploys `ThemeToken` (nonce + 0) passing that precomputed vault
 *      address, already final.
 *   4. It deploys `KeylessVault` (nonce + 1) passing the now-real token address.
 *   5. It asserts the vault landed exactly where step 2 predicted. A nonce
 *      desync therefore reverts the whole transaction — it can never silently
 *      produce a mis-wired, permanently broken immutable vault.
 *
 * ── Fail cheap, not permanently ───────────────────────────────────────────
 * The vault is immutable and has no rescue function, so a bad policy that
 * deployed would be dead weight forever. Every check the vault constructor makes
 * is re-made here FIRST, before a single `new`, so a bad theme reverts as a
 * plain input error instead of burning gas on three deployments.
 */
contract ThemeFactory {
    // ─────────────────────────── constants ────────────────────────────────

    /// @notice Program ceiling on the streaming creator fee, in bps of AUM per
    ///         year. Matches `KeylessVault.MAX_FEE_BPS` and
    ///         `FeeController.MAX_FEE_BPS`.
    uint256 public constant MAX_FEE_BPS = 100;

    /// @notice Configured feed update threshold, in bps. The mint band must
    ///         exceed this plus the fee. This is not an accuracy guarantee.
    uint256 public constant DEVIATION_THRESHOLD_BPS = 50;

    uint256 internal constant BPS = 10_000;

    // ─────────────────────── protocol-wide config ─────────────────────────

    /// @notice The protocol's fee-cut sink, passed to every `FeeController` this
    ///         factory deploys. A protocol constant, not a per-theme parameter:
    ///         the ledger transfers no value. Fixed at
    ///         factory construction, never changed.
    address public immutable protocolFeeSink;

    /// @dev The factory's own account nonce. EIP-161 seeds a new contract at 1;
    ///      this advances by exactly 3 per `deployTheme` (token, vault, fee
    ///      controller) and the factory performs no other `new`, so it stays in
    ///      lockstep with the real nonce. Used only to precompute the vault
    ///      address; the post-deploy assertion is the real guarantee.
    uint256 private _deployNonce = 1;

    /// @notice Themes deployed by this factory, in order. Convenience for
    ///         off-chain indexers; carries no authority.
    address[] public deployedVaults;

    // ─────────────────────────── errors ───────────────────────────────────

    error ZeroProtocolFeeSink();
    error EmptySlug();
    error EmptyName();
    error EmptySymbol();
    error ZeroCreator();
    error CreatorMustBeCaller();
    error ZeroUsdg();
    error NoConstituents();
    error LengthMismatch();
    error ZeroConstituent(uint256 index);
    error ConstituentHasNoFeed(uint256 index);
    error FeedNotResponding(uint256 index);
    error ZeroWeight(uint256 index);
    error BadCap(uint256 index);
    error WeightsMustSumToBps(uint256 got);
    error FeeAboveCap();
    error MintRedeemBandTooTight();
    error NoVenues();
    error ZeroVenue(uint256 index);
    error VaultAddressMismatch(address predicted, address actual);

    // ─────────────────────────── events ───────────────────────────────────

    /**
     * @notice Emitted once per theme, immediately followed by exactly one
     *         `ThemeComposition` with the same `policyHash` in the same
     *         transaction. `BE-26` indexes the pair and needs no follow-up call
     *         to identify or describe the deployment; the split is only because
     *         a single log with the whole basket blows the stack.
     *
     *         Carries the task's required set — slug, creator, token, vault,
     *         feeController, policyHash — plus the settlement token and the two
     *         headline policy numbers. ERC-20 `name()` / `symbol()` / `decimals()`
     *         are read straight off `themeToken`.
     *
     * @param policyHash `keccak256(abi.encode(vaultPolicy))` — integrity anchor
     *        for the immutable policy, and the join key to `ThemeComposition`.
     * @param creator The theme creator (fee-split beneficiary; no on-chain power).
     * @param themeToken The ERC-20 share address.
     * @param slug URL slug, e.g. "ai-infrastructure".
     * @param vault The `KeylessVault` backing the share.
     * @param feeController The `FeeController` streaming the creator fee.
     * @param usdg The USDG settlement token for the routed mint/redeem paths.
     * @param creatorFeeBps Streaming fee rate, bps of AUM per year.
     * @param mintRedeemBandBps Mint/redeem spread retained in the vault.
     */
    event ThemeDeployed(
        bytes32 indexed policyHash,
        address indexed creator,
        address indexed themeToken,
        string slug,
        address vault,
        address feeController,
        address usdg,
        uint256 creatorFeeBps,
        uint256 mintRedeemBandBps
    );

    /**
     * @notice The constituent basket for the theme identified by `policyHash` /
     *         `themeToken`. Always emitted once, right after `ThemeDeployed`, in
     *         the same transaction.
     *
     * @param constituents Constituent Stock Token addresses.
     * @param feeds Parallel Chainlink AggregatorV3 proxies.
     * @param targetWeightsBps Parallel target weights (sum 10000).
     * @param capsBps Parallel per-constituent weight caps.
     */
    event ThemeComposition(
        bytes32 indexed policyHash,
        address indexed themeToken,
        address[] constituents,
        address[] feeds,
        uint256[] targetWeightsBps,
        uint256[] capsBps
    );

    // ─────────────────────────── params ───────────────────────────────────

    /**
     * @notice Everything a caller supplies. The factory fills in the one field
     *         the caller cannot — the vault's `themeToken` — and forwards the
     *         rest to `KeylessVault.ThemePolicy` unchanged.
     */
    struct ThemeParams {
        string slug;
        string name;
        string symbol;
        uint8 decimals;
        address creator;
        address usdg;
        address[] constituents;
        address[] feeds;
        uint256[] targetWeightsBps;
        uint256[] capsBps;
        uint256 creatorFeeBps;
        uint256 mintRedeemBandBps;
        uint256 slippageCapBps;
        uint256 maxRedeemUsd;
        address[] allowedVenues;
    }

    // ─────────────────────────── construction ─────────────────────────────

    constructor(address protocolFeeSink_) {
        if (protocolFeeSink_ == address(0)) revert ZeroProtocolFeeSink();
        protocolFeeSink = protocolFeeSink_;
    }

    // ─────────────────────────── deploy ───────────────────────────────────

    /**
     * @notice Deploy a complete theme in one call. Permissionless — the caller
     *         gains no authority over the result, and neither does the factory.
     *
     * @return themeToken The ERC-20 share.
     * @return vault The `KeylessVault` backing it.
     * @return feeController The `FeeController` for the creator fee.
     */
    function deployTheme(ThemeParams calldata params)
        public
        virtual
        returns (ThemeToken themeToken, KeylessVault vault, FeeController feeController)
    {
        _validateRelease(params);
        _validate(params);
        if (params.creator != msg.sender) revert CreatorMustBeCaller();

        // Step 1–2: precompute the vault's CREATE address before deploying.
        uint256 nonce = _deployNonce;
        address predictedVault = _computeCreateAddress(address(this), nonce + 1);

        // Step 3: token first, with the already-final vault address.
        themeToken = new ThemeToken(params.name, params.symbol, params.decimals, predictedVault);

        // Step 4: the vault, with the now-real token address.
        KeylessVault.ThemePolicy memory policy = _toPolicy(params, address(themeToken));
        vault = VaultDeployer.deploy(policy);

        // Step 5: the cycle is only resolved if the vault landed where the token
        // was told it would. A nonce desync reverts here, never ships broken.
        if (address(vault) != predictedVault) {
            revert VaultAddressMismatch(predictedVault, address(vault));
        }

        // The fee controller. Creator cut + protocol cut, both fixed forever.
        feeController =
            new FeeController(themeToken, params.creator, protocolFeeSink, params.creatorFeeBps);

        _deployNonce = nonce + 3;
        deployedVaults.push(address(vault));

        _emitDeployed(params, policy, address(vault), address(feeController));
    }

    /// @dev Maps caller params onto the vault's policy struct, filling the one
    ///      field the caller cannot supply — the freshly deployed token.
    function _toPolicy(ThemeParams calldata p, address token)
        internal
        pure
        returns (KeylessVault.ThemePolicy memory)
    {
        return KeylessVault.ThemePolicy({
            themeToken: token,
            usdg: p.usdg,
            creator: p.creator,
            constituents: p.constituents,
            feeds: p.feeds,
            targetWeightsBps: p.targetWeightsBps,
            capsBps: p.capsBps,
            creatorFeeBps: p.creatorFeeBps,
            mintRedeemBandBps: p.mintRedeemBandBps,
            slippageCapBps: p.slippageCapBps,
            maxRedeemUsd: p.maxRedeemUsd,
            allowedVenues: p.allowedVenues
        });
    }

    /// @dev Isolated so `deployTheme` does not carry the whole event argument
    ///      list on its stack at once. Reads the numeric/array fields back off
    ///      the already-assembled `policy` memory struct (one stack slot) and the
    ///      string fields off `p` (calldata), which keeps the frame shallow.
    function _emitDeployed(
        ThemeParams calldata p,
        KeylessVault.ThemePolicy memory policy,
        address vault,
        address feeController
    ) private {
        bytes32 policyHash = keccak256(abi.encode(policy));
        emit ThemeDeployed(
            policyHash,
            policy.creator,
            policy.themeToken,
            p.slug,
            vault,
            feeController,
            policy.usdg,
            policy.creatorFeeBps,
            policy.mintRedeemBandBps
        );
        emit ThemeComposition(
            policyHash,
            policy.themeToken,
            policy.constituents,
            policy.feeds,
            policy.targetWeightsBps,
            policy.capsBps
        );
    }

    // ─────────────────────────── views ────────────────────────────────────

    function deployedCount() external view returns (uint256) {
        return deployedVaults.length;
    }

    /// @notice The vault address `deployTheme` would produce on the very next
    ///         call, given the factory's current nonce. Off-chain helper.
    function predictedNextVault() external view returns (address) {
        return _computeCreateAddress(address(this), _deployNonce + 1);
    }

    // ─────────────────────────── validation ───────────────────────────────

    /**
     * @dev Re-runs every gate `KeylessVault`'s constructor enforces, BEFORE any deployment. A feedless
     *      constituent, weights that miss 10000, or a fee above cap all revert
     *      here as an input error.
     */
    /// @dev Version-specific policy restrictions; the legacy factory adds none.
    function _validateRelease(ThemeParams calldata) internal pure virtual { }

    function _validate(ThemeParams calldata p) private view {
        if (bytes(p.slug).length == 0) revert EmptySlug();
        if (bytes(p.name).length == 0) revert EmptyName();
        if (bytes(p.symbol).length == 0) revert EmptySymbol();
        if (p.creator == address(0)) revert ZeroCreator();
        if (p.usdg == address(0)) revert ZeroUsdg();

        uint256 n = p.constituents.length;
        if (n == 0) revert NoConstituents();
        if (p.feeds.length != n || p.targetWeightsBps.length != n || p.capsBps.length != n) {
            revert LengthMismatch();
        }

        if (p.creatorFeeBps > MAX_FEE_BPS) revert FeeAboveCap();

        // The mint band strictly exceeds the configured threshold plus fee.
        uint256 floor = DEVIATION_THRESHOLD_BPS + p.creatorFeeBps;
        if (p.mintRedeemBandBps <= floor) revert MintRedeemBandTooTight();

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (p.constituents[i] == address(0)) revert ZeroConstituent(i);
            // Design Law 2: a name with no Chainlink feed can never be priced
            // on-chain. The 35-name universe, not all 96 active tokens.
            if (p.feeds[i] == address(0)) revert ConstituentHasNoFeed(i);
            // A no-code feed address would let a staticcall "succeed" with empty
            // returndata and only blow up later. Reject it now.
            if (p.feeds[i].code.length == 0) revert FeedNotResponding(i);
            if (p.targetWeightsBps[i] == 0) revert ZeroWeight(i);
            if (p.capsBps[i] < p.targetWeightsBps[i] || p.capsBps[i] > BPS) revert BadCap(i);
            sum += p.targetWeightsBps[i];
        }
        if (sum != BPS) revert WeightsMustSumToBps(sum);

        uint256 v = p.allowedVenues.length;
        if (v == 0) revert NoVenues();
        for (uint256 i; i < v; ++i) {
            if (p.allowedVenues[i] == address(0)) revert ZeroVenue(i);
        }
    }

    // ─────────────────────────── create-address maths ─────────────────────

    /**
     * @dev The CREATE address for `deployer` at `nonce`: `keccak256(rlp([deployer,
     *      nonce]))`, last 20 bytes. Same result as forge-std `StdUtils`, but the
     *      nonce is RLP-encoded by a byte loop rather than fixed-width casts, so
     *      it is correct for every `nonce < 2**64` (well past anything this
     *      factory can reach) with no truncating typecast.
     */
    function _computeCreateAddress(address deployer, uint256 nonce)
        internal
        pure
        returns (address)
    {
        bytes memory nonceRlp = _rlpEncodeNonce(nonce);
        // list payload = 0x94 ++ 20-byte address ++ nonceRlp; always < 56 bytes,
        // so the list header is a single byte 0xc0 + payloadLength.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 payloadLen = uint8(21 + nonceRlp.length);
        bytes1 listHeader = bytes1(0xc0) | bytes1(payloadLen);
        bytes32 h = keccak256(abi.encodePacked(listHeader, bytes1(0x94), deployer, nonceRlp));
        return address(uint160(uint256(h)));
    }

    /// @dev RLP encoding of the account nonce as a scalar: `0x80` for zero, the
    ///      byte itself for `1..0x7f`, else `0x80 + len` then the minimal
    ///      big-endian bytes. The bytes are peeled off with a loop, so there is
    ///      no fixed-width cast that could truncate a large nonce.
    function _rlpEncodeNonce(uint256 nonce) private pure returns (bytes memory) {
        if (nonce == 0) return hex"80";

        uint256 len;
        for (uint256 t = nonce; t != 0; t >>= 8) {
            ++len;
        }
        bytes memory be = new bytes(len);
        uint256 v = nonce;
        for (uint256 i; i < len; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            be[len - 1 - i] = bytes1(uint8(v & 0xff));
            v >>= 8;
        }

        if (len == 1 && uint8(be[0]) <= 0x7f) return be;
        // len is at most 32 (loop over a uint256), so 0x80 + len never overflows
        // a byte and this cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes1 lenPrefix = bytes1(0x80) | bytes1(uint8(len));
        return abi.encodePacked(lenPrefix, be);
    }
}
