/**
 * `rank = f(zScore, confidence, recency)` (BE-10 scope section 5).
 *
 * One function, used everywhere the feed is ordered. `signalRouter.feed` (BE-17)
 * sorts on it descending; the lens aggregator (BE-19) uses it to pick the
 * headline signal for a theme.
 *
 * ## The weighting
 *
 * rank = 0.60 * magnitude + 0.25 * confidence + 0.15 * recency
 *
 * all three terms normalised to [0, 1], so `rank` itself is in [0, 1].
 *
 * - **magnitude (0.60)** dominates because "how far from normal" is the reason a
 *   signal exists. `abs(zScore)` is squashed through `z / (z + Z_HALF)`, which
 *   reaches 0.5 at `Z_HALF` and asymptotes to 1: a z of 12 should outrank a z
 *   of 6, but not by the same factor as 2 over 1.
 * - **confidence (0.25)** keeps a well-sourced MED signal from being buried
 *   under a thin HIGH-magnitude one, without letting it override a genuinely
 *   large move.
 * - **recency (0.15)** is a gentle tiebreak, not a decay that hides real
 *   signals. Half-life `RECENCY_HALF_LIFE_SEC`; a day-old signal still carries
 *   most of its rank.
 */

import type { Confidence } from "@shared/contracts.ts";

/** abs(zScore) at which the magnitude term reaches 0.5. */
export const Z_HALF = 3;
/** Age at which the recency term halves. 6 hours. */
export const RECENCY_HALF_LIFE_SEC = 6 * 60 * 60;

const WEIGHT_MAGNITUDE = 0.6;
const WEIGHT_CONFIDENCE = 0.25;
const WEIGHT_RECENCY = 0.15;

const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  HIGH: 1,
  MED: 0.6,
  LOW: 0.3,
};

function magnitudeTerm(zScore: number): number {
  const z = Math.abs(zScore);
  if (!Number.isFinite(z) || z <= 0) return 0;
  return z / (z + Z_HALF);
}

function recencyTerm(ageSec: number): number {
  if (!Number.isFinite(ageSec) || ageSec <= 0) return 1;
  return 2 ** (-ageSec / RECENCY_HALF_LIFE_SEC);
}

export interface RankInput {
  zScore: number;
  confidence: Confidence;
  /** When the signal fired. */
  ts: Date;
  /** Defaults to now. Injectable so a recompute ranks deterministically. */
  now?: Date;
}

/** The feed ordering score, in [0, 1]. */
export function computeRank(input: RankInput): number {
  const ageSec = ((input.now ?? new Date()).getTime() - input.ts.getTime()) / 1000;

  const rank =
    WEIGHT_MAGNITUDE * magnitudeTerm(input.zScore) +
    WEIGHT_CONFIDENCE * CONFIDENCE_WEIGHT[input.confidence] +
    WEIGHT_RECENCY * recencyTerm(ageSec);

  // Rounded to the precision the double column stores, so the value that comes
  // back out of Postgres is the one this function decided.
  return Math.round(rank * 1e9) / 1e9;
}
