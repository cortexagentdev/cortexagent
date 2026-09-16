/**
 * The universe refresher: one cycle of the eligibility gate, every 60 seconds.
 *
 * `spec/CortexBackend.md` PART 2 is the root of truth for what this decides.
 * The judging itself lives in `../universe/gates.ts` as pure functions; this
 * file does the reading, and the split is on purpose. The gate is the most
 * safety-critical logic in the product and it should be exercisable without an
 * RPC endpoint.
 *
 * ## The cycle
 *
 * 1. `/rhj/assets` for the live set, their status and their registry multiplier.
 *    An unreachable registry is not an empty registry: BE-4 raises a typed error
 *    so that this worker can downgrade every row to non-eligible instead of
 *    treating silence as authenticity.
 * 2. `StockFactory.tokenAddress(uid)` for each asset, batched. This is Gate 1's
 *    authority and it is fail-closed: an unknown uid returns `address(0)`.
 * 3. Token state, batched: `totalSupply`, the three multipliers, `decimals` and
 *    the three advisory pause flags.
 * 4. Chainlink feeds for the 35 names that have one, batched.
 * 5. `/rhj/prices` for every symbol. This is the independent counterparty for
 *    the agreement test, and the only price source that covers all 96.
 * 6. Direct pool reads for depth, when a venue is configured.
 * 7. Judge, then upsert.
 *
 * Every chain read goes through Multicall3 and every batch is pinned to one
 * block, so a cycle is five RPC requests rather than several hundred and the
 * results inside it are mutually consistent.
 *
 * ## What this worker deliberately does not do
 *
 * PART 2 suggests enumerating the canonical set from the factory's `Deployed`
 * event. That scan is not run here. It costs thousands of `eth_getLogs` calls
 * against a ~30M block chain, it would blow the per-cycle request budget on a
 * cold cache, and it adds nothing to Gate 1: every asset that becomes a row is
 * already address-verified against `StockFactory.tokenAddress(uid)`, and the
 * 107 unlaunched ghosts the scan would enumerate are exactly the tokens this
 * worker has no row for. Log-range scanning arrives with BE-15, which builds
 * the forward-only indexer, and the enumeration cross-check belongs there.
 */

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { stockAbi, stockFactoryAbi, aggregatorV3Abi } from "../chain/abis/index.ts";
import { MAX_STALENESS_SEC, STOCK_FACTORY_ADDRESS } from "../chain/addresses.ts";
import { publicClient } from "../chain/client.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { db } from "../db/client.ts";
import { universe, type NewUniverseRecord } from "../db/schema.ts";
import { env } from "../env.ts";
import { logger } from "../lib/logger.ts";
import { ASSET_STATUS_ACTIVE, fetchAssets, fetchQuotes, isRhjError } from "../rhj/index.ts";
import type { RhjAsset, RhjQuote } from "../rhj/index.ts";
import { asRoundData, loadFeedDirectory, type ChainlinkFeed } from "../universe/feeds.ts";
import { evaluateAsset, formatFixed18, clampFeedAgeSec, REASONS } from "../universe/gates.ts";
import { EMPTY_POOL_SAMPLE, samplePoolDepth, usdgDecimalsCall } from "../universe/pools.ts";
import { conflictUpdateSet } from "../db/upsert.ts";
import { notInArray } from "drizzle-orm";

const log = logger.child({ module: "universe-refresher" });

/** BullMQ repeatable interval. PART 2: every 60s. */
export const UNIVERSE_REFRESH_INTERVAL_MS = 60_000;

/** A bytes32, which is what `StockFactory.tokenAddress` takes. */
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Columns the refresher owns. Everything else on the row belongs to another
 * task and is left untouched by the upsert: `sector` and `factors` to BE-18,
 * `change24hPct` and `sparkSeries` to BE-6. A 60s cycle must not blank work
 * another worker did.
 */
const REFRESHER_COLUMNS = [
  "symbol",
  "name",
  "decimals",
  "onchainUid",
  "authentic",
  "registrySource",
  "registryCheckedAt",
  "assetStatus",
  "chainlinkFeed",
  "feedDecimals",
  "heartbeatSec",
  "maxStalenessSec",
  "feedAgeSec",
  "quoteBid",
  "quoteAsk",
  "feedAgreesWithQuote",
  "uiMultiplier",
  "newUIMultiplier",
  "multiplierEffectiveAt",
  "registryMultiplier",
  "multiplierMismatch",
  "lastAnswer",
  "lastUpdatedAt",
  "oraclePaused",
  "tokenPaused",
  "paused",
  "isTradingHalt",
  "priceUsd",
  "priceSource",
  "liquidityUsd",
  "poolDepthUsd",
  "venues",
  "redeemable",
  "maxRedeemUsd",
  "jurisdictionBlocks",
  "signalEligible",
  "vaultEligible",
  "ineligibleReasons",
  "refreshedAt",
] as const satisfies readonly (keyof NewUniverseRecord)[];

export interface UniverseRefreshSummary {
  startedAt: string;
  durationMs: number;
  /** False when `/rhj/assets` could not be read. Every row is downgraded. */
  registryReachable: boolean;
  /** Rows written this cycle. */
  rows: number;
  /** Rows in the table that this cycle did not see, marked non-eligible. */
  delisted: number;
  signalEligible: number;
  vaultEligible: number;
  withChainlinkFeed: number;
  priced: number;
  multiplierMismatches: number;
  /** Symbols `/rhj/prices` could not answer for. */
  quoteFailures: number;
  /** JSON-RPC requests the cycle made. The batching budget, measured. */
  rpcRequests: number;
}

// --- Multicall narrowing ----------------------------------------------------
// A heterogeneous batch types as a union, so each read is narrowed where it is
// used. A reverted read is null, never a substituted zero: an unreadable value
// and a zero value lead to opposite eligibility decisions.

function asBigint(item: MulticallItem<unknown> | undefined): bigint | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  return typeof value === "bigint" ? value : null;
}

function asBool(item: MulticallItem<unknown> | undefined): boolean | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  return typeof value === "boolean" ? value : null;
}

function asNumber(item: MulticallItem<unknown> | undefined): number | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  return typeof value === "number" ? value : null;
}

function asAddress(item: MulticallItem<unknown> | undefined): Address | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

// --- The cycle --------------------------------------------------------------

interface Candidate {
  asset: RhjAsset;
  address: Address;
  uid: Hex | null;
}

/**
 * Assets on RHC mainnet, with their canonical-per-registry address.
 *
 * A uid that is not a bytes32 cannot be put to the factory at all, so it is
 * carried through as `null` and becomes a named reason rather than a skipped
 * row. Silence is the one outcome this gate never produces.
 */
function toCandidates(assets: readonly RhjAsset[]): Candidate[] {
  const candidates: Candidate[] = [];

  for (const asset of assets) {
    const deployment = asset.deployments.find((entry) => entry.chainId === env.RHC_CHAIN_ID);
    if (!deployment || !isAddress(deployment.contractAddress)) continue;

    candidates.push({
      asset,
      address: getAddress(deployment.contractAddress),
      uid: BYTES32.test(asset.uid) ? (asset.uid as Hex) : null,
    });
  }

  return candidates;
}

/**
 * Every row goes non-eligible with the reason named.
 *
 * This is the unreachable-registry path. Rows are downgraded, never deleted:
 * the terminal should say "we cannot verify this right now", which needs the
 * row to still be there to say it on.
 */
async function downgradeAll(now: Date): Promise<number> {
  const updated = await db
    .update(universe)
    .set({
      authentic: false,
      registrySource: "rhj-assets",
      registryCheckedAt: now,
      signalEligible: false,
      vaultEligible: false,
      ineligibleReasons: [REASONS.registryUnreachable],
      refreshedAt: now,
    })
    .returning({ tokenAddress: universe.tokenAddress });

  return updated.length;
}

/**
 * One refresh cycle. Returns a summary; throws only on a genuine defect.
 *
 * An unreachable registry is not a defect, it is a state with a defined
 * outcome, so it returns a summary with `registryReachable: false` rather than
 * failing the job and retrying into the same outage.
 */
export async function refreshUniverse(): Promise<UniverseRefreshSummary> {
  const startedAt = new Date();
  const startedMs = Date.now();

  let assets: RhjAsset[];
  try {
    assets = await fetchAssets();
  } catch (err) {
    if (!isRhjError(err)) throw err;

    const delisted = await downgradeAll(startedAt);
    log.error("registry unreachable, every row downgraded to non-eligible", {
      kind: err.kind,
      status: err.status,
      rows: delisted,
    });

    return {
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedMs,
      registryReachable: false,
      rows: 0,
      delisted,
      signalEligible: 0,
      vaultEligible: 0,
      withChainlinkFeed: 0,
      priced: 0,
      multiplierMismatches: 0,
      quoteFailures: 0,
      rpcRequests: 0,
    };
  }

  const candidates = toCandidates(assets);
  if (candidates.length === 0) {
    log.warn("registry answered with no assets on this chain", {
      assets: assets.length,
      chainId: env.RHC_CHAIN_ID,
    });
  }

  const { feeds, available: feedDirectoryAvailable, stale } = await loadFeedDirectory();
  if (stale) log.warn("serving a previous copy of the Chainlink feed directory");

  const feedFor = new Map<string, ChainlinkFeed>();
  for (const candidate of candidates) {
    const feed = feeds.get(candidate.asset.symbol.toUpperCase());
    if (feed) feedFor.set(candidate.address, feed);
  }

  // Quotes are REST, not RPC, and cover all 96 names. Run them alongside the
  // chain reads: neither depends on the other and a cycle is not a race.
  const quoteSweep = fetchQuotes(candidates.map((candidate) => candidate.asset.symbol));

  const chain = await countRpcRequests(
    async () => {
      // Pin every batch to one block so the reads inside a cycle agree with each
      // other. Costs one request and removes a class of phantom mismatch.
      const blockNumber = await publicClient.getBlockNumber();

      const factoryBatch = (await multicallRead(
        candidates
          .filter((candidate) => candidate.uid !== null)
          .map(
            (candidate) =>
              ({
                address: STOCK_FACTORY_ADDRESS,
                abi: stockFactoryAbi,
                functionName: "tokenAddress",
                args: [candidate.uid as Hex],
              }) as const,
          ),
        { client: publicClient, blockNumber },
      )) as unknown as MulticallItem<unknown>[];

      const tokenBatch = (await multicallRead(
        candidates.flatMap((candidate) => {
          const address = candidate.address;
          return [
            { address, abi: stockAbi, functionName: "totalSupply" } as const,
            { address, abi: stockAbi, functionName: "uiMultiplier" } as const,
            { address, abi: stockAbi, functionName: "newUIMultiplier" } as const,
            { address, abi: stockAbi, functionName: "effectiveAt" } as const,
            { address, abi: stockAbi, functionName: "decimals" } as const,
            { address, abi: stockAbi, functionName: "oraclePaused" } as const,
            { address, abi: stockAbi, functionName: "tokenPaused" } as const,
            { address, abi: stockAbi, functionName: "paused" } as const,
          ];
        }),
        { client: publicClient, blockNumber },
      )) as unknown as MulticallItem<unknown>[];

      const feedAddresses = [...feedFor.values()].map((feed) => feed.proxyAddress);
      const feedBatch = (
        feedAddresses.length === 0
          ? []
          : ((await multicallRead(
              feedAddresses.flatMap((address) => [
                { address, abi: aggregatorV3Abi, functionName: "latestRoundData" } as const,
                { address, abi: aggregatorV3Abi, functionName: "decimals" } as const,
              ]),
              { client: publicClient, blockNumber },
            )) as unknown as MulticallItem<unknown>[])
      ) as MulticallItem<unknown>[];

      const usdgBatch = (await multicallRead([usdgDecimalsCall()], {
        client: publicClient,
        blockNumber,
      })) as unknown as MulticallItem<unknown>[];
      const usdgDecimals = asNumber(usdgBatch[0]) ?? 18;

      const pools = await samplePoolDepth(
        candidates.map((candidate) => ({
          tokenAddress: candidate.address,
          // Stock Tokens are 18 decimals; the read below overrides this per asset
          // once it lands, and pools only need an order of magnitude.
          decimals: candidate.asset.decimals,
        })),
        { client: publicClient, blockNumber, usdgDecimals },
      );

      return { blockNumber, factoryBatch, tokenBatch, feedBatch, feedAddresses, pools };
    },
    { operation: "research-universe-refresh", context: "research", priority: "background" },
  );

  const { factoryBatch, tokenBatch, feedBatch, feedAddresses, pools } = chain.value;
  const { quotes, failures } = await quoteSweep;

  if (failures.length > 0) {
    log.warn("some quotes failed this cycle", {
      count: failures.length,
      symbols: failures.slice(0, 10).map((failure) => failure.symbol),
    });
  }

  const feedIndex = new Map<Address, number>();
  for (const [i, address] of feedAddresses.entries()) feedIndex.set(address, i);

  // The factory batch skipped candidates with an unusable uid, so it is indexed
  // separately rather than by candidate position.
  let factoryCursor = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: NewUniverseRecord[] = [];

  let signalEligible = 0;
  let vaultEligible = 0;
  let withChainlinkFeed = 0;
  let priced = 0;
  let multiplierMismatches = 0;

  for (const [i, candidate] of candidates.entries()) {
    const { asset, address } = candidate;

    const factoryAddress = candidate.uid === null ? null : asAddress(factoryBatch[factoryCursor++]);

    const base = i * 8;
    const totalSupply = asBigint(tokenBatch[base]);
    const uiMultiplier = asBigint(tokenBatch[base + 1]);
    const newUIMultiplier = asBigint(tokenBatch[base + 2]);
    const effectiveAt = asBigint(tokenBatch[base + 3]);
    const decimals = asNumber(tokenBatch[base + 4]);
    const oraclePaused = asBool(tokenBatch[base + 5]) ?? false;
    const tokenPaused = asBool(tokenBatch[base + 6]) ?? false;
    const paused = asBool(tokenBatch[base + 7]) ?? false;

    const feed = feedFor.get(address) ?? null;
    const feedSlot = feed === null ? undefined : feedIndex.get(feed.proxyAddress);
    const round = feedSlot === undefined ? null : asRoundData(feedBatch[feedSlot * 2]);
    const feedDecimals =
      feedSlot === undefined
        ? null
        : (asNumber(feedBatch[feedSlot * 2 + 1]) ?? feed?.decimals ?? null);

    const quote: RhjQuote | undefined = quotes.get(asset.symbol.toUpperCase());
    const pool = pools.get(address.toLowerCase()) ?? EMPTY_POOL_SAMPLE;

    const gate = evaluateAsset({
      authenticity: {
        tokenAddress: address,
        factoryAddress,
        registryReachable: true,
        assetStatus: asset.status,
        activeStatus: ASSET_STATUS_ACTIVE,
        totalSupply,
      },
      pricing: {
        chainlinkFeed: feed?.proxyAddress ?? null,
        answer: round?.answer ?? null,
        feedDecimals,
        uiMultiplier,
        quoteMid: quote?.mid ?? null,
        dexPriceUsd: pool.dexPriceUsd,
        tolerancePct: env.UNIVERSE_FEED_TOLERANCE_PCT,
      },
      liquidity: {
        poolDepthUsd: pool.poolDepthUsd,
        venueCount: pool.venues.length,
        depthFloorUsd: env.UNIVERSE_DEPTH_FLOOR_USD,
      },
      redeem: {
        poolDepthUsd: pool.poolDepthUsd,
        minRedeemUsd: env.UNIVERSE_MIN_REDEEM_USD,
      },
      advisory: {
        oraclePaused,
        tokenPaused,
        paused,
        isTradingHalt: quote?.isTradingHalt ?? false,
      },
      onchainMultiplier: uiMultiplier,
      registryMultiplier: asset.currentMultiplier,
      noFeedReason: feedDirectoryAvailable ? undefined : REASONS.feedDirectoryUnavailable,
    });

    const reasons = [...gate.ineligibleReasons];
    if (candidate.uid === null) reasons.unshift(REASONS.invalidUid);

    rows.push({
      tokenAddress: address,
      symbol: asset.symbol,
      name: asset.name,
      decimals: decimals ?? asset.decimals,
      onchainUid: asset.uid,
      authentic: gate.authentic,
      registrySource: gate.registrySource,
      registryCheckedAt: startedAt,
      assetStatus: asset.status,
      chainlinkFeed: feed?.proxyAddress ?? null,
      feedDecimals,
      heartbeatSec: feed?.heartbeatSec ?? null,
      maxStalenessSec: feed === null ? null : MAX_STALENESS_SEC,
      feedAgeSec: clampFeedAgeSec(nowSec, round?.updatedAt ?? null),
      quoteBid: quote?.bid ?? null,
      quoteAsk: quote?.ask ?? null,
      feedAgreesWithQuote: gate.feedAgreesWithQuote,
      uiMultiplier: uiMultiplier === null ? asset.currentMultiplier : formatFixed18(uiMultiplier),
      newUIMultiplier:
        newUIMultiplier === null ? asset.currentMultiplier : formatFixed18(newUIMultiplier),
      multiplierEffectiveAt: effectiveAt === null ? null : Number(effectiveAt),
      registryMultiplier: asset.currentMultiplier,
      multiplierMismatch: gate.multiplierMismatch,
      lastAnswer: round === null ? null : round.answer.toString(),
      lastUpdatedAt: round?.updatedAt ?? null,
      oraclePaused,
      tokenPaused,
      paused,
      isTradingHalt: quote?.isTradingHalt ?? false,
      priceUsd: gate.priceUsd,
      priceSource: gate.priceSource,
      liquidityUsd: pool.liquidityUsd,
      poolDepthUsd: pool.poolDepthUsd,
      venues: pool.venues,
      redeemable: gate.redeemable,
      maxRedeemUsd: gate.maxRedeemUsd,
      // No free source describes the issuer's country restrictions per asset.
      // Left empty rather than guessed. It is disclosure data either way and
      // nothing in this product branches on it (locked decision 4).
      jurisdictionBlocks: [],
      signalEligible: gate.signalEligible,
      vaultEligible: gate.vaultEligible,
      ineligibleReasons: reasons,
      refreshedAt: startedAt,
    });

    if (gate.signalEligible) signalEligible += 1;
    if (gate.vaultEligible) vaultEligible += 1;
    if (feed !== null) withChainlinkFeed += 1;
    if (gate.priceUsd !== null) priced += 1;
    if (gate.multiplierMismatch) multiplierMismatches += 1;
  }

  let delisted = 0;
  if (rows.length > 0) {
    await db
      .insert(universe)
      .values(rows)
      .onConflictDoUpdate({
        target: universe.tokenAddress,
        set: conflictUpdateSet(universe, REFRESHER_COLUMNS),
      });

    // A row the registry stopped listing keeps its history but loses its
    // eligibility, with the reason on it. Never a silent disappearance.
    const seen = rows.map((row) => row.tokenAddress);
    const dropped = await db
      .update(universe)
      .set({
        authentic: false,
        signalEligible: false,
        vaultEligible: false,
        ineligibleReasons: [REASONS.delisted],
        refreshedAt: startedAt,
      })
      .where(notInArray(universe.tokenAddress, seen))
      .returning({ tokenAddress: universe.tokenAddress });
    delisted = dropped.length;
  }

  const summary: UniverseRefreshSummary = {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    registryReachable: true,
    rows: rows.length,
    delisted,
    signalEligible,
    vaultEligible,
    withChainlinkFeed,
    priced,
    multiplierMismatches,
    quoteFailures: failures.length,
    rpcRequests: chain.requests,
  };

  log.info("universe refreshed", { ...summary });
  return summary;
}
