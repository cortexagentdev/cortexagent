import { count, sql } from "drizzle-orm";

import type { OverviewStats } from "@shared/contracts.ts";

import { universe } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { getSession } from "../lib/session.ts";
import { publicProcedure, router, type Context } from "../trpc.ts";

const log = logger.child({ module: "stats-router" });

// v2: the cached value is an envelope carrying the moment the numbers were read
// from Postgres. The public surfaces publish that timestamp, and a served-from-
// cache response must not claim to have been measured at serve time.
const OVERVIEW_CACHE_KEY = "stats:overview:v2";

/** How long one reading is served for. Also the public `Cache-Control` max-age. */
export const OVERVIEW_CACHE_TTL_SEC = 30;

/** Everything the overview reader touches. The tRPC `Context` satisfies it, and
 *  so does a plain `{ db, redis }` from an HTTP route outside tRPC. */
export type StatsDeps = Pick<Context, "db" | "redis">;

/** One reading of the overview, with the moment it was taken. */
export interface OverviewReading {
  /** ISO-8601. When the numbers were read from Postgres, not when they were served. */
  generatedAt: string;
  stats: OverviewStats;
}

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

function isOverviewReading(value: unknown): value is OverviewReading {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.generatedAt === "string" && isOverviewStats(candidate.stats);
}

async function readOverviewCache(deps: StatsDeps): Promise<OverviewReading | null> {
  try {
    const cached = await deps.redis.get(OVERVIEW_CACHE_KEY);
    if (cached === null) return null;

    const parsed: unknown = JSON.parse(cached);
    if (!isOverviewReading(parsed)) throw new Error("cached overview stats have an invalid shape");
    return parsed;
  } catch (err) {
    log.warn("overview stats cache read failed, falling through to Postgres", { err });
    return null;
  }
}

async function writeOverviewCache(deps: StatsDeps, reading: OverviewReading): Promise<void> {
  try {
    await deps.redis.set(OVERVIEW_CACHE_KEY, JSON.stringify(reading), "EX", OVERVIEW_CACHE_TTL_SEC);
  } catch (err) {
    log.warn("overview stats cache write failed", { err });
  }
}

async function loadOverviewStats(deps: StatsDeps): Promise<OverviewStats> {
  const [counts] = await deps.db
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

/**
 * The overview reading, from the shared cache when one is warm and from Postgres
 * otherwise. The single entry point for every surface that publishes these
 * numbers: the tRPC procedure, `/api/stats.json` and the badges all read here,
 * so no two of them can disagree about what the network looks like.
 */
export async function overviewReading(deps: StatsDeps): Promise<OverviewReading> {
  const cached = await readOverviewCache(deps);
  if (cached !== null) return cached;

  const reading: OverviewReading = {
    generatedAt: new Date().toISOString(),
    stats: await loadOverviewStats(deps),
  };
  await writeOverviewCache(deps, reading);
  return reading;
}

export const statsRouter = router({
  overview: publicProcedure.query(
    async ({ ctx }): Promise<OverviewStats> => (await overviewReading(ctx)).stats,
  ),
});
