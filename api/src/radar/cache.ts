import type { MarketRadar } from "@shared/contracts.ts";

import { logger } from "../lib/logger.ts";
import type { Context } from "../trpc.ts";

const log = logger.child({ module: "radar-cache" });

/**
 * The Market Radar is cached per wallet. The TTL matches the universe list
 * cache: every input it composes refreshes on a 60s-or-slower worker cycle, so
 * a 15s reading is never meaningfully behind, and a terminal left open polling
 * on the live interval reads Postgres at most once per TTL.
 *
 * Writes the caller makes (watchlist edits, alert rule changes, marking fires
 * seen) delete the key so their own changes show on the next read. A cache
 * failure is never fatal: reads fall through to Postgres, writes are dropped.
 */
export const RADAR_CACHE_TTL_SEC = 15;

const RADAR_CACHE_PREFIX = "radar:v1";

function radarKey(address: string): string {
  return `${RADAR_CACHE_PREFIX}:${address}`;
}

function isMarketRadar(value: unknown): value is MarketRadar {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const asOf = c.asOf as Record<string, unknown> | null | undefined;
  const alerts = c.alerts as Record<string, unknown> | null | undefined;
  return (
    typeof asOf === "object" &&
    asOf !== null &&
    typeof asOf.generatedAt === "string" &&
    Array.isArray(c.assets) &&
    Array.isArray(c.missingTickers) &&
    Array.isArray(c.signals) &&
    Array.isArray(c.lenses) &&
    typeof alerts === "object" &&
    alerts !== null &&
    typeof alerts.unseen === "number" &&
    Array.isArray(alerts.fires)
  );
}

export async function readRadarCache(
  ctx: Pick<Context, "redis">,
  address: string,
): Promise<MarketRadar | null> {
  const key = radarKey(address);
  try {
    const cached = await ctx.redis.get(key);
    if (cached === null) return null;

    const parsed: unknown = JSON.parse(cached);
    if (!isMarketRadar(parsed)) throw new Error("cached radar has an invalid shape");
    return parsed;
  } catch (err) {
    log.warn("radar cache read failed, falling through to Postgres", { key, err });
    return null;
  }
}

export async function writeRadarCache(
  ctx: Pick<Context, "redis">,
  address: string,
  radar: MarketRadar,
): Promise<void> {
  const key = radarKey(address);
  try {
    await ctx.redis.set(key, JSON.stringify(radar), "EX", RADAR_CACHE_TTL_SEC);
  } catch (err) {
    log.warn("radar cache write failed", { key, err });
  }
}

/** Drop the caller's reading after a write that changes what the Radar shows. */
export async function invalidateRadar(ctx: Pick<Context, "redis">, address: string): Promise<void> {
  const key = radarKey(address);
  try {
    await ctx.redis.del(key);
  } catch (err) {
    log.warn("radar cache invalidation failed", { key, err });
  }
}
