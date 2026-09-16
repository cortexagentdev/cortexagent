/**
 * Uniswap-style pool, minimal ABI. Covers both shapes with one ABI:
 * `slot0()` for a v3-style concentrated-liquidity pool, `getReserves()` for a
 * v2-style constant-product pair. A given pool answers one of the two; the
 * other reverts, which is exactly the per-call failure the multicall helper is
 * built to absorb.
 *
 * DEX data comes from direct pool reads, batched through Multicall3
 * (locked decision 8). Do not add an aggregator API client here. 0x exists in
 * this product for C2 rebalance routing only.
 */
export const poolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
