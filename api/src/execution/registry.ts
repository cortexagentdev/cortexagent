/** Durable registry for the one verified execution generation in this database. */
import { createHash } from "node:crypto";

import { and, count, eq, sql } from "drizzle-orm";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

import venueSeedJson from "../../data/venues.json";
import { db, type Db } from "../db/client.ts";
import {
  executionBindings,
  executionDiscoveryProgress,
  executionPoolObservations,
  executionPools,
  executionVenues,
  themeProposals,
  themeTokens,
} from "../db/schema.ts";
import { getExecutionContext, type ExecutionContext } from "./context.ts";

const address = z
  .string()
  .refine(isAddress, "expected a full EVM address")
  .transform((value) => getAddress(value));
const hash = z.string().regex(/^0x[\da-f]{64}$/i, "expected a 32-byte hash");
const seedSchema = z.object({
  schemaVersion: z.literal(1),
  seedVersion: z.number().int().positive(),
  source: z.string().min(1),
  venues: z
    .array(
      z.object({
        name: z.string().min(1),
        protocolVariant: z.literal("uniswap-v3-swaprouter02"),
        factory: address,
        router: address,
        quoter: address,
        deployBlock: z.string().regex(/^\d+$/).transform(BigInt),
        deployBlockHash: hash,
        supportedFees: z.array(z.union([z.literal(500), z.literal(3000)])).min(1),
        supportedIntermediates: z.array(address),
        verificationStatus: z.literal("verified"),
        verifiedSource: z.url(),
        pools: z.array(
          z.object({
            address,
            token0: address,
            token1: address,
            feePips: z.union([z.literal(500), z.literal(3000)]),
            firstSeenBlock: z.string().regex(/^\d+$/).transform(BigInt),
            firstSeenBlockHash: hash,
            provenance: z.enum(["stage-01-verified-candidate", "lens-execution-research"]),
          }),
        ),
      }),
    )
    .min(1),
});

export type VenueSeed = z.infer<typeof seedSchema>;
export type PoolObservationStatus =
  "ok" | "empty" | "uninitialized" | "read_failed" | "unsupported" | "stale";

function seedDigest(): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(venueSeedJson)).digest("hex")}`;
}

/** Strictly validates committed venue input before it can affect execution state. */
export function parseVenueSeed(value: unknown): VenueSeed {
  const seed = seedSchema.parse(value);
  const venueNames = new Set<string>();
  const poolAddresses = new Set<string>();
  for (const venue of seed.venues) {
    if (venueNames.has(venue.name)) throw new Error(`duplicate venue seed name: ${venue.name}`);
    venueNames.add(venue.name);
    for (const pool of venue.pools) {
      const key = pool.address.toLowerCase();
      if (poolAddresses.has(key)) throw new Error(`duplicate pool seed address: ${pool.address}`);
      poolAddresses.add(key);
      if (pool.token0.toLowerCase() >= pool.token1.toLowerCase()) {
        throw new Error(`pool ${pool.address} tokens are not canonical token0/token1 order`);
      }
      if (!venue.supportedFees.includes(pool.feePips)) {
        throw new Error(`pool ${pool.address} uses fee absent from venue ${venue.name}`);
      }
    }
  }
  return seed;
}

/** Loads the committed seed; callers with external input use `parseVenueSeed`. */
export function loadVenueSeed(): VenueSeed {
  return parseVenueSeed(venueSeedJson);
}

function generationFingerprint(context: ExecutionContext): string {
  return (
    context.manifest.fork?.generationId ??
    `${context.manifest.mode}:${context.manifest.chainId}:${context.manifest.deploymentId}`
  );
}

async function legacyExecutionRows(
  database: Db,
): Promise<{ themeTokens: number; themeProposals: number }> {
  const [[tokens], [proposals]] = await Promise.all([
    database.select({ value: count() }).from(themeTokens),
    database.select({ value: count() }).from(themeProposals),
  ]);
  return { themeTokens: tokens?.value ?? 0, themeProposals: proposals?.value ?? 0 };
}

/**
 * Binds a database once the manifest, RPC chain, code, and local marker are
 * verified. Populated unbound databases require explicit verified migration;
 * neither chain ID nor an unrelated binding authorizes legacy-row adoption.
 */
export async function ensureExecutionBinding(database: Db = db): Promise<ExecutionContext> {
  const context = await getExecutionContext();
  if (!context) throw new Error("Execution binding refused: execution context is not ready.");
  const deploymentId = context.manifest.deploymentId;
  const [current] = await database.select().from(executionBindings).limit(1);
  if (current) {
    if (
      current.deploymentId !== deploymentId ||
      current.mode !== context.manifest.mode ||
      current.chainId !== context.manifest.chainId ||
      current.generationFingerprint !== generationFingerprint(context)
    ) {
      throw new Error(
        "Execution binding mismatch: this nonempty database belongs to another deployment. Use the explicit local recovery workflow; no rows were changed.",
      );
    }
    return context;
  }

  const legacy = await legacyExecutionRows(database);
  if (legacy.themeTokens || legacy.themeProposals)
    throw new Error(
      "Execution binding refused: populated unbound database requires an explicit code-verified adoption migration or restoration of its original binding. Chain ID alone is not generation evidence.",
    );
  // API and worker boot concurrently after a fresh local generation. The
  // singleton insert must be idempotent across that race; a unique violation
  // here otherwise leaves one process crashing while the other has already
  // established the exact same verified binding.
  await database
    .insert(executionBindings)
    .values({
      id: 1,
      deploymentId,
      mode: context.manifest.mode,
      chainId: context.manifest.chainId,
      manifestDigest: context.manifestDigest,
      generationFingerprint: generationFingerprint(context),
    })
    .onConflictDoNothing({ target: executionBindings.id });
  const [bound] = await database.select().from(executionBindings).limit(1);
  if (
    !bound ||
    bound.deploymentId !== deploymentId ||
    bound.mode !== context.manifest.mode ||
    bound.chainId !== context.manifest.chainId ||
    bound.generationFingerprint !== generationFingerprint(context)
  ) {
    throw new Error(
      "Execution binding mismatch: another process established a different deployment. No rows were changed.",
    );
  }
  return context;
}

/** Inserts immutable seed metadata; it intentionally creates no fresh observations. */
export async function seedVerifiedVenues(database: Db = db): Promise<void> {
  const context = await ensureExecutionBinding(database);
  const seed = loadVenueSeed();
  const digest = seedDigest();
  const deploymentId = context.manifest.deploymentId;
  await database.transaction(async (tx) => {
    for (const venue of seed.venues) {
      await tx
        .insert(executionVenues)
        .values({
          deploymentId,
          name: venue.name,
          seedVersion: seed.seedVersion,
          seedDigest: digest,
          protocolVariant: venue.protocolVariant,
          factory: venue.factory.toLowerCase(),
          router: venue.router.toLowerCase(),
          quoter: venue.quoter.toLowerCase(),
          deployBlock: Number(venue.deployBlock),
          deployBlockHash: venue.deployBlockHash.toLowerCase(),
          supportedFees: venue.supportedFees,
          supportedIntermediates: venue.supportedIntermediates.map((item) => item.toLowerCase()),
          verificationStatus: venue.verificationStatus,
          verifiedSource: venue.verifiedSource,
        })
        .onConflictDoNothing();
      for (const pool of venue.pools) {
        await tx
          .insert(executionPools)
          .values({
            deploymentId,
            poolAddress: pool.address.toLowerCase(),
            venueName: venue.name,
            factory: venue.factory.toLowerCase(),
            token0: pool.token0.toLowerCase(),
            token1: pool.token1.toLowerCase(),
            feePips: pool.feePips,
            firstSeenBlock: Number(pool.firstSeenBlock),
            firstSeenBlockHash: pool.firstSeenBlockHash.toLowerCase(),
            provenance: pool.provenance,
          })
          .onConflictDoNothing();
      }
    }
  });
}

export async function upsertAuthenticatedPool(
  input: {
    venueName: string;
    factory: Address;
    poolAddress: Address;
    token0: Address;
    token1: Address;
    feePips: number;
    firstSeenBlock: bigint;
    firstSeenBlockHash: `0x${string}`;
    provenance: string;
  },
  database: Db = db,
): Promise<void> {
  const context = await ensureExecutionBinding(database);
  const deploymentId = context.manifest.deploymentId;
  const canonical = {
    ...input,
    factory: input.factory.toLowerCase(),
    poolAddress: input.poolAddress.toLowerCase(),
    token0: input.token0.toLowerCase(),
    token1: input.token1.toLowerCase(),
  };
  if (canonical.token0 >= canonical.token1)
    throw new Error("authenticated pool token order is not canonical");
  await database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(executionPools)
      .where(
        and(
          eq(executionPools.deploymentId, deploymentId),
          eq(executionPools.poolAddress, canonical.poolAddress),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.factory !== canonical.factory ||
        existing.token0 !== canonical.token0 ||
        existing.token1 !== canonical.token1 ||
        existing.feePips !== canonical.feePips ||
        existing.venueName !== input.venueName
      )
        throw new Error(
          `pool identity mismatch for ${input.poolAddress}; refusing silent factory move`,
        );
      await tx
        .update(executionPools)
        .set({ authenticated: true, authenticatedAt: new Date() })
        .where(
          and(
            eq(executionPools.deploymentId, deploymentId),
            eq(executionPools.poolAddress, canonical.poolAddress),
          ),
        );
      return;
    }
    await tx.insert(executionPools).values({
      deploymentId,
      poolAddress: canonical.poolAddress,
      venueName: input.venueName,
      factory: canonical.factory,
      token0: canonical.token0,
      token1: canonical.token1,
      feePips: input.feePips,
      firstSeenBlock: Number(input.firstSeenBlock),
      firstSeenBlockHash: input.firstSeenBlockHash.toLowerCase(),
      provenance: input.provenance,
      authenticated: true,
      authenticatedAt: new Date(),
    });
  });
}

export async function supportedPoolCandidates(database: Db = db) {
  const context = await ensureExecutionBinding(database);
  return database
    .select()
    .from(executionPools)
    .where(eq(executionPools.deploymentId, context.manifest.deploymentId));
}

/** Progress is committed only after the corresponding discovery writes succeed. */
export async function writeDiscoveryProgress(
  input: {
    venueName: string;
    queryScope: string;
    coverageStatus: "complete_for_supported_candidates" | "partial" | "unknown";
    reconciliationPosition?: string;
    lastSuccessfulBlock?: bigint;
    lastSuccessfulBlockHash?: `0x${string}`;
    lastError?: string;
  },
  database: Db = db,
): Promise<void> {
  const context = await ensureExecutionBinding(database);
  await database
    .insert(executionDiscoveryProgress)
    .values({
      deploymentId: context.manifest.deploymentId,
      venueName: input.venueName,
      queryScope: input.queryScope,
      coverageStatus: input.coverageStatus,
      reconciliationPosition: input.reconciliationPosition,
      lastSuccessfulBlock:
        input.lastSuccessfulBlock === undefined ? undefined : Number(input.lastSuccessfulBlock),
      lastSuccessfulBlockHash: input.lastSuccessfulBlockHash?.toLowerCase(),
      lastSuccessfulAt: input.lastSuccessfulBlock ? new Date() : undefined,
      lastError: input.lastError,
    })
    .onConflictDoUpdate({
      target: [
        executionDiscoveryProgress.deploymentId,
        executionDiscoveryProgress.venueName,
        executionDiscoveryProgress.queryScope,
      ],
      set: {
        coverageStatus: input.coverageStatus,
        reconciliationPosition: input.reconciliationPosition,
        lastSuccessfulBlock:
          input.lastSuccessfulBlock === undefined ? undefined : Number(input.lastSuccessfulBlock),
        lastSuccessfulBlockHash: input.lastSuccessfulBlockHash?.toLowerCase(),
        lastSuccessfulAt: input.lastSuccessfulBlock ? new Date() : undefined,
        lastError: input.lastError,
      },
    });
}

export async function writeCurrentObservation(
  input:
    | { poolAddress: Address; failure: string; observedAt?: Date }
    | {
        poolAddress: Address;
        blockNumber: bigint;
        blockHash: `0x${string}`;
        blockTimestamp: bigint;
        status: Exclude<PoolObservationStatus, "stale">;
        reserve0Raw?: bigint;
        reserve1Raw?: bigint;
        sqrtPriceX96?: bigint;
        tick?: number;
        liquidityRaw?: bigint;
        tvlUsd?: number | null;
        observedAt?: Date;
      },
  database: Db = db,
): Promise<void> {
  const context = await ensureExecutionBinding(database);
  const deploymentId = context.manifest.deploymentId;
  const poolAddress = input.poolAddress.toLowerCase();
  if ("failure" in input) {
    const [previous] = await database
      .select()
      .from(executionPoolObservations)
      .where(
        and(
          eq(executionPoolObservations.deploymentId, deploymentId),
          eq(executionPoolObservations.poolAddress, poolAddress),
        ),
      )
      .limit(1);
    if (!previous)
      throw new Error(
        `cannot record a failed read before an observation exists for ${input.poolAddress}`,
      );
    await database
      .update(executionPoolObservations)
      .set({
        status: "read_failed",
        lastError: input.failure,
        observedAt: input.observedAt ?? new Date(),
      })
      .where(
        and(
          eq(executionPoolObservations.deploymentId, deploymentId),
          eq(executionPoolObservations.poolAddress, poolAddress),
        ),
      );
    return;
  }
  const now = input.observedAt ?? new Date();
  await database
    .insert(executionPoolObservations)
    .values({
      deploymentId,
      poolAddress,
      blockNumber: Number(input.blockNumber),
      blockHash: input.blockHash.toLowerCase(),
      blockTimestamp: Number(input.blockTimestamp),
      status: input.status,
      reserve0Raw: input.reserve0Raw,
      reserve1Raw: input.reserve1Raw,
      sqrtPriceX96: input.sqrtPriceX96,
      tick: input.tick,
      liquidityRaw: input.liquidityRaw,
      tvlUsd: input.tvlUsd,
      lastSuccessAt: now,
      observedAt: now,
    })
    .onConflictDoUpdate({
      target: [executionPoolObservations.deploymentId, executionPoolObservations.poolAddress],
      set: {
        blockNumber: Number(input.blockNumber),
        blockHash: input.blockHash.toLowerCase(),
        blockTimestamp: Number(input.blockTimestamp),
        status: input.status,
        reserve0Raw: input.reserve0Raw,
        reserve1Raw: input.reserve1Raw,
        sqrtPriceX96: input.sqrtPriceX96,
        tick: input.tick,
        liquidityRaw: input.liquidityRaw,
        tvlUsd: input.tvlUsd,
        lastSuccessAt: now,
        lastError: null,
        observedAt: now,
      },
    });
}

export async function registryStatus(database: Db = db) {
  const context = await ensureExecutionBinding(database);
  const deploymentId = context.manifest.deploymentId;
  const [binding] = await database
    .select()
    .from(executionBindings)
    .where(eq(executionBindings.id, 1));
  const [pools, observations, progress] = await Promise.all([
    database
      .select({ status: executionPools.authenticated, count: count() })
      .from(executionPools)
      .where(eq(executionPools.deploymentId, deploymentId))
      .groupBy(executionPools.authenticated),
    database
      .select({
        status: executionPoolObservations.status,
        count: count(),
        oldest: sql<Date | null>`min(${executionPoolObservations.observedAt})`,
        newest: sql<Date | null>`max(${executionPoolObservations.observedAt})`,
      })
      .from(executionPoolObservations)
      .where(eq(executionPoolObservations.deploymentId, deploymentId))
      .groupBy(executionPoolObservations.status),
    database
      .select()
      .from(executionDiscoveryProgress)
      .where(eq(executionDiscoveryProgress.deploymentId, deploymentId)),
  ]);
  return {
    binding: binding && {
      deploymentId: binding.deploymentId,
      mode: binding.mode,
      chainId: binding.chainId,
      manifestDigest: binding.manifestDigest,
      adoptedAt: binding.adoptedAt,
    },
    pools,
    observations,
    progress,
  };
}
