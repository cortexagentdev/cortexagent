/**
 * The per-ticker signal timeline behind `signalRouter.timeline` and the first
 * page of `signalRouter.history`.
 *
 * Everything here is a Postgres read of rows the signal computer already wrote:
 * no RPC, no upstream API. The feed shows the live 24h; this shows 30 and 90
 * days, superseded rows included, because a superseded row is still a window
 * in which the kind fired.
 *
 * ## Bounded by construction
 *
 * The timeline never ships raw rows. It is one `time_bucket` aggregate over the
 * `(ticker, ts DESC)` index, at most 90 days x 6 kinds = 540 small rows, and the
 * patterns are derived from those buckets in memory. The event list is keyset
 * paged in the router.
 *
 * ## Cached
 *
 * Signals are computed every 15 minutes, so a 60s reading is never meaningfully
 * behind. Asset pages share the cache per ticker, the same way the Radar shares
 * one per wallet. A cache failure is never fatal: reads fall through to
 * Postgres, writes are dropped.
 */
import { asc, sql } from "drizzle-orm";

import type {
  Confidence,
  SignalKind,
  SignalKindPattern,
  SignalPatternLabel,
  SignalTimeline,
  SignalTimelineDay,
  SignalTimelineRange,
} from "@shared/contracts.ts";

import { signals } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import type { Context } from "../trpc.ts";

const log = logger.child({ module: "signal-timeline" });

const DAY_MS = 24 * 60 * 60 * 1000;

export const TIMELINE_CACHE_TTL_SEC = 60;
const TIMELINE_CACHE_PREFIX = "sigtl:v1";

export const TIMELINE_RANGE_DAYS: Record<SignalTimelineRange, number> = { "30d": 30, "90d": 90 };

/** A kind whose first fire in the range is this recent reads as new. */
const NEW_WITHIN_MS = 3 * DAY_MS;
/** Below this much stored history everything would read as new, so nothing does. */
const NEW_MIN_HISTORY_MS = 7 * DAY_MS;
const RECURRING_MIN_DAYS = 5;
const MOSTLY_LOW_SHARE = 0.7;

/** UTC midnight `days - 1` days before today, so the range is `days` whole buckets. */
export function rangeStart(range: SignalTimelineRange, now = Date.now()): Date {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return new Date(today - (TIMELINE_RANGE_DAYS[range] - 1) * DAY_MS);
}

interface Bucket extends SignalTimelineDay {
  firstTs: number;
  lastTs: number;
}

function patternsFor(
  buckets: Bucket[],
  range: SignalTimelineRange,
  historySinceMs: number | null,
  now: number,
): SignalKindPattern[] {
  const startDay = rangeStart(range, now).toISOString().slice(0, 10);
  const byKind = new Map<SignalKind, Bucket[]>();
  for (const b of buckets) {
    if (b.day < startDay) continue;
    const list = byKind.get(b.kind) ?? [];
    list.push(b);
    byKind.set(b.kind, list);
  }

  const canBeNew = historySinceMs !== null && now - historySinceMs >= NEW_MIN_HISTORY_MS;
  const patterns: SignalKindPattern[] = [];
  for (const [kind, list] of byKind) {
    const count = list.reduce((n, b) => n + b.count, 0);
    const low = list.reduce((n, b) => n + b.low, 0);
    const firstTs = Math.min(...list.map((b) => b.firstTs));
    const lastTs = Math.max(...list.map((b) => b.lastTs));
    const activeDays = list.length;
    const lowShare = count === 0 ? 0 : low / count;

    const labels: SignalPatternLabel[] = [];
    if (canBeNew && now - firstTs <= NEW_WITHIN_MS) labels.push("NEW");
    if (activeDays >= RECURRING_MIN_DAYS) labels.push("RECURRING");
    if (activeDays === 1) labels.push("ISOLATED");
    if (lowShare >= MOSTLY_LOW_SHARE) labels.push("MOSTLY_LOW");

    patterns.push({
      kind,
      count,
      activeDays,
      firstTs: new Date(firstTs).toISOString(),
      lastTs: new Date(lastTs).toISOString(),
      lowShare,
      labels,
    });
  }
  return patterns.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

function toMs(value: string | Date): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

export async function loadTimeline(
  ctx: Pick<Context, "db">,
  ticker: string,
  now = Date.now(),
): Promise<SignalTimeline> {
  const start = rangeStart("90d", now);

  const [rows, [oldest]] = await Promise.all([
    ctx.db.execute<{
      day: string | Date;
      kind: SignalKind;
      count: number;
      max_abs_z: number;
      high: number;
      med: number;
      low: number;
      first_ts: string | Date;
      last_ts: string | Date;
    }>(sql`
      SELECT time_bucket('1 day'::interval, ${signals.ts}) AS day,
             ${signals.kind} AS kind,
             count(*)::int AS count,
             max(abs(${signals.zScore}))::float8 AS max_abs_z,
             count(*) FILTER (WHERE ${signals.confidence} = ${"HIGH" satisfies Confidence})::int AS high,
             count(*) FILTER (WHERE ${signals.confidence} = ${"MED" satisfies Confidence})::int AS med,
             count(*) FILTER (WHERE ${signals.confidence} = ${"LOW" satisfies Confidence})::int AS low,
             min(${signals.ts}) AS first_ts,
             max(${signals.ts}) AS last_ts
      FROM ${signals}
      WHERE ${signals.ticker} = ${ticker}
        AND ${signals.ts} >= ${start.toISOString()}::timestamptz
      GROUP BY day, kind
      ORDER BY day ASC, kind ASC
    `),
    // The hypertable's own ts index makes this a single-row read.
    ctx.db.select({ ts: signals.ts }).from(signals).orderBy(asc(signals.ts)).limit(1),
  ]);

  const buckets: Bucket[] = rows.map((r) => ({
    day: new Date(toMs(r.day)).toISOString().slice(0, 10),
    kind: r.kind,
    count: Number(r.count),
    maxAbsZ: Number(r.max_abs_z),
    high: Number(r.high),
    med: Number(r.med),
    low: Number(r.low),
    firstTs: toMs(r.first_ts),
    lastTs: toMs(r.last_ts),
  }));
  const historySinceMs = oldest ? oldest.ts.getTime() : null;

  return {
    ticker,
    generatedAt: new Date(now).toISOString(),
    historySince: historySinceMs === null ? null : new Date(historySinceMs).toISOString(),
    days: buckets.map(({ firstTs: _f, lastTs: _l, ...day }) => day),
    patterns: {
      "30d": patternsFor(buckets, "30d", historySinceMs, now),
      "90d": patternsFor(buckets, "90d", historySinceMs, now),
    },
  };
}

/* --------------------------------- cache --------------------------------- */

export function timelineCacheKey(...parts: string[]): string {
  return [TIMELINE_CACHE_PREFIX, ...parts].join(":");
}

/**
 * Read-through cache for the timeline and history reads. `isValid` is a shape
 * check on what comes back, so a stale or foreign value falls through to
 * Postgres instead of reaching the client.
 */
export async function cachedRead<T>(
  ctx: Pick<Context, "redis">,
  key: string,
  isValid: (value: unknown) => value is T,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await ctx.redis.get(key);
    if (cached !== null) {
      const parsed: unknown = JSON.parse(cached);
      if (isValid(parsed)) return parsed;
      log.warn("cached timeline value has an invalid shape", { key });
    }
  } catch (err) {
    log.warn("timeline cache read failed, falling through to Postgres", { key, err });
  }

  const value = await load();
  try {
    await ctx.redis.set(key, JSON.stringify(value), "EX", TIMELINE_CACHE_TTL_SEC);
  } catch (err) {
    log.warn("timeline cache write failed", { key, err });
  }
  return value;
}

export function isSignalTimeline(value: unknown): value is SignalTimeline {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const patterns = c.patterns as Record<string, unknown> | null | undefined;
  return (
    typeof c.ticker === "string" &&
    typeof c.generatedAt === "string" &&
    Array.isArray(c.days) &&
    typeof patterns === "object" &&
    patterns !== null &&
    Array.isArray(patterns["30d"]) &&
    Array.isArray(patterns["90d"])
  );
}
