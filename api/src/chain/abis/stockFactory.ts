/**
 * StockFactory, minimal ABI. Only the members Cortex actually uses.
 *
 * This is Gate 1 (`spec/CortexBackend.md` PART 2). `tokenAddress(uid)` returns
 * the zero address for an unknown uid, which makes the gate fail-closed: an
 * unrecognised uid can never resolve to a real token.
 *
 * Factory membership alone is not sufficient. 203 `Deployed` events exist
 * against 96 active assets, so 107 are unlaunched ghosts with zero supply
 * (global do-not 4).
 */
export const stockFactoryAbi = [
  {
    type: "function",
    name: "tokenAddress",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "Deployed",
    inputs: [
      { name: "uid", type: "bytes32", indexed: true },
      { name: "stock", type: "address", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
    ],
  },
] as const;
