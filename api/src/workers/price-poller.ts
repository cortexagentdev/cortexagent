/**
 * The price poller: one price sample per priceable asset, every 60 seconds.
 *
 * `spec/CortexBackend.md` PART 5 owns the `price_history` shape and PART 2 owns
 * the pricing rules. The rules themselves are not re-implemented here: the
 * price this worker records comes out of `resolvePricing` in `gates.ts`, the
 * same function the universe refresher prices a row with, so the series and the
 * current price on `universe` can never disagree about what a price is or which
 * source won.
 *
 * ## The cycle
 *
 * 1. Read the live set out of `universe` (BE-5 owns that table).
 * 2. Chainlink `latestRoundData()` for the feed-carrying names, batched through
 *    Multicall3 and pinned to one block.
 * 3. `/rhj/prices` for every symbol, which is the only source covering all 96
 *    and the independent counterparty for the agreement test.
 * 4. Resolve a price per asset. Write one `price_history` row for each asset
 *    that has one, and nothing at all for an asset that does not.
 * 5. Re-derive `change24hPct` and `sparkSeries` on `universe` from the series.
 *
 * ## Budget
 *
 * Chain: one `eth_blockNumber` plus one Multicall3 request. 35 no-argument
 * reads are ~140 bytes of inner calldata against an 8192-byte chunk, so the
 * batch does not split. The cycle logs its measured request count.
 *
 * REST: one request per listed asset, since `/prices` serves one symbol per
 * request, paced by the shared limiter at 20 rps against a documented 60 rps
 * ceiling. The universe refresher sweeps the same symbols on the same interval,
 * so the pair costs 2N requests a minute: 6.5 rps at the 194 assets the
 * registry listed when this was measured, against the 96 PART 9 surveyed. The
 * 15s response cache in BE-4 absorbs the overlap when the two cycles land close
 * together. The headroom is real but it is not infinite, and a third sweeping
 * worker is the point at which this needs a shared quote cache rather than a
 * second copy of the sweep.
 *
 * ## What this worker does not decide
 *
 * Eligibility. A row that is authentic-unverified this minute (the registry was
 * unreachable, say) still has a real, observable price, and gapping its series
 * over a REST outage would blank the 24h change for all 96 names at once. This
 * worker records what an asset was worth; `universe-refresher` decides what may
 * be done with it.
 */

import { getAddress, type Address } from "viem";
import { sql } from "drizzle-orm";

import { aggregatorV3Abi } from "../chain/abis/index.ts";
import { MAX_STALENESS_SEC } from "../chain/addresses.ts";
import { publicClient } from "../chain/client.ts";
import { multicallRead, type MulticallItem } from "../chain/multicall.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { db } from "../db/client.ts";
import { priceHistory, universe, type NewPriceHistoryRecord } from "../db/schema.ts";
import { env } from "../env.ts";
import { logger } from "../lib/logger.ts";
import { fetchQuotes } from "../rhj/index.ts";
import { asRoundData } from "../universe/feeds.ts";
import { clampFeedAgeSec, parseFixed18, resolvePricing } from "../universe/gates.ts";
import {
  deriveDisplayFields,
  sampleTargets,
  SAMPLE_LOOKBEHIND_SEC,
  SPARK_POINTS,
} from "../universe/price-series.ts";
import type { PriceSource } from "@shared/contracts.ts";

const log = logger.child({ module: "price-poller" });

/** BullMQ repeatable interval. The task specifies 60s. */
export const PRICE_POLL_INTERVAL_MS = 60_000;

export interface PricePollSummary {
  startedAt: string;
  durationMs: number;
  /** Rows read out of `universe`. */
  assets: number;
  /** `price_history` rows written. */
  written: number;
  /** Assets with no price from any source. Deliberately no row, never a zero. */
  unpriceable: number;
  bySource: Record<PriceSource, number>;
  /** Priced off a Chainlink round that sat outside its own liveness bound.
   *  Recorded, never a rejection (global do-not 1). */
  stale: number;
  /** Underlying equity halted, per `/rhj/prices`. */
  halted: number;
  /** Symbols `/rhj/prices` could not answer for. */
  quoteFailures: number;
  /** Assets whose `change24hPct` is a number after this cycle. */
  withChange24h: number;
  /** Assets whose `sparkSeries` has all 9 points after this cycle. */
  withSparkSeries: number;
  /** JSON-RPC requests the cycle made. The batching budget, measured. */
  rpcRequests: number;
}

function emptySummary(startedAt: Date, startedMs: number): PricePollSummary {
  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    assets: 0,
    written: 0,
    unpriceable: 0,
    bySource: { chainlink: 0, "rhj-quote": 0, dex: 0 },
    stale: 0,
    halted: 0,
    quoteFailures: 0,
    withChange24h: 0,
    withSparkSeries: 0,
    rpcRequests: 0,
  };
}

// --- Derived display fields -------------------------------------------------

interface DerivedRow {
  tokenAddress: string;
  change24hPct: number | null;
  sparkSeries: number[];
}

/**
 * The 9 sample points per asset, oldest first.
 *
 * One statement rather than 96, and one statement rather than 864: the targets
 * are a small VALUES list, the addresses are an array, and the lateral join
 * takes the newest sample at or before each target from the primary key index
 * on `(token_address, ts)`. A target with no sample inside its lookbehind
 * window comes back null, which is what makes an incomplete series visible
 * instead of interpolated.
 */
async function loadSamplePoints(
  addresses: readonly string[],
  endTs: Date,
): Promise<Map<string, (number | null)[]>> {
  const points = new Map<string, (number | null)[]>();
  for (const address of addresses) points.set(address, new Array(SPARK_POINTS).fill(null));
  if (addresses.length === 0) return points;

  const addressList = sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  );
  // ISO strings, not Date objects. A raw statement hands its parameters
  // straight to postgres-js, which has no drizzle column type to infer from and
  // rejects a Date outright.
  const targetList = sql.join(
    sampleTargets(endTs.getTime()).map(
      (target, index) => sql`(${sql.raw(String(index))}, ${target.toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );
  // A constant, not input. Interpolated because a bound parameter inside
  // make_interval() has no type for Postgres to infer.
  const lookbehind = sql.raw(`make_interval(secs => ${SAMPLE_LOOKBEHIND_SEC})`);

  const rows = await db.execute<{ token_address: string; idx: number; price: string | null }>(sql`
    SELECT a.token_address, t.idx, s.price
    FROM unnest(ARRAY[${addressList}]::text[]) AS a(token_address)
    CROSS JOIN (VALUES ${targetList}) AS t(idx, target)
    LEFT JOIN LATERAL (
      SELECT h.price
      FROM price_history h
      WHERE h.token_address = a.token_address
        AND h.ts <= t.target
        AND h.ts > t.target - ${lookbehind}
      ORDER BY h.ts DESC
      LIMIT 1
    ) s ON TRUE
  `);

  for (const row of rows) {
    const series = points.get(row.token_address);
    if (!series) continue;
    const index = Number(row.idx);
    if (!Number.isInteger(index) || index < 0 || index >= SPARK_POINTS) continue;
    // numeric arrives as a string. Number() here rather than a numeric cast in
    // SQL, so the value that lands in the sparkline is the same one that
    // Postgres stored.
    series[index] = row.price === null ? null : Number(row.price);
  }

  return points;
}

/**
 * Recomputes both display fields for every asset and writes them back.
 *
 * Every asset is updated, not only the priced ones. An asset that has just
 * stopped being priceable has to lose the change and the series it used to
 * carry, or the terminal keeps rendering yesterday's line under a price of `-`.
 */
async function updateDisplayFields(
  addresses: readonly string[],
  endTs: Date,
): Promise<{ withChange24h: number; withSparkSeries: number }> {
  if (addresses.length === 0) return { withChange24h: 0, withSparkSeries: 0 };

  const points = await loadSamplePoints(addresses, endTs);
  const derived: DerivedRow[] = [];
  let withChange24h = 0;
  let withSparkSeries = 0;

  for (const address of addresses) {
    const fields = deriveDisplayFields(points.get(address) ?? []);
    derived.push({ tokenAddress: address, ...fields });
    if (fields.change24hPct !== null) withChange24h += 1;
    if (fields.sparkSeries.length > 0) withSparkSeries += 1;
  }

  const values = sql.join(
    derived.map(
      (row) =>
        sql`(${row.tokenAddress}, ${row.change24hPct}::numeric, ${JSON.stringify(row.sparkSeries)}::jsonb)`,
    ),
    sql`, `,
  );

  // These two columns belong to this worker. The refresher's upsert leaves them
  // alone for the same reason this statement touches nothing else on the row.
  await db.execute(sql`
    UPDATE universe AS u
    SET change24h_pct = v.change24h_pct, spark_series = v.spark_series
    FROM (VALUES ${values}) AS v(token_address, change24h_pct, spark_series)
    WHERE u.token_address = v.token_address
  `);

  return { withChange24h, withSparkSeries };
}

// --- The cycle --------------------------------------------------------------

/**
 * One poll cycle. Returns a summary; throws only on a genuine defect.
 *
 * A quote sweep that partly fails is not a defect: those names fall back to
 * their Chainlink feed, or get no row this cycle, and the count is in the
 * summary either way.
 */
export async function pollPrices(): Promise<PricePollSummary> {
  const startedAt = new Date();
  const startedMs = Date.now();

  const assets = await db
    .select({
      tokenAddress: universe.tokenAddress,
      symbol: universe.symbol,
      chainlinkFeed: universe.chainlinkFeed,
      feedDecimals: universe.feedDecimals,
      maxStalenessSec: universe.maxStalenessSec,
      uiMultiplier: universe.uiMultiplier,
      priceUsd: universe.priceUsd,
      priceSource: universe.priceSource,
    })
    .from(universe);

  if (assets.length === 0) {
    // Nothing to poll until BE-5 has run at least once. Not an error: on a cold
    // deploy the two workers start together and the refresher wins the race in
    // whichever order it likes.
    log.warn("universe is empty, nothing to poll");
    return emptySummary(startedAt, startedMs);
  }

  // REST and RPC do not depend on each other, so they run together.
  const quoteSweep = fetchQuotes(assets.map((asset) => asset.symbol));

  const feedAddresses = [
    ...new Set(
      assets
        .map((asset) => (asset.chainlinkFeed === null ? null : getAddress(asset.chainlinkFeed)))
        .filter((address): address is Address => address !== null),
    ),
  ];

  const chain = await countRpcRequests(
    async () => {
      if (feedAddresses.length === 0) return [] as MulticallItem<unknown>[];

      // Pin the batch to one block so every feed in this cycle is read at the
      // same chain state, the same way the refresher does it.
      const blockNumber = await publicClient.getBlockNumber();

      return (await multicallRead(
        feedAddresses.map(
          (address) =>
            ({ address, abi: aggregatorV3Abi, functionName: "latestRoundData" }) as const,
        ),
        { client: publicClient, blockNumber },
      )) as unknown as MulticallItem<unknown>[];
    },
    { operation: "research-price-poll", context: "research", priority: "background" },
  );

  const roundFor = new Map<Address, { answer: bigint; updatedAt: number }>();
  for (const [i, address] of feedAddresses.entries()) {
    const round = asRoundData(chain.value[i]);
    if (round !== null) roundFor.set(address, round);
  }

  const { quotes, failures } = await quoteSweep;
  if (failures.length > 0) {
    log.warn("some quotes failed this cycle", {
      count: failures.length,
      symbols: failures.slice(0, 10).map((failure) => failure.symbol),
    });
  }

  const nowSec = Math.floor(startedAt.getTime() / 1000);
  const rows: NewPriceHistoryRecord[] = [];
  const summary = emptySummary(startedAt, startedMs);
  summary.assets = assets.length;
  summary.quoteFailures = failures.length;
  summary.rpcRequests = chain.requests;

  for (const asset of assets) {
    const feed = asset.chainlinkFeed === null ? null : getAddress(asset.chainlinkFeed);
    const round = feed === null ? null : (roundFor.get(feed) ?? null);
    const quote = quotes.get(asset.symbol.toUpperCase());

    const pricing = resolvePricing({
      chainlinkFeed: feed,
      answer: round?.answer ?? null,
      feedDecimals: asset.feedDecimals,
      uiMultiplier: parseFixed18(asset.uiMultiplier),
      quoteMid: quote?.mid ?? null,
      // Pool depth is sampled by the refresher, on the same 60s cadence, and
      // re-reading every pool here would double the chain budget for a source
      // that only wins when both of the other two are silent. The refresher's
      // number is carried through, and only when it was actually the winner.
      dexPriceUsd: asset.priceSource === "dex" ? asset.priceUsd : null,
      tolerancePct: env.UNIVERSE_FEED_TOLERANCE_PCT,
    });

    if (pricing.priceUsd === null || pricing.priceSource === null) {
      // No row at all. A zero here would be indistinguishable from a real price
      // in every downstream chart (global do-not 2).
      summary.unpriceable += 1;
      continue;
    }

    // Age against the on-chain liveness bound (heartbeat + grace), and only for
    // a price that came from the feed. This is recorded, never a filter: these
    // feeds publish on 0.5% movement, so hours of silence on a liquid name is a
    // calm market and not a broken oracle.
    const feedAgeSec = clampFeedAgeSec(nowSec, round?.updatedAt ?? null);
    const stale =
      pricing.priceSource === "chainlink" &&
      feedAgeSec !== null &&
      feedAgeSec > (asset.maxStalenessSec ?? MAX_STALENESS_SEC);

    rows.push({
      tokenAddress: asset.tokenAddress,
      ticker: asset.symbol,
      ts: startedAt,
      price: pricing.priceUsd,
      source: pricing.priceSource,
      // TODO(BE-7): fill from the market session helper. Null until then, which
      // says "session unknown" rather than claiming regular hours.
      afterHours: null,
      stale,
      isTradingHalt: quote?.isTradingHalt ?? false,
    });

    summary.bySource[pricing.priceSource] += 1;
    if (stale) summary.stale += 1;
    if (quote?.isTradingHalt) summary.halted += 1;
  }

  if (rows.length > 0) {
    // A cycle stamps one timestamp on every row, so a re-run of the same cycle
    // collides with itself and is discarded rather than doubling a sample.
    await db.insert(priceHistory).values(rows).onConflictDoNothing();
  }
  summary.written = rows.length;

  const display = await updateDisplayFields(
    assets.map((asset) => asset.tokenAddress),
    startedAt,
  );
  summary.withChange24h = display.withChange24h;
  summary.withSparkSeries = display.withSparkSeries;
  summary.durationMs = Date.now() - startedMs;

  log.info("prices polled", { ...summary });
  return summary;
}
