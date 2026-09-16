/**
 * ThemeToken, minimal ABI (BE-25a). The ERC-20 share of a Cortex theme.
 *
 * `totalSupply()` is the denominator in the NAV poller's indicative fallback.
 * `name()` / `symbol()` / `decimals()` are read once, at deploy time, by the
 * vault indexer: the `ThemeDeployed` event does not carry ERC-20 metadata (the
 * factory reads it straight off the token), and `decimals()` scales `flows`.
 *
 * The vault is the only minter and burner, set immutably at construction, so no
 * write member appears here.
 */
export const themeTokenAbi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
