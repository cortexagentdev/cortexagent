import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { UniverseAsset, UniverseRow } from "@shared/contracts.ts";

import { universe, type UniverseRecord } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { publicProcedure, router, type Context } from "../trpc.ts";

const log = logger.child({ module: "universe-router" });

const TOKEN_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const LIST_CACHE_PREFIX = "universe:list:v1";
const LIST_CACHE_TTL_SEC = 15;

const listInput = z
  .object({
    vaultEligibleOnly: z.boolean().optional(),
    query: z.string().trim().max(100).optional(),
  })
  .strict()
  .optional();

const byAddressInput = z
  .object({
    tokenAddress: z.string().regex(TOKEN_ADDRESS, "Invalid token address"),
  })
  .strict();

type UniverseListRecord = Pick<
  UniverseRecord,
  | "symbol"
  | "name"
  | "tokenAddress"
  | "priceUsd"
  | "change24hPct"
  | "feedAgeSec"
  | "feedAgreesWithQuote"
  | "signalEligible"
  | "vaultEligible"
  | "ineligibleReasons"
  | "sparkSeries"
>;

function tokenAddress(value: string, field = "tokenAddress"): `0x${string}` {
  if (!TOKEN_ADDRESS.test(value)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Universe row has an invalid ${field}`,
    });
  }
  return value as `0x${string}`;
}

function toUniverseRow(row: UniverseListRecord): UniverseRow {
  return {
    symbol: row.symbol,
    name: row.name,
    tokenAddress: tokenAddress(row.tokenAddress),
    priceUsd: row.priceUsd,
    change24hPct: row.change24hPct,
    feedAgeSec: row.feedAgeSec,
    feedAgreesWithQuote: row.feedAgreesWithQuote,
    signalEligible: row.signalEligible,
    vaultEligible: row.vaultEligible,
    ineligibleReasons: row.ineligibleReasons,
    spark: row.sparkSeries,
  };
}

function toUniverseAsset(row: UniverseRecord): UniverseAsset {
  if (row.multiplierEffectiveAt === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Universe asset is incomplete",
    });
  }

  return {
    ...toUniverseRow(row),
    decimals: row.decimals,
    onchainUid: row.onchainUid,
    authentic: row.authentic,
    registrySource: row.registrySource,
    registryCheckedAt: row.registryCheckedAt.toISOString(),
    assetStatus: row.assetStatus,
    chainlinkFeed:
      row.chainlinkFeed === null ? null : tokenAddress(row.chainlinkFeed, "chainlinkFeed"),
    feedDecimals: row.feedDecimals,
    heartbeatSec: row.heartbeatSec,
    quoteBid: row.quoteBid,
    quoteAsk: row.quoteAsk,
    uiMultiplier: row.uiMultiplier,
    newUIMultiplier: row.newUIMultiplier,
    multiplierEffectiveAt: row.multiplierEffectiveAt,
    registryMultiplier: row.registryMultiplier,
    multiplierMismatch: row.multiplierMismatch,
    lastAnswer: row.lastAnswer,
    lastUpdatedAt: row.lastUpdatedAt,
    oraclePaused: row.oraclePaused,
    tokenPaused: row.tokenPaused,
    paused: row.paused,
    isTradingHalt: row.isTradingHalt,
    priceSource: row.priceSource,
    liquidityUsd: row.liquidityUsd,
    poolDepthUsd: row.poolDepthUsd,
    venues: row.venues,
    redeemable: row.redeemable,
    maxRedeemUsd: row.maxRedeemUsd,
    sector: row.sector,
    factors: row.factors,
    jurisdictionBlocks: row.jurisdictionBlocks,
    refreshedAt: row.refreshedAt.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function lastRefreshVersion(ctx: Context): Promise<string> {
  const [latest] = await ctx.db
    .select({ refreshedAt: universe.refreshedAt })
    .from(universe)
    .orderBy(desc(universe.refreshedAt))
    .limit(1);

  return latest?.refreshedAt.toISOString() ?? "empty";
}

function listCacheKey(
  refreshedAt: string,
  input: { vaultEligibleOnly?: boolean; query?: string } | undefined,
): string {
  const query = input?.query?.toLowerCase() ?? "";
  return `${LIST_CACHE_PREFIX}:${refreshedAt}:${input?.vaultEligibleOnly === true ? "1" : "0"}:${encodeURIComponent(query)}`;
}

async function readListCache(ctx: Context, key: string): Promise<UniverseRow[] | null> {
  try {
    const cached = await ctx.redis.get(key);
    if (cached === null) return null;

    const parsed: unknown = JSON.parse(cached);
    if (!Array.isArray(parsed)) throw new Error("cached universe list is not an array");
    return parsed as UniverseRow[];
  } catch (err) {
    log.warn("universe list cache read failed, falling through to Postgres", { key, err });
    return null;
  }
}

async function writeListCache(ctx: Context, key: string, rows: UniverseRow[]): Promise<void> {
  try {
    await ctx.redis.set(key, JSON.stringify(rows), "EX", LIST_CACHE_TTL_SEC);
  } catch (err) {
    log.warn("universe list cache write failed", { key, err });
  }
}

async function loadUniverseRows(
  ctx: Context,
  input: { vaultEligibleOnly?: boolean; query?: string } | undefined,
): Promise<UniverseRow[]> {
  const conditions: SQL[] = [];
  if (input?.vaultEligibleOnly === true) conditions.push(eq(universe.vaultEligible, true));

  if (input?.query) {
    const pattern = `%${escapeLike(input.query)}%`;
    const search = or(
      ilike(universe.symbol, pattern),
      ilike(universe.name, pattern),
      ilike(universe.tokenAddress, pattern),
    );
    if (search) conditions.push(search);
  }

  const records: UniverseListRecord[] = await ctx.db
    .select({
      symbol: universe.symbol,
      name: universe.name,
      tokenAddress: universe.tokenAddress,
      priceUsd: universe.priceUsd,
      change24hPct: universe.change24hPct,
      feedAgeSec: universe.feedAgeSec,
      feedAgreesWithQuote: universe.feedAgreesWithQuote,
      signalEligible: universe.signalEligible,
      vaultEligible: universe.vaultEligible,
      ineligibleReasons: universe.ineligibleReasons,
      sparkSeries: universe.sparkSeries,
    })
    .from(universe)
    .where(and(...conditions))
    .orderBy(asc(universe.symbol));

  return records.map(toUniverseRow);
}

export const universeRouter = router({
  list: publicProcedure.input(listInput).query(async ({ ctx, input }): Promise<UniverseRow[]> => {
    const refreshedAt = await lastRefreshVersion(ctx);
    const cacheKey = listCacheKey(refreshedAt, input);
    const cached = await readListCache(ctx, cacheKey);
    if (cached !== null) return cached;

    const rows = await loadUniverseRows(ctx, input);
    await writeListCache(ctx, cacheKey, rows);
    return rows;
  }),

  byAddress: publicProcedure
    .input(byAddressInput)
    .query(async ({ ctx, input }): Promise<UniverseAsset> => {
      const [record] = await ctx.db
        .select()
        .from(universe)
        .where(ilike(universe.tokenAddress, input.tokenAddress))
        .limit(1);

      if (!record) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Universe asset not found",
        });
      }

      return toUniverseAsset(record);
    }),
});
