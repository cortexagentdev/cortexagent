/**
 * Stock token, minimal ABI. Only the members Cortex actually reads.
 *
 * Every Stock Token is a beacon proxy over one shared implementation
 * (`STOCK_IMPLEMENTATION_ADDRESS`), so this one ABI covers all of them.
 *
 * Read paths only. The issuer powers on this contract (`mint`, `adminBurn`,
 * `pause`, `pauseOracle`, `updateMultiplier`) are deliberately absent: Cortex
 * never calls them, and their existence is a disclosure fact, not a capability.
 *
 * `uiMultiplier` is 18-dp fixed point (CRWD reads 4e18 after its 4:1 split).
 * `newUIMultiplier` equals the current multiplier when nothing is pending, and
 * `effectiveAt` is the unix timestamp a pending one takes effect. Holder math
 * uses `balanceOfUI` / `totalSupplyUI`, which are multiplier-adjusted.
 */
export const stockAbi = [
  {
    type: "function",
    name: "uid",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "uiMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "newUIMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "effectiveAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOfUI",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Raw ERC-20 balance, NOT multiplier-adjusted. The vault's NAV math holds raw
  // token quantities and scales by `uiMultiplier()` itself, so `vaultRouter`
  // (BE-27) reads this to reconstruct a vault's constituent basket and weights.
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupplyUI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Three advisory flags, read and displayed independently. None of them is a
  // price, so none of them is allowed to become a silent exclusion.
  {
    type: "function",
    name: "oraclePaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "tokenPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "terms",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
