import { desc, inArray } from "drizzle-orm";

import { lensMetrics } from "../db/schema.ts";
import type { Context } from "../trpc.ts";

/**
 * The columns the lens surfaces read from the newest `lens_metrics` row for a
 * lens. `movePct` / `netFlowUsd` are stored `null` when uncomputable (BE-19:
 * "null is not zero"); callers decide how to project that.
 */
export type LatestMetric = Pick<
  typeof lensMetrics.$inferSelect,
  "theme" | "movePct" | "netFlowUsd" | "signalCount24h" | "series" | "computedAt"
>;

/**
 * Newest `lens_metrics` row per requested theme. `DISTINCT ON (theme)` with
 * `ORDER BY theme, ts DESC` is a single backwards scan of
 * `lens_metrics_theme_ts_idx (theme, ts DESC)`: one row per theme, the latest
 * cycle. A lens with no row yet is simply absent from the map.
 */
export async function latestMetricsByTheme(
  ctx: Pick<Context, "db">,
  slugs: string[],
): Promise<Map<string, LatestMetric>> {
  if (slugs.length === 0) return new Map();

  const rows = await ctx.db
    .selectDistinctOn([lensMetrics.theme], {
      theme: lensMetrics.theme,
      movePct: lensMetrics.movePct,
      netFlowUsd: lensMetrics.netFlowUsd,
      signalCount24h: lensMetrics.signalCount24h,
      series: lensMetrics.series,
      computedAt: lensMetrics.computedAt,
    })
    .from(lensMetrics)
    .where(inArray(lensMetrics.theme, slugs))
    .orderBy(lensMetrics.theme, desc(lensMetrics.ts));

  return new Map(rows.map((row) => [row.theme, row]));
}

/** Drop the `null` points a member contributes when it is unpriceable at an
 *  instant. An all-null (or missing) series collapses to `[]`, which the UI
 *  reads as "this lens is not computable right now". */
export function toSeries(raw: (number | null)[] | null | undefined): number[] {
  return (raw ?? []).filter((point): point is number => point !== null);
}
