/**
 * Gate 2 and Gate 3 inputs: pool depth from direct pool reads.
 *
 * Depth comes from reading the pools themselves through Multicall3, never from
 * an aggregator API (locked decision 8). 0x exists in this product for C2
 * rebalance routing and nothing else.
 *
 * Research candidates come from the verified venue seed, while every actual
 * read below explicitly uses the live-mainnet research client. Execution rows
 * and fork observations are never used as a research fallback.
 *
 * ## What is measured, and what is not
 *
 * - **v2-style pairs** (`getReserves`) quoted in USDG give a real number: the
 *   USD side of the reserves is the pool's USD depth, and doubling it is the
 *   pool's total value.
 * - **v3-style pools** (`slot0`) are recorded as venues but contribute no
 *   depth. Concentrated liquidity needs `liquidity()` plus tick math to turn a
 *   price into a depth, and that belongs with BE-16, which already owns pool
 *   depth over time. Recording the venue with zero depth is the conservative
 *   direction: it can only understate liquidity, never overstate it.
 * - **Pairs quoted in anything but USDG** are counted in `unpricedVenues`. We
 *   would need a price for the quote token to value them, and inventing one is
 *   how a depth number becomes fiction.
 */

import { isAddress, type Address, type PublicClient } from "viem";

import { poolAbi, stockAbi } from "../chain/abis/index.ts";
import { USDG_ADDRESS } from "../chain/addresses.ts";
import { publicClient } from "../chain/client.ts";
import {
  readFactoryPools,
  type FactoryPoolCandidate,
  type FactoryPoolResult,
} from "../chain/pool-reads.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { loadVenueSeed } from "../execution/registry.ts";

/** Token address (lowercase) to the pools sampled for it. */
export type VenueRegistry = Map<string, Address[]>;
const researchFactoryLookup = new Map<
  string,
  { factory: Address; token0: Address; token1: Address; feePips: number }
>();

function loadRegistry(): VenueRegistry {
  // Research uses mainnet `publicClient` below. These addresses are immutable
  // verified candidate metadata only, never execution observations or depth.
  const registry: VenueRegistry = new Map();
  for (const venue of loadVenueSeed().venues)
    for (const pool of venue.pools) {
      researchFactoryLookup.set(pool.address.toLowerCase(), {
        factory: venue.factory,
        token0: pool.token0,
        token1: pool.token1,
        feePips: pool.feePips,
      });
      for (const token of [pool.token0, pool.token1]) {
        const key = token.toLowerCase();
        registry.set(key, [...(registry.get(key) ?? []), pool.address]);
      }
    }
  return registry;
}

export const venueRegistry: VenueRegistry = loadRegistry();

export interface PoolSample {
  /** Pools actually read this cycle. */
  venues: Address[];
  /** Sum of USD depth across priced venues. */
  liquidityUsd: number;
  /** Deepest single venue, which is what one redeem realistically clears
   *  against. A redeem does not get to add two pools together without paying
   *  the price impact of both. */
  poolDepthUsd: number;
  /** Mid price implied by the deepest priced venue, or null. */
  dexPriceUsd: number | null;
  /** Venues read but not valued: v3 pools, and pairs not quoted in USDG. */
  unpricedVenues: number;
}

export const EMPTY_POOL_SAMPLE: PoolSample = {
  venues: [],
  liquidityUsd: 0,
  poolDepthUsd: 0,
  dexPriceUsd: null,
  unpricedVenues: 0,
};

export interface PoolSampleTarget {
  tokenAddress: Address;
  decimals: number;
}

interface PoolRead {
  token: string;
  tokenDecimals: number;
  seededPool: Address;
  pool: Address;
}

export interface PoolSampleOptions {
  /** Research client. Execution contexts must never be used for this path. */
  client?: PublicClient;
  blockNumber?: bigint;
  usdgDecimals?: number;
  batchSize?: number;
}

/**
 * Samples every configured venue in one Multicall3 batch.
 *
 * Returns an empty map without touching the RPC when no venue is configured,
 * which is the current state. That is deliberate: an empty registry must cost
 * zero requests, not a batch of zero calls.
 */
export async function samplePoolDepth(
  targets: readonly PoolSampleTarget[],
  options: PoolSampleOptions = {},
): Promise<Map<string, PoolSample>> {
  const reads: PoolRead[] = [];
  for (const target of targets) {
    const key = target.tokenAddress.toLowerCase();
    for (const pool of venueRegistry.get(key) ?? []) {
      reads.push({ token: key, tokenDecimals: target.decimals, seededPool: pool, pool });
    }
  }

  if (reads.length === 0) return new Map();

  const client = options.client ?? publicClient;
  const lookupByKey = new Map<string, { candidate: FactoryPoolCandidate; reads: PoolRead[] }>();
  for (const read of reads) {
    const candidate = researchFactoryLookup.get(read.seededPool.toLowerCase());
    if (!candidate) continue;
    const key = [candidate.factory, candidate.token0, candidate.token1, candidate.feePips]
      .map((part) => part.toString().toLowerCase())
      .join(":");
    const group = lookupByKey.get(key);
    if (group) group.reads.push(read);
    else lookupByKey.set(key, { candidate, reads: [read] });
  }
  if (lookupByKey.size === 0) return new Map();

  // If the caller did not provide a block, resolve one head exactly once and
  // use it for both the factory lookup and the pool-state batch below.
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const lookupGroups = [...lookupByKey.values()];
  const lookupResults = await readFactoryPools(
    lookupGroups.map(({ candidate }) => candidate),
    { client, blockNumber, batchSize: options.batchSize },
  );

  // A failed lookup is unknown coverage, not a missing pool, and never falls
  // back to the seeded/fork address. Fan each result back to every target that
  // shared its exact factory/token/fee tuple, then walk the original reads so
  // duplicate/shared-target associations retain their pre-batch ordering.
  const resultByRead = new Map<PoolRead, FactoryPoolResult>();
  for (const [index, group] of lookupGroups.entries()) {
    const result = lookupResults[index];
    if (!result) continue;
    for (const read of group.reads) resultByRead.set(read, result);
  }
  const activeReads: PoolRead[] = [];
  for (const read of reads) {
    const result = resultByRead.get(read);
    if (!result || result.status !== "success") continue;
    activeReads.push({ ...read, pool: result.pool });
  }
  if (activeReads.length === 0) return new Map();

  // Three reads per pool. A v3 pool reverts on getReserves, which is the
  // per-call failure the multicall helper exists to absorb: the pool is still
  // recorded as a venue, it just contributes no depth.
  const results = (await multicallRead(
    activeReads.flatMap((read) => [
      { address: read.pool, abi: poolAbi, functionName: "token0" } as const,
      { address: read.pool, abi: poolAbi, functionName: "token1" } as const,
      { address: read.pool, abi: poolAbi, functionName: "getReserves" } as const,
    ]),
    {
      client,
      blockNumber,
      batchSize: options.batchSize,
    },
  )) as unknown as MulticallItem<unknown>[];

  const usdgDecimals = options.usdgDecimals ?? 18;
  const usdg = USDG_ADDRESS.toLowerCase();
  const samples = new Map<string, PoolSample>();

  for (const [i, read] of activeReads.entries()) {
    const token0 = readAddress(results[i * 3]);
    const token1 = readAddress(results[i * 3 + 1]);
    const reserves = readReserves(results[i * 3 + 2]);

    const sample = samples.get(read.token) ?? { ...EMPTY_POOL_SAMPLE, venues: [] };
    sample.venues = [...sample.venues, read.pool];

    const valued = valuePool({
      token: read.token,
      tokenDecimals: read.tokenDecimals,
      token0,
      token1,
      reserves,
      usdg,
      usdgDecimals,
    });

    if (valued === null) {
      sample.unpricedVenues += 1;
    } else {
      sample.liquidityUsd += valued.depthUsd;
      if (valued.depthUsd > sample.poolDepthUsd) {
        sample.poolDepthUsd = valued.depthUsd;
        sample.dexPriceUsd = valued.priceUsd;
      }
    }

    samples.set(read.token, sample);
  }

  return samples;
}

/**
 * Multicall gives a union across a heterogeneous batch, so each read is narrowed
 * at the point of use. A reverted or unexpected result is `undefined`, never a
 * substituted zero.
 */
function readAddress(item: MulticallItem<unknown> | undefined): Address | undefined {
  if (!item) return undefined;
  const value = resultOrUndefined(item);
  return typeof value === "string" && isAddress(value) ? (value as Address) : undefined;
}

function readReserves(
  item: MulticallItem<unknown> | undefined,
): readonly [bigint, bigint, number] | undefined {
  if (!item) return undefined;
  const value = resultOrUndefined(item);
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [reserve0, reserve1] = value as unknown[];
  if (typeof reserve0 !== "bigint" || typeof reserve1 !== "bigint") return undefined;
  return [reserve0, reserve1, 0];
}

/**
 * USD depth and implied price for one constant-product pair quoted in USDG.
 *
 * Returns null when the pool is not a v2 pair, is not quoted in USDG, or holds
 * no reserves. Null means "not valued", and the caller counts it rather than
 * folding a zero into the depth, so an unsupported venue can never look like an
 * empty one.
 */
function valuePool(input: {
  token: string;
  tokenDecimals: number;
  token0: Address | undefined;
  token1: Address | undefined;
  reserves: readonly [bigint, bigint, number] | undefined;
  usdg: string;
  usdgDecimals: number;
}): { depthUsd: number; priceUsd: number | null } | null {
  const { token0, token1, reserves } = input;
  if (!token0 || !token1 || !reserves) return null;

  const zero = token0.toLowerCase();
  const one = token1.toLowerCase();

  const assetIsZero = zero === input.token;
  const assetIsOne = one === input.token;
  if (!assetIsZero && !assetIsOne) return null;

  const quote = assetIsZero ? one : zero;
  if (quote !== input.usdg) return null;

  const assetReserve = assetIsZero ? reserves[0] : reserves[1];
  const quoteReserve = assetIsZero ? reserves[1] : reserves[0];
  if (assetReserve <= 0n || quoteReserve <= 0n) return null;

  const quoteUsd = Number(quoteReserve) / 10 ** input.usdgDecimals;
  const assetUnits = Number(assetReserve) / 10 ** input.tokenDecimals;
  if (!Number.isFinite(quoteUsd) || !Number.isFinite(assetUnits) || assetUnits <= 0) return null;

  return {
    // Both sides of a constant-product pair are worth the same, so the USD side
    // doubled is the pool's total value.
    depthUsd: quoteUsd * 2,
    priceUsd: quoteUsd / assetUnits,
  };
}

/** `decimals()` on USDG, so pool reserves are scaled by a read value. */
export function usdgDecimalsCall() {
  return { address: USDG_ADDRESS, abi: stockAbi, functionName: "decimals" } as const;
}

/** True when at least one venue is configured. Used to keep the batch off the
 *  RPC entirely while the registry is empty. */
export function hasConfiguredVenues(): boolean {
  return venueRegistry.size > 0;
}
