/**
 * The vault policy numbers the API mirrors from the Solidity, in one place.
 *
 * BE-29 scope 8. These values used to be declared twice, once in
 * `routers/theme.ts` and once in `routers/fee.ts`, each with its own comment
 * claiming to match a contract constant. A mirror that drifts from the contract
 * encodes calldata `ThemeFactory._validate` rejects, or worse, accepts at the
 * wrong value into an immutable vault with no rescue function. So there is now
 * exactly one declaration per number, and `chain/contract-constants.ts` checks
 * every one of them against the compiled artifact
 * (`bun run contracts:check`).
 *
 * Two kinds of number live here and they are not the same kind of claim:
 *
 * - **Mirrors.** `MAX_FEE_BPS`, `DEVIATION_THRESHOLD_BPS`, `MAX_SLIPPAGE_BPS`
 *   and `PROTOCOL_CUT_BPS` are `public constant`s in the bytecode. The contract
 *   is the root of truth and a mismatch is a bug, always.
 * - **Choices.** `BAND_HEADROOM_BPS` and `SLIPPAGE_CAP_BPS` are policy this router picks and writes into
 *   calldata. No constant in the contract carries them. What the checker can
 *   assert about these is that they sit inside the bounds the contract enforces,
 *   which is a weaker but still worthwhile claim, and each one carries its
 *   justification below.
 */

// --- Mirrors: `public constant` in the compiled contracts --------------------

/** `ThemeFactory.MAX_FEE_BPS` / `KeylessVault.MAX_FEE_BPS` /
 *  `FeeController.MAX_FEE_BPS`, bps of AUM per year. A protocol constant,
 *  identical for every theme, and the fee can never be raised after deploy
 *  (PART 4). Mirrored so the cap is quotable before a factory exists. */
export const MAX_FEE_BPS = 100;

/** `ThemeFactory.DEVIATION_THRESHOLD_BPS` / `KeylessVault.DEVIATION_THRESHOLD_BPS`.
 *  The configured feed update threshold. The mint band exceeds this plus the
 *  fee, but this is NOT an oracle accuracy bound or an arbitrage guarantee. */
export const DEVIATION_THRESHOLD_BPS = 50;

/** `KeylessVault.MAX_SLIPPAGE_BPS`. The ceiling on `slippageCapBps`; the vault
 *  constructor rejects 0 and anything above it. */
export const MAX_SLIPPAGE_BPS = 500;

/** `FeeController.PROTOCOL_CUT_BPS`, in bps OF THE FEE (not of AUM). The
 *  protocol's share of every accrual; the rest is the creator's. */
export const PROTOCOL_CUT_BPS = 1_500;

/** Basis-point denominator. `BPS` in every one of the three contracts. */
export const BPS = 10_000;

// --- Choices: policy this API writes into calldata ---------------------------

/**
 * Headroom above the `DEVIATION_THRESHOLD_BPS + creatorFeeBps` floor that both
 * `ThemeFactory._validate` and the `KeylessVault` constructor enforce STRICTLY
 * (`<=` reverts). The band is always the floor plus this.
 *
 * Any positive integer satisfies the contract, so 1 would compile and deploy.
 * 10 bps (0.10%) is chosen instead for two reasons, neither of them arbitrary:
 *
 * 1. **The gate already uses it.** `universe/gates.ts` sets `NAV_BAND_PCT = 0.6`
 *    for exactly the same floor at zero fee: 0.5% deviation plus 0.1% headroom,
 *    and calls that 0.1 "the fee headroom". `DEVIATION_THRESHOLD_BPS + 0 + 10`
 *    is 60 bps, which is that same 0.6%. Picking 1 here would make the band the
 *    on-chain vault enforces narrower than the band the off-chain redeemability
 *    gate simulated against, so a basket could pass the gate and then fail to
 *    redeem inside its own vault's band.
 * 2. **A 1 bps margin is inside the rounding.** Weights are integers summing to
 *    10000 by largest remainder, and NAV is an oracle product; a band sitting
 *    0.01% above the arbitrage floor is not a margin, it is noise.
 */
export const BAND_HEADROOM_BPS = 10;

/**
 * Swap slippage cap on a user-requested routed deposit/exit leg, bps.
 *
 * Bounded, not mirrored: the vault rejects 0 and anything above
 * `MAX_SLIPPAGE_BPS`. 100 bps is a fifth of that ceiling. User minimum
 * outputs are still required; an oracle-derived floor is not a market quote.
 */
export const SLIPPAGE_CAP_BPS = 100;

/** ERC-20 decimals of every theme share. */
export const THEME_DECIMALS = 18;

/**
 * Per-constituent weight cap in the immutable policy: twice its target, floored
 * at target + 5pp and ceilinged at 100%. `ThemeFactory._validate` requires
 * `capsBps[i] >= targetWeightsBps[i]` and `<= BPS`.
 */
export function capBpsFor(targetBps: number): number {
  return Math.min(BPS, Math.max(targetBps * 2, targetBps + 500));
}
