/**
 * FeeController, minimal ABI (BE-25e). Only the members `feeRouter` (BE-27)
 * reads.
 *
 * Testnet 46630 only (locked decision 5). The streaming fee accrues in
 * `themeToken` shares against tracking AUM over wall-clock time; this contract
 * reads no oracle, so `feeRouter.creatorAccrual.accruedUsd` is
 * `accruedShares × navPerShare` and is computed off-chain by the router.
 *
 * `accrual()` is the one-shot read the router calls: it folds the not-yet
 * checkpointed pending slice into `accrued` itself, so a single call is the
 * live lifetime figure. `creatorBps()` / `protocolBps()` are the effective
 * per-year AUM slices and always sum to `creatorFeeBps`.
 *
 * No write member appears here: `claim()` and `accrue()` are permissionless
 * keeper calls Cortex's backend never makes.
 */
export const feeControllerAbi = [
  {
    type: "function",
    name: "accrual",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "accrued", type: "uint256" },
      { name: "unclaimed", type: "uint256" },
      { name: "creatorClaimed", type: "uint256" },
      { name: "protocolClaimed", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "accruedShares",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "protocolBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
