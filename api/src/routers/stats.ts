import { count, sql } from "drizzle-orm";

import type { OverviewStats } from "@shared/contracts.ts";

import { universe } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { getSession } from "../lib/session.ts";
import { publicProcedure, router, type Context } from "../trpc.ts";

const log = logger.child({ module: "stats-router" });

const OVERVIEW_CACHE_KEY = "stats:overview:v1";
const OVERVIEW_CACHE_TTL_SEC = 30;

const sessions = new Set<OverviewStats["session"]>(["pre", "rth", "after", "closed"]);
const numericFields = [
  "signals24h",
  "signals24hDeltaPct",
  "feedAgreementPct",
  "feedsTotal",
  "assetsActive",
  "vaultEligibleCount",
  "multiplierMismatchesToday",
] as const satisfies readonly (keyof OverviewStats)[];

function isOverviewStats(value: unknown): value is OverviewStats {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    sessions.has(candidate.session as OverviewStats["session"]) &&
    numericFields.every((field) => typeof candidate[field] === "number")
  );
}

async function readOverviewCache(ctx: Context): Promise<OverviewStats | null> {
  try {
    const cached = await ctx.redis.get(OVERVIEW_CACHE_KEY);
    if (cached === null) return null;

    const parsed: unknown = JSON.parse(cached);
    if (!isOverviewStats(parsed)) throw new Error("cached overview stats have an invalid shape");
    return parsed;
  } catch (err) {
    log.warn("overview stats cache read failed, falling through to Postgres", { err });
    return null;
  }
}

async function writeOverviewCache(ctx: Context, stats: OverviewStats): Promise<void> {
  try {
    await ctx.redis.set(OVERVIEW_CACHE_KEY, JSON.stringify(stats), "EX", OVERVIEW_CACHE_TTL_SEC);
  } catch (err) {
    log.warn("overview stats cache write failed", { err });
  }
}

async function loadOverviewStats(ctx: Context): Promise<OverviewStats> {
  const [counts] = await ctx.db
    .select({
      assetsActive: count(),
      feedsTotal:
        sql<number>`count(*) filter (where ${universe.chainlinkFeed} is not null)`.mapWith(Number),
      feedsAgreeing:
        sql<number>`count(*) filter (where ${universe.chainlinkFeed} is not null and ${universe.feedAgreesWithQuote})`.mapWith(
          Number,
        ),
      vaultEligibleCount: sql<number>`count(*) filter (where ${universe.vaultEligible})`.mapWith(
        Number,
      ),
      multiplierMismatchesToday:
        sql<number>`count(*) filter (where ${universe.multiplierMismatch})`.mapWith(Number),
    })
    .from(universe);

  const feedsTotal = counts?.feedsTotal ?? 0;
  const feedsAgreeing = counts?.feedsAgreeing ?? 0;

  return {
    session: getSession(new Date()),
    // TODO(BE-10): count signals over the current and preceding 24-hour windows.
    signals24h: 0,
    signals24hDeltaPct: 0,
    feedAgreementPct: feedsTotal === 0 ? 0 : (feedsAgreeing / feedsTotal) * 100,
    feedsTotal,
    assetsActive: counts?.assetsActive ?? 0,
    vaultEligibleCount: counts?.vaultEligibleCount ?? 0,
    multiplierMismatchesToday: counts?.multiplierMismatchesToday ?? 0,
  };
}

export const statsRouter = router({
  overview: publicProcedure.query(async ({ ctx }): Promise<OverviewStats> => {
    const cached = await readOverviewCache(ctx);
    if (cached !== null) return cached;

    const stats = await loadOverviewStats(ctx);
    await writeOverviewCache(ctx, stats);
    return stats;
  }),
});
