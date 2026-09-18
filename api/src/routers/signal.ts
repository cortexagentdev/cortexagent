import { TRPCError } from "@trpc/server";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Signal, SignalKind, SignalTimeline, SignalTimelineEvent } from "@shared/contracts.ts";

import { signals, type SignalRecord } from "../db/schema.ts";
import {
  cachedRead,
  isSignalTimeline,
  loadTimeline,
  rangeStart,
  timelineCacheKey,
} from "../signals/timeline.ts";
import { publicProcedure, router } from "../trpc.ts";

const TOKEN_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const FEED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const SIGNAL_KINDS = [
  "FLOW",
  "LIQUIDITY_SHIFT",
  "HOLDER_CONCENTRATION",
  "PEG_DRIFT",
  "AFTER_HOURS_DISLOCATION",
  "CORPORATE_ACTION",
] as const satisfies readonly SignalKind[];

const feedInput = z
  .object({
    filter: z
      .object({
        kinds: z.array(z.enum(SIGNAL_KINDS)).min(1).optional(),
        confidence: z
          .array(z.enum(["HIGH", "MED", "LOW"]))
          .min(1)
          .optional(),
        // Powers the watchlist panel, so it takes many symbols. Matched
        // case-insensitively; signals are never joined on symbol elsewhere.
        tickers: z.array(z.string().trim().min(1).max(20)).min(1).optional(),
        // Matches the ticker or the explanation text.
        query: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    // Opaque keyset cursor, see `encodeCursor`. Never an offset: signals arrive
    // constantly and an offset would duplicate or skip rows mid-scroll.
    cursor: z.string().min(1).optional(),
    // `@trpc/react-query` injects this into the input of every `useInfiniteQuery`
    // call. The feed paginates forward only, so it is accepted and ignored;
    // declaring it keeps the surrounding `.strict()` from rejecting the request.
    direction: z.enum(["forward", "backward"]).optional(),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .strict()
  .optional();

const byIdInput = z.object({ id: z.string().trim().min(1) }).strict();

// The canonical universe symbol, matched exactly so the (ticker, ts) index is
// used. The asset page passes `asset.symbol`, which is what the computer writes.
const tickerInput = z.string().trim().min(1).max(20);

const timelineInput = z.object({ ticker: tickerInput }).strict();

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;

const historyInput = z
  .object({
    ticker: tickerInput,
    range: z.enum(["30d", "90d"]),
    kinds: z.array(z.enum(SIGNAL_KINDS)).min(1).optional(),
    confidence: z
      .array(z.enum(["HIGH", "MED", "LOW"]))
      .min(1)
      .optional(),
    cursor: z.string().min(1).optional(),
    // Injected by `useInfiniteQuery`, see `feedInput`.
    direction: z.enum(["forward", "backward"]).optional(),
    limit: z.number().int().positive().max(HISTORY_MAX_LIMIT).optional(),
  })
  .strict();

/** History pages newest-first on `(ts, id)`: rank is a feed concern, time is this one's. */
const historyCursorSchema = z
  .object({ ts: z.iso.datetime({ offset: true }), id: z.string().min(1) })
  .strict();

function encodeHistoryCursor(row: { ts: Date; id: string }): string {
  const payload: z.infer<typeof historyCursorSchema> = { ts: row.ts.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeHistoryCursor(raw: string): z.infer<typeof historyCursorSchema> {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return historyCursorSchema.parse(json);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid history cursor" });
  }
}

interface HistoryPage {
  events: SignalTimelineEvent[];
  nextCursor: string | null;
}

function isHistoryPage(value: unknown): value is HistoryPage {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return Array.isArray(c.events) && (c.nextCursor === null || typeof c.nextCursor === "string");
}

/**
 * The keyset cursor. It encodes the sort key of the last row of the previous
 * page `(rank, ts, id)` rather than a row count, so a signal inserted between
 * two `feed` calls neither duplicates a row onto the next page nor hides one.
 */
const cursorSchema = z
  .object({
    rank: z.number().finite(),
    ts: z.iso.datetime({ offset: true }),
    id: z.string().min(1),
  })
  .strict();

type FeedCursor = z.infer<typeof cursorSchema>;

function encodeCursor(row: Pick<SignalRecord, "rank" | "ts" | "id">): string {
  const payload: FeedCursor = { rank: row.rank, ts: row.ts.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): FeedCursor {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return cursorSchema.parse(json);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid feed cursor" });
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function tokenAddress(value: string): `0x${string}` {
  if (!TOKEN_ADDRESS.test(value)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Signal row has an invalid tokenAddress",
    });
  }
  return value as `0x${string}`;
}

function toSignal(row: SignalRecord): Signal {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    ticker: row.ticker,
    tokenAddress: tokenAddress(row.tokenAddress),
    kind: row.kind,
    magnitude: row.magnitude,
    zScore: row.zScore,
    rank: row.rank,
    confidence: row.confidence,
    explanation: row.explanation,
    evidence: row.evidence,
    sources: row.sources,
    window: row.window,
    afterHours: row.afterHours,
    supersededBy: row.supersededBy,
  };
}

/**
 * The filter conditions shared by the page query and the `counts` query.
 * Fields compose with AND; an array within a field is OR. The superseded-row
 * exclusion and 24-hour lookback are base conditions, not filters:
 * `supersededBy` is the contract's dedupe mechanism, while the time bound keeps
 * this current feed aligned with its "last 24h" UI contract. Historical rows
 * remain reachable through `byId`.
 */
function filterConditions(
  filter: NonNullable<z.infer<typeof feedInput>>["filter"],
  cutoff: Date,
): SQL[] {
  const conditions: SQL[] = [isNull(signals.supersededBy), gte(signals.ts, cutoff)];
  if (!filter) return conditions;

  if (filter.kinds) conditions.push(inArray(signals.kind, filter.kinds));
  if (filter.confidence) conditions.push(inArray(signals.confidence, filter.confidence));

  if (filter.tickers) {
    conditions.push(
      inArray(
        sql`upper(${signals.ticker})`,
        filter.tickers.map((ticker) => ticker.toUpperCase()),
      ),
    );
  }

  if (filter.query) {
    const pattern = `%${escapeLike(filter.query)}%`;
    const match = or(ilike(signals.ticker, pattern), ilike(signals.explanation, pattern));
    if (match) conditions.push(match);
  }

  return conditions;
}

export const signalRouter = router({
  feed: publicProcedure.input(feedInput).query(
    async ({
      ctx,
      input,
    }): Promise<{
      signals: Signal[];
      nextCursor: string | null;
      counts: { total: number; high: number };
    }> => {
      const limit = input?.limit ?? DEFAULT_LIMIT;
      const cutoff = new Date(Date.now() - FEED_LOOKBACK_MS);
      const filters = filterConditions(input?.filter, cutoff);

      const [tally] = await ctx.db
        .select({
          total: count(),
          high: sql<number>`count(*) filter (where ${eq(signals.confidence, "HIGH")})`.mapWith(
            Number,
          ),
        })
        .from(signals)
        .where(and(...filters));

      const pageConditions = [...filters];
      if (input?.cursor) {
        const cursor = decodeCursor(input.cursor);
        const ts = new Date(cursor.ts);
        const keyset = or(
          lt(signals.rank, cursor.rank),
          and(eq(signals.rank, cursor.rank), lt(signals.ts, ts)),
          and(eq(signals.rank, cursor.rank), eq(signals.ts, ts), lt(signals.id, cursor.id)),
        );
        if (keyset) pageConditions.push(keyset);
      }

      const rows: SignalRecord[] = await ctx.db
        .select()
        .from(signals)
        .where(and(...pageConditions))
        .orderBy(desc(signals.rank), desc(signals.ts), desc(signals.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        signals: page.map(toSignal),
        nextCursor: hasMore && last ? encodeCursor(last) : null,
        counts: {
          total: tally?.total ?? 0,
          high: tally?.high ?? 0,
        },
      };
    },
  ),

  byId: publicProcedure.input(byIdInput).query(async ({ ctx, input }): Promise<Signal> => {
    const [record] = await ctx.db
      .select()
      .from(signals)
      .where(eq(signals.id, input.id))
      .orderBy(desc(signals.ts))
      .limit(1);

    if (!record) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Signal not found" });
    }

    return toSignal(record);
  }),

  /**
   * 90 days of one ticker's signals as day x kind buckets plus the pattern read
   * per range. Bounded (at most 540 buckets) and cached per ticker for 60s.
   */
  timeline: publicProcedure
    .input(timelineInput)
    .query(({ ctx, input }): Promise<SignalTimeline> =>
      cachedRead(ctx, timelineCacheKey("tl", input.ticker), isSignalTimeline, () =>
        loadTimeline(ctx, input.ticker),
      ),
    ),

  /**
   * One ticker's signals in the range, superseded rows included, newest first.
   * Keyset paged on `(ts, id)`. Only the first page is cached: it is the one
   * every asset page view asks for.
   */
  history: publicProcedure
    .input(historyInput)
    .query(async ({ ctx, input }): Promise<HistoryPage> => {
      const limit = input.limit ?? HISTORY_DEFAULT_LIMIT;

      const load = async (): Promise<HistoryPage> => {
        const conditions: SQL[] = [
          eq(signals.ticker, input.ticker),
          gte(signals.ts, rangeStart(input.range)),
        ];
        if (input.kinds) conditions.push(inArray(signals.kind, input.kinds));
        if (input.confidence) conditions.push(inArray(signals.confidence, input.confidence));
        if (input.cursor) {
          const cursor = decodeHistoryCursor(input.cursor);
          const ts = new Date(cursor.ts);
          const keyset = or(lt(signals.ts, ts), and(eq(signals.ts, ts), lt(signals.id, cursor.id)));
          if (keyset) conditions.push(keyset);
        }

        const rows = await ctx.db
          .select({
            id: signals.id,
            ts: signals.ts,
            kind: signals.kind,
            zScore: signals.zScore,
            confidence: signals.confidence,
            window: signals.window,
            evidence: signals.evidence,
            supersededBy: signals.supersededBy,
            source: sql<string | null>`${signals.sources}->>0`,
          })
          .from(signals)
          .where(and(...conditions))
          .orderBy(desc(signals.ts), desc(signals.id))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page.at(-1);
        return {
          events: page.map((r) => ({ ...r, ts: r.ts.toISOString() })),
          nextCursor: hasMore && last ? encodeHistoryCursor(last) : null,
        };
      };

      if (input.cursor) return load();
      const key = timelineCacheKey(
        "h",
        input.ticker,
        input.range,
        [...(input.kinds ?? [])].sort().join(",") || "*",
        [...(input.confidence ?? [])].sort().join(",") || "*",
        String(limit),
      );
      return cachedRead(ctx, key, isHistoryPage, load);
    }),
});
