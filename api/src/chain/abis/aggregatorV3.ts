/**
 * Chainlink AggregatorV3, minimal ABI.
 *
 * Only 35 of the 96 active Stock Tokens have a feed, which is why signal
 * eligibility and vault eligibility are separate flags rather than one.
 *
 * `decimals` reads 8 on every observed feed. Call it anyway, never hardcode.
 *
 * `latestRoundData().updatedAt` is recorded and displayed, never used as a
 * rejection rule: age tracks volatility, not oracle health (global do-not 1).
 * One feed was observed reporting `updatedAt` 14s in the future, so clamp any
 * computed age at zero rather than letting clock skew produce a negative.
 */
export const aggregatorV3Abi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
