/**
 * The two derived display fields, as pure functions.
 *
 * `price-poller.ts` does the reading and the writing; this file decides what a
 * 24h change and a sparkline are, from plain numbers. Same split as
 * `gates.ts`: the rule can be exercised without a database, and the rule is the
 * part that is easy to get subtly wrong.
 *
 * Both fields are computed once per poll cycle and stored on `universe`. The
 * alternative is a per-row history query inside `universeRouter.list()`, which
 * returns 96 rows on every dashboard load, so that would be 96 lookback queries
 * per page view against a table that grows by 96 rows a minute.
 *
 * ## The one rule that matters here
 *
 * **Unknown is `null` or `[]`, never `0`.** A stock that did not move and a
 * stock we have no history for are different facts, and a `0` would render as a
 * flat line and a "0.00%" that both read as measurements. This is global
 * do-not 2 applied to a derived field.
 */

/** Points the UI sparkline renders. */
export const SPARK_POINTS = 9;

/** The window both derived fields describe. */
export const SPARK_WINDOW_SEC = 24 * 60 * 60;

/**
 * Spacing between sample targets: 3 hours, so 9 points cover 24h inclusive of
 * both ends. The oldest point is the 24h baseline the change is measured from
 * and the newest is the price this cycle just wrote, which is why one set of
 * targets serves both fields.
 */
export const SPARK_STEP_SEC = SPARK_WINDOW_SEC / (SPARK_POINTS - 1);

/**
 * How far behind a target a sample may sit and still stand in for it.
 *
 * One step. At a 60s poll interval a healthy series has ~180 samples per step,
 * so needing to reach back more than a full step means the poller was down for
 * hours, and a point interpolated across that gap would draw a line through
 * time nobody observed.
 */
export const SAMPLE_LOOKBEHIND_SEC = SPARK_STEP_SEC;

/**
 * The 9 instants a series is sampled at, oldest first, ending at `endMs`.
 */
export function sampleTargets(endMs: number): Date[] {
  return Array.from(
    { length: SPARK_POINTS },
    (_, i) => new Date(endMs - (SPARK_POINTS - 1 - i) * SPARK_STEP_SEC * 1000),
  );
}

export interface DerivedDisplayFields {
  /** Percent, or null when either end of the window is missing. Never 0 as a
   *  stand-in: a real zero change has to stay distinguishable from an unknown
   *  one. */
  change24hPct: number | null;
  /** Exactly `SPARK_POINTS` numbers, or empty. */
  sparkSeries: number[];
}

function isPrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Turns the sampled points into the two stored fields.
 *
 * `points` is oldest-first and the same length as `sampleTargets` returned,
 * with `null` where no sample fell inside that target's lookbehind window.
 *
 * The two fields fail independently on purpose. A gap in the middle of the day
 * costs the sparkline, which cannot be drawn honestly with a hole in it, but it
 * does not cost the 24h change, which only ever depended on the two ends.
 */
export function deriveDisplayFields(points: readonly (number | null)[]): DerivedDisplayFields {
  const first = points[0];
  const last = points[points.length - 1];

  const change24hPct =
    points.length === SPARK_POINTS && isPrice(first) && isPrice(last)
      ? // Rounded to the scale of the column that stores it, so the value that
        // comes back out of Postgres is the value this function decided.
        Math.round(((last - first) / first) * 100 * 1e6) / 1e6
      : null;

  const complete = points.length === SPARK_POINTS && points.every(isPrice);

  return {
    change24hPct,
    // Partial history draws no sparkline. A 4-point line rendered in a slot
    // labelled 24h is a chart that lies about its own axis, and C1 does not
    // backfill history (locked decision 9), so this clears itself as the
    // series fills in.
    sparkSeries: complete ? (points as number[]).slice() : [],
  };
}
