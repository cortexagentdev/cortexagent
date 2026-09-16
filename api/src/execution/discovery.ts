/** Bounded, targeted discovery for the single verified Uniswap V3 venue. */
import type { Address } from "viem";

import { readFactoryPools, readPoolMetadata } from "../chain/pool-reads.ts";
import { env } from "../env.ts";
import {
  loadVenueSeed,
  upsertAuthenticatedPool,
  writeDiscoveryProgress,
  type VenueSeed,
} from "./registry.ts";
import { getExecutionContext, type ExecutionContext } from "./context.ts";
import { sampleExecutionPoolState } from "./pool-state.ts";

export const DISCOVERY_INTERVAL_MS = env.EXECUTION_DISCOVERY_INTERVAL_MS;
export const POOL_STATE_INTERVAL_MS = env.EXECUTION_POOL_STATE_INTERVAL_MS;
const QUERY_SCOPE = "targeted-supported-pairs:v1";

export type DiscoveryResult = {
  candidates: number;
  authenticated: number;
  rejected: number;
  failures: number;
  blockNumber: bigint;
  blockHash: `0x${string}`;
};

type AuthenticatedPoolInput = Parameters<typeof upsertAuthenticatedPool>[0];
type DiscoveryProgressInput = Parameters<typeof writeDiscoveryProgress>[0];

/** External writes are injected by isolated callers while production uses the registry module. */
export interface DiscoveryRegistry {
  upsertAuthenticatedPool(input: AuthenticatedPoolInput): Promise<void>;
  writeDiscoveryProgress(input: DiscoveryProgressInput): Promise<void>;
}

export interface ReconcileOptions {
  /** A verified context selected by the caller; otherwise the normal context seam is used. */
  context?: ExecutionContext;
  /** Committed seed by default; injectable for isolated fixtures. */
  seed?: VenueSeed;
  /** Keeps candidate-budget behavior bounded while allowing isolated budget tests. */
  maxCandidates?: number;
  /** Registry adapter; production writes use the durable registry implementation. */
  registry?: DiscoveryRegistry;
}

/**
 * Reconciles only committed, supported token/fee candidates. It deliberately
 * does not enumerate the DEX universe or replay factory logs from genesis.
 */
export async function reconcileSupportedPools(
  options: ReconcileOptions = {},
): Promise<DiscoveryResult> {
  const context = options.context ?? (await getExecutionContext());
  if (!context) throw new Error("execution context is not ready");
  const seed = options.seed ?? loadVenueSeed();
  const registry: DiscoveryRegistry = options.registry ?? {
    upsertAuthenticatedPool,
    writeDiscoveryProgress,
  };
  const block = await context.publicClient.getBlock();
  if (block.number === null || !block.hash) throw new Error("execution head is incomplete");
  let authenticated = 0;
  let rejected = 0;
  let failures = 0;
  let candidates = 0;
  let remainingBudget = options.maxCandidates ?? env.EXECUTION_DISCOVERY_MAX_CANDIDATES;

  for (const venue of seed.venues) {
    let venueFailures = 0;
    let lastIssue: string | undefined;
    let venueAuthenticated = 0;
    const pairs = new Map<
      string,
      {
        token0: Address;
        token1: Address;
        feePips: number;
        factory: Address;
      }
    >();
    for (const pool of venue.pools) {
      // Seeded token pairs are the authentic supported set. The factory remains
      // authoritative for the currently executable pool address.
      const key = `${pool.token0.toLowerCase()}:${pool.token1.toLowerCase()}:${pool.feePips}`;
      pairs.set(key, {
        factory: venue.factory,
        token0: pool.token0,
        token1: pool.token1,
        feePips: pool.feePips,
      });
    }
    const boundedPairs = [...pairs.values()].slice(0, remainingBudget);
    remainingBudget -= boundedPairs.length;
    const budgetExhausted = boundedPairs.length < pairs.size;
    candidates += boundedPairs.length;

    // The factory is authoritative for the currently executable pool address.
    // Multicall keeps each candidate associated with its pair; a failed or
    // malformed item never shifts a healthy sibling's result.
    const lookupResults = await readFactoryPools(boundedPairs, {
      client: context.publicClient,
      blockNumber: block.number,
    });
    const codeCandidates: Array<{ pair: (typeof boundedPairs)[number]; pool: Address }> = [];
    for (const [index, pair] of boundedPairs.entries()) {
      const lookup = lookupResults[index];
      if (!lookup || lookup.status === "failure") {
        failures += 1;
        venueFailures += 1;
        lastIssue = `retryable pool authentication read failure at fee ${pair.feePips}`;
        continue;
      }
      if (lookup.status === "empty") {
        rejected += 1;
        lastIssue = `no pool for supported pair at fee ${pair.feePips}`;
        continue;
      }
      try {
        const code = await context.publicClient.getCode({
          address: lookup.pool,
          blockNumber: block.number,
        });
        if (!code || code === "0x") {
          rejected += 1;
          lastIssue = `factory returned pool without code: ${lookup.pool}`;
          continue;
        }
        codeCandidates.push({ pair, pool: lookup.pool });
      } catch {
        // Runtime-code presence remains an independent authentication check.
        failures += 1;
        venueFailures += 1;
        lastIssue = `retryable pool authentication read failure at fee ${pair.feePips}`;
      }
    }

    // Four immutable identity getters are one block-pinned batch. The helper
    // returns one result per pool even when a sibling getter reverts.
    const metadataResults = await readPoolMetadata(
      codeCandidates.map(({ pool }) => ({ pool })),
      { client: context.publicClient, blockNumber: block.number },
    );
    for (const [index, candidate] of codeCandidates.entries()) {
      const metadata = metadataResults[index];
      if (!metadata || metadata.status === "failure") {
        failures += 1;
        venueFailures += 1;
        lastIssue = `retryable pool authentication read failure at fee ${candidate.pair.feePips}`;
        continue;
      }
      if (
        metadata.factory.toLowerCase() !== venue.factory.toLowerCase() ||
        metadata.token0.toLowerCase() !== candidate.pair.token0.toLowerCase() ||
        metadata.token1.toLowerCase() !== candidate.pair.token1.toLowerCase() ||
        metadata.feePips !== candidate.pair.feePips
      ) {
        rejected += 1;
        lastIssue = `unsupported pool variant: ${candidate.pool}`;
        continue;
      }
      try {
        await registry.upsertAuthenticatedPool({
          venueName: venue.name,
          factory: venue.factory,
          poolAddress: candidate.pool,
          token0: metadata.token0,
          token1: metadata.token1,
          feePips: metadata.feePips,
          firstSeenBlock: block.number,
          firstSeenBlockHash: block.hash,
          provenance: "targeted-factory-reconciliation",
        });
        authenticated += 1;
        venueAuthenticated += 1;
      } catch {
        // Registry/write failures leave coverage partial; they are not missing pools.
        failures += 1;
        venueFailures += 1;
        lastIssue = `retryable pool authentication read failure at fee ${candidate.pair.feePips}`;
      }
    }
    await registry.writeDiscoveryProgress({
      venueName: venue.name,
      queryScope: QUERY_SCOPE,
      coverageStatus:
        venueFailures || budgetExhausted ? "partial" : "complete_for_supported_candidates",
      reconciliationPosition: `${venueAuthenticated}/${boundedPairs.length}`,
      lastSuccessfulBlock: venueFailures ? undefined : block.number,
      lastSuccessfulBlockHash: venueFailures ? undefined : block.hash,
      lastError: lastIssue,
    });
  }
  return {
    candidates,
    authenticated,
    rejected,
    failures,
    blockNumber: block.number,
    blockHash: block.hash,
  };
}

/** One bounded worker cycle: authenticate supported candidates, then sample them. */
export async function runDiscoveryCycle() {
  const discovery = await reconcileSupportedPools();
  const context = await getExecutionContext();
  if (!context) throw new Error("execution context is not ready");
  const state = await sampleExecutionPoolState(context);
  return { discovery, state };
}
