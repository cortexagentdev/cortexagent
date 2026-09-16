// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ThemeToken
 * @notice An ERC-20 share of a Cortex theme. Deliberately minimal.
 *
 * The vault is the ONLY minter and burner. It is set once, in the constructor,
 * and stored `immutable`. There is:
 *
 *   - no setter for the vault address,
 *   - no owner, no admin, no access-control role,
 *   - no upgrade path (this contract sits behind no proxy).
 *
 * The immutability is the point. A settable minter would be a key that can
 * dilute every holder at will, which is exactly what CortexBackend.md PART 0
 * Design Law 4 forbids: "No admin key can move user funds or reweight outside
 * published policy." Total supply therefore moves only through `mint` and
 * `burn`, and only when the vault calls them, so it always tracks the vault's
 * backed position one-for-one.
 *
 * Construction ordering. The token needs the vault address and the vault needs
 * the token address, a cycle. It is NOT resolved with a settable vault address.
 * The factory precomputes its next vault CREATE address from its account nonce,
 * deploys the token, then creates the vault through a statically linked library
 * in factory context. This constructor receives an already-final address.
 *
 * Testnet 46630 only. No real value, from anyone, including the owner (locked
 * decision 5). Every CortexBackend.md PART 10 mainnet gate is still open.
 */
contract ThemeToken is ERC20 {
    /// @notice The keyless vault. Only address that may mint or burn. Immutable.
    address public immutable vault;

    /// @dev ERC-20 decimals, fixed at construction. Stock Tokens and their
    ///      Chainlink feeds are 8-dp, but a theme share is a share of NAV, not a
    ///      wrapper over one token, so 18 is the sane default. The factory may
    ///      override it per theme.
    uint8 private immutable _decimals;
    uint256 private _supplySeconds;
    uint256 private _supplyUpdatedAt;

    error ZeroVault();
    error NotVault(address caller);
    error UnrecoverableRecipient();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault(msg.sender);
        _;
    }

    /**
     * @param name_ ERC-20 name, e.g. "Cortex AI Infrastructure".
     * @param symbol_ ERC-20 symbol, e.g. "ctxAIINFRA".
     * @param decimals_ ERC-20 decimals. 18 unless a theme needs otherwise.
     * @param vault_ The KeylessVault for this theme. Final address, never changed.
     */
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address vault_)
        ERC20(name_, symbol_)
    {
        if (vault_ == address(0)) revert ZeroVault();
        vault = vault_;
        _decimals = decimals_;
        _supplyUpdatedAt = block.timestamp;
    }

    /// @inheritdoc ERC20
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function _update(address from, address to, uint256 value) internal override {
        // Circulating shares carry redemption rights to their new holder.
        // Already-created exit claims are separate vault balances, not shares.
        if (to == vault || to == address(this)) revert UnrecoverableRecipient();
        if (from == address(0) || to == address(0)) {
            _supplySeconds = cumulativeSupplySeconds();
            _supplyUpdatedAt = block.timestamp;
        }
        super._update(from, to, value);
    }

    /// @notice Time integral of actual outstanding shares for the fee ledger.
    function cumulativeSupplySeconds() public view returns (uint256) {
        return _supplySeconds + totalSupply() * (block.timestamp - _supplyUpdatedAt);
    }

    /**
     * @notice Mint `shares` to `to`. Vault only.
     * @dev The vault calls this after it has received constituents at target
     *      weights, with proportional-ownership and caller-output bounds.
     */
    function mint(address to, uint256 shares) external onlyVault {
        _mint(to, shares);
    }

    /**
     * @notice Burn `shares` from `from`. Vault only.
     * @dev The vault calls this on redeem, before it transfers the pro-rata
     *      constituents out. No allowance dance: the vault is the sole burner and
     *      redeem is vault-initiated.
     */
    function burn(address from, uint256 shares) external onlyVault {
        _burn(from, shares);
    }
}
