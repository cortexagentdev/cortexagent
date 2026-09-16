/**
 * The shared statistics every processor uses: the trailing baseline, the
 * z-score, and the confidence downgrade (BE-10 scope section 5).
 *
 * These are pure functions plus one DB helper. Same split as `gates.ts` and
 * `price-series.ts`: the arithmetic that is easy to get subtly wrong lives away
 * from the database so it can be exercised on plain numbers, and there is one
 * implementation of it rather than one per processor.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { Confidence } from "@shared/contracts.ts";

import type { Db } from "../db/client.ts";
import { signals } from "../db/schema.ts";
import type { SignalKind } from "./types.ts";

/** The baseline window. PART 3: "magnitude vs trailing baseline". */
export const TRAILING_BASELINE_DAYS = 30;

/**
 * Sample size at or above which data is not considered thin. Below it,
 * `deriveConfidence` caps confidence: a z-score off three observations is
 * arithmetic, not evidence.
 */
export const MIN_SAMPLES_FOR_HIGH = 20;
/** Below this, confidence is forced to LOW regardless of anything else. */
export const MIN_SAMPLES_FOR_MED = 8;

export interface BaselineStats {
  mean: number;
  /** Sample standard deviation (n - 1). Zero when fewer than two samples or
   *  every sample is identical. */
  stddev: number;
  sampleSize: number;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * Sample standard deviation, denominator `n - 1`.
 *
 * `n - 1` not `n`: the baseline is a sample of the asset's behaviour, not the
 * whole population of it, and Bessel's correction is the standard choice for
 * "how unusual is this new observation against what I have seen".
 */
export function stddev(xs: readonly number[], precomputedMean?: number): number {
  if (xs.length < 2) return 0;
  const m = precomputedMean ?? mean(xs);
  const variance = xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function baselineStats(samples: readonly number[]): BaselineStats {
  const m = mean(samples);
  return { mean: m, stddev: stddev(samples, m), sampleSize: samples.length };
}

/**
 * How many standard deviations `observed` sits from the baseline mean.
 *
 * Returns 0 when the baseline cannot support a z-score: fewer than two samples,
 * or a standard deviation of zero (every prior observation identical). A 0 here
 * is honest. it says "no baseline", and `deriveConfidence` will already have
 * capped confidence on the same thin `sampleSize`, so a real signal is not
 * silently promoted by a missing baseline.
 */
export function zScore(observed: number, samples: readonly number[]): number {
  const { mean: m, stddev: s } = baselineStats(samples);
  if (s === 0) return 0;
  return (observed - m) / s;
}

/**
 * The confidence downgrade (BE-10 scope section 5).
 *
 * Starts at HIGH and steps down for each independent weakness:
 * - `sampleSize < MIN_SAMPLES_FOR_MED`  -> LOW outright.
 * - `sampleSize < MIN_SAMPLES_FOR_HIGH` -> at most MED.
 * - `feedAgreesWithQuote === false`     -> one notch down. The Chainlink answer
 *   and the independent quote disagree, so anything derived from either is
 *   suspect (Design Law 3a).
 *
 * The steps compound: thin data on an asset whose feed disagrees is LOW.
 */
export function deriveConfidence(input: {
  sampleSize: number;
  feedAgreesWithQuote: boolean;
}): Confidence {
  const order: Confidence[] = ["LOW", "MED", "HIGH"];
  let level = 2; // HIGH

  if (input.sampleSize < MIN_SAMPLES_FOR_MED) level = Math.min(level, 0);
  else if (input.sampleSize < MIN_SAMPLES_FOR_HIGH) level = Math.min(level, 1);

  if (!input.feedAgreesWithQuote) level -= 1;

  return order[Math.max(0, Math.min(order.length - 1, level))];
}

/**
 * The trailing baseline for one kind and ticker: the `evidence.observed` values
 * of every non-superseded signal in the last `TRAILING_BASELINE_DAYS`, before
 * `windowEnd`.
 *
 * Reading prior `observed` rather than `magnitude` keeps the baseline in the
 * same unit the processor is about to compare against, and excluding superseded
 * rows keeps a single window from contributing twice after a recompute.
 *
 * A processor that maintains its own richer series (FLOW off archive logs, say)
 * may ignore this and build its own; it exists so the common case has one
 * shared source.
 */
export async function loadBaseline(
  db: Db,
  kind: SignalKind,
  ticker: string,
  windowEnd: Date,
): Promise<number[]> {
  const since = new Date(windowEnd.getTime() - TRAILING_BASELINE_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ observed: sql<number>`(${signals.evidence} ->> 'observed')::double precision` })
    .from(signals)
    .where(
      and(
        eq(signals.kind, kind),
        eq(signals.ticker, ticker),
        gte(signals.ts, since),
        sql`${signals.ts} < ${windowEnd}`,
        sql`${signals.supersededBy} is null`,
      ),
    )
    .orderBy(desc(signals.ts));

  return rows
    .map((row) => row.observed)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}
