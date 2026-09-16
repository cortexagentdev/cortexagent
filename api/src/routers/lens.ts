import { TRPCError } from "@trpc/server";
import { desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { LensDetail, LensMember, LensSummary } from "@shared/contracts.ts";

import { lensMetrics, universe } from "../db/schema.ts";
import { deployedTokenIdFor } from "../execution/shared-lens-registry.ts";
import { classificationBySymbol, loadLenses, type LensDefinition } from "../lenses/load.ts";
import { logger } from "../lib/logger.ts";
import { publicProcedure, router, type Context } from "../trpc.ts";

const log = logger.child({ module: "lens-router" });

// Lens metrics are recomputed once every few minutes (BE-19), and the member
// `change24hPct` join reads `universe`, which itself refreshes on a 60s poll.
// A short TTL keeps the sidebar and detail pane cheap without serving a stale
// theme read.
const THEMES_CACHE_KEY = "lens:themes:v1";
const BY_THEME_CACHE_PREFIX = "lens:byTheme:v1";
const CACHE_TTL_SEC = 30;

const byThemeInput = z.object({ slug: z.string().trim().min(1) }).strict();

/**
 * The columns `themes()` and `byTheme()` read from the newest `lens_metrics`
 * row for a lens. `movePct` / `netFlowUsd` are stored `null` when uncomputable
 * (BE-19: "null is not zero"); the contract projection is a plain `number`, so
 * they are coalesced to `0` at this boundary and the empty `series` is what
 * signals "not computable" to the UI (W-5).
 */
type LatestMetric = Pick<
  typeof lensMetrics.$inferSelect,
  "theme" | "movePct" | "netFlowUsd" | "signalCount24h" | "series"
>;

/**
 * Newest `lens_metrics` row per requested theme. `DISTINCT ON (theme)` with
 * `ORDER BY theme, ts DESC` is a single backwards scan of
 * `lens_metrics_theme_ts_idx (theme, ts DESC)`: one row per theme, the latest
 * cycle. A lens with no row yet is simply absent from the map.
 */
async function latestMetricsByTheme(
  ctx: Context,
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
    })
    .from(lensMetrics)
    .where(inArray(lensMetrics.theme, slugs))
    .orderBy(lensMetrics.theme, desc(lensMetrics.ts));

  return new Map(rows.map((row) => [row.theme, row]));
}

/** Drop the `null` points a member contributes when it is unpriceable at an
 *  instant. An all-null (or missing) series collapses to `[]`, which the UI
 *  reads as "this lens is not computable right now". */
function toSeries(raw: (number | null)[] | null | undefined): number[] {
  return (raw ?? []).filter((point): point is number => point !== null);
}

function toLensSummary(lens: LensDefinition, metric: LatestMetric | undefined): LensSummary {
  return {
    slug: lens.slug,
    name: lens.name,
    color: lens.color,
    movePct: metric?.movePct ?? 0,
    netFlowUsd: metric?.netFlowUsd ?? 0,
    memberCount: lens.members.length,
    series: toSeries(metric?.series),
  };
}

/**
 * Live `change24hPct` per lens member. The lens file references members by
 * symbol; that symbol is resolved to a token address through `classification.json`
 * (authenticity is an address match, never a symbol match, global do-not 3) and
 * the address is joined to `universe`. A member with no live universe row, or one
 * that is currently unpriceable, carries `null`, never `0` (global do-not 2).
 */
async function memberChanges(ctx: Context, lens: LensDefinition): Promise<LensMember[]> {
  const bySymbol = classificationBySymbol();

  const addressBySymbol = new Map<string, string>();
  for (const member of lens.members) {
    const classified = bySymbol.get(member.symbol.toUpperCase());
    if (classified) addressBySymbol.set(member.symbol.toUpperCase(), classified.tokenAddress);
  }

  const addresses = [...new Set(addressBySymbol.values())];
  const changeByAddress = new Map<string, number | null>();
  if (addresses.length > 0) {
    const rows = await ctx.db
      .select({
        tokenAddress: sql<string>`lower(${universe.tokenAddress})`,
        change24hPct: universe.change24hPct,
      })
      .from(universe)
      .where(inArray(sql`lower(${universe.tokenAddress})`, addresses));
    for (const row of rows) changeByAddress.set(row.tokenAddress, row.change24hPct);
  }

  return lens.members.map((member) => {
    const address = addressBySymbol.get(member.symbol.toUpperCase());
    const change24hPct = address ? (changeByAddress.get(address) ?? null) : null;
    return { symbol: member.symbol, weightPct: member.weightPct, change24hPct };
  });
}

async function readCache<T>(ctx: Context, key: string, guard: (value: unknown) => value is T) {
  try {
    const cached = await ctx.redis.get(key);
    if (cached === null) return null;

    const parsed: unknown = JSON.parse(cached);
    if (!guard(parsed)) throw new Error("cached lens payload has an invalid shape");
    return parsed;
  } catch (err) {
    log.warn("lens cache read failed, falling through to Postgres", { key, err });
    return null;
  }
}

async function writeCache(ctx: Context, key: string, value: unknown): Promise<void> {
  try {
    await ctx.redis.set(key, JSON.stringify(value), "EX", CACHE_TTL_SEC);
  } catch (err) {
    log.warn("lens cache write failed", { key, err });
  }
}

function isLensSummary(value: unknown): value is LensSummary {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.slug === "string" &&
    typeof c.name === "string" &&
    typeof c.color === "string" &&
    typeof c.movePct === "number" &&
    typeof c.netFlowUsd === "number" &&
    typeof c.memberCount === "number" &&
    Array.isArray(c.series) &&
    c.series.every((point) => typeof point === "number")
  );
}

function isLensSummaryArray(value: unknown): value is LensSummary[] {
  return Array.isArray(value) && value.every(isLensSummary);
}

function isLensDetail(value: unknown): value is LensDetail {
  if (!isLensSummary(value)) return false;
  const c = value as unknown as Record<string, unknown>;
  return (
    typeof c.thesis === "string" &&
    typeof c.signalCount24h === "number" &&
    (c.vaultTokenId === null || typeof c.vaultTokenId === "string") &&
    Array.isArray(c.members) &&
    c.members.every((member) => {
      if (typeof member !== "object" || member === null) return false;
      const m = member as Record<string, unknown>;
      return (
        typeof m.symbol === "string" &&
        typeof m.weightPct === "number" &&
        (m.change24hPct === null || typeof m.change24hPct === "number")
      );
    })
  );
}

export const lensRouter = router({
  themes: publicProcedure.query(async ({ ctx }): Promise<LensSummary[]> => {
    const cached = await readCache(ctx, THEMES_CACHE_KEY, isLensSummaryArray);
    if (cached !== null) return cached;

    const lenses = loadLenses();
    const metrics = await latestMetricsByTheme(
      ctx,
      lenses.map((lens) => lens.slug),
    );

    const summaries = lenses.map((lens) => toLensSummary(lens, metrics.get(lens.slug)));
    await writeCache(ctx, THEMES_CACHE_KEY, summaries);
    return summaries;
  }),

  byTheme: publicProcedure
    .input(byThemeInput)
    .query(async ({ ctx, input }): Promise<LensDetail> => {
      const lens = loadLenses().find((candidate) => candidate.slug === input.slug);
      if (!lens) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown lens" });
      }

      const cacheKey = `${BY_THEME_CACHE_PREFIX}:${lens.slug}`;
      const cached = await readCache(ctx, cacheKey, isLensDetail);
      // Research may be cached; shared-vault identity must be resolved against
      // the current execution generation and canonical chain on every read.
      if (cached !== null)
        return { ...cached, vaultTokenId: await deployedTokenIdFor(ctx, lens.slug) };

      const [metrics, members, vaultTokenId] = await Promise.all([
        latestMetricsByTheme(ctx, [lens.slug]),
        memberChanges(ctx, lens),
        deployedTokenIdFor(ctx, lens.slug),
      ]);
      const metric = metrics.get(lens.slug);

      const detail: LensDetail = {
        ...toLensSummary(lens, metric),
        thesis: lens.thesis,
        signalCount24h: metric?.signalCount24h ?? 0,
        members,
        vaultTokenId,
      };

      await writeCache(ctx, cacheKey, detail);
      return detail;
    }),
});
