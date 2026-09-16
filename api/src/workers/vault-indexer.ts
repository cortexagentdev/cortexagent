/**
 * Canonical execution indexer for factory versions and their vaults.
 *
 * The indexer is deliberately execution-bound. It never uses the research RPC,
 * never scans a historical research cursor, and never treats a factory event
 * as proof that a permissionless theme is executable.
 */

import { and, count, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";

import { keylessVaultAbi, keylessVaultEventsAbi } from "../chain/abis/index.ts";
import { multicallRead, type MulticallItem } from "../chain/multicall.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { decodeNavIndicative, decodeUint, fromWad, WAD } from "../chain/vault-reads.ts";
import { db } from "../db/client.ts";
import { conflictUpdateSet } from "../db/upsert.ts";
import {
  executionBindings,
  executionEvents,
  executionIndexerCheckpoints,
  executionIndexerState,
  executionDiscoveryProgress,
  executionPoolObservations,
  executionPools,
  flows,
  navHistory,
  rebalances,
  themeProposals,
  themeTokens,
  type NewFlowRecord,
  type NewRebalanceRecord,
  type NewThemeTokenRecord,
} from "../db/schema.ts";
import { env } from "../env.ts";
import { ensureExecutionBinding } from "../execution/registry.ts";
import {
  getExecutionContext,
  type ExecutionContext,
  type ExecutionManifest,
} from "../execution/context.ts";
import { registeredPresetReceipts } from "../execution/preset-receipts.ts";
import {
  loadVerifiedPresetReceipts,
  syncPresetRecords,
} from "../execution/preset-registry-store.ts";
import { logger } from "../lib/logger.ts";

const log = logger.child({ module: "vault-indexer" });

export const VAULT_INDEX_INTERVAL_MS = 60_000;

const CONFIRMATIONS = env.VAULT_INDEXER_CONFIRMATIONS;
const CHUNK_BLOCKS = env.VAULT_INDEXER_CHUNK_BLOCKS;
const MAX_CHUNKS_PER_RUN = env.VAULT_INDEXER_MAX_CHUNKS_PER_RUN;
const START_BLOCK = env.VAULT_INDEXER_START_BLOCK;
const CHECKPOINT_RETENTION = env.VAULT_INDEXER_CHECKPOINT_RETENTION;
const LOG_ADDRESS_BATCH = 50;
const ALL_FACTORY_ADDRESS = "0x0000000000000000000000000000000000000000";
const ALL_FACTORY_VERSION = "all";

type IndexedFactory = {
  address: Address;
  version: string;
  startBlock: number;
  manifest: ExecutionManifest["factories"][number];
};

type RawLog = {
  address: string;
  blockNumber: bigint | null;
  blockHash?: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  eventName: string;
  args: Record<string, unknown>;
};

type Reimbursement = {
  paidWei: bigint | null;
  skippedWei: bigint | null;
  skipReason: number | null;
};

type VaultMeta = { tokenId: string; decimals: number };
type HistoricalNav = { value: number | null; reason: string | null };

export interface VaultIndexSummary {
  startedAt: string;
  durationMs: number;
  factoryConfigured: boolean;
  firstRun: boolean;
  startBlock: number;
  fromBlock: number;
  toBlock: number;
  head: number;
  lagBlocks: number;
  chunks: number;
  themesIndexed: number;
  flowsIndexed: number;
  rebalancesIndexed: number;
  cappedByMaxChunks: boolean;
  status: "healthy" | "degraded";
  degradedReason: string | null;
  rpcRequests: number;
}

function emptySummary(now: Date, startedMs: number): VaultIndexSummary {
  return {
    startedAt: now.toISOString(),
    durationMs: Date.now() - startedMs,
    factoryConfigured: false,
    firstRun: false,
    startBlock: 0,
    fromBlock: 0,
    toBlock: 0,
    head: 0,
    lagBlocks: 0,
    chunks: 0,
    themesIndexed: 0,
    flowsIndexed: 0,
    rebalancesIndexed: 0,
    cappedByMaxChunks: false,
    status: "healthy",
    degradedReason: null,
    rpcRequests: 0,
  };
}

const lc = (value: string): string => value.toLowerCase();

function arg<T>(entry: RawLog, name: string): T {
  return entry.args[name] as T;
}

function factoryStartBlock(factory: ExecutionManifest["factories"][number]): number {
  return factory.creationBlock === undefined ? START_BLOCK : Number(factory.creationBlock);
}

function manifestFactories(context: ExecutionContext): IndexedFactory[] {
  return context.manifest.factories.map((factory) => ({
    address: getAddress(factory.address),
    version: factory.version ?? factory.runtimeHash,
    startBlock: Math.max(0, factoryStartBlock(factory)),
    manifest: factory,
  }));
}

async function blockInfo(
  client: PublicClient,
  cache: Map<number, { timestamp: bigint; hash: Hex }>,
  blockNumber: number,
): Promise<{ timestamp: bigint; hash: Hex }> {
  const hit = cache.get(blockNumber);
  if (hit) return hit;
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  if (!block.hash) throw new Error(`execution block ${blockNumber} has no hash`);
  const value = { timestamp: block.timestamp, hash: block.hash };
  cache.set(blockNumber, value);
  return value;
}

/** Retry a range with progressively smaller subranges for provider limits. */
async function adaptiveLogs(
  fromBlock: number,
  toBlock: number,
  request: (from: number, to: number) => Promise<RawLog[]>,
): Promise<RawLog[]> {
  const output: RawLog[] = [];
  let cursor = fromBlock;
  let width = Math.max(1, toBlock - fromBlock + 1);
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + width - 1);
    try {
      output.push(...(await request(cursor, end)));
      cursor = end + 1;
    } catch (error) {
      if (width === 1) throw error;
      width = Math.max(1, Math.floor(width / 2));
      log.warn("execution log range reduced after provider failure", {
        fromBlock: cursor,
        toBlock: end,
        nextWidth: width,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return output;
}

async function vaultLogs(
  context: ExecutionContext,
  vaults: Address[],
  fromBlock: number,
  toBlock: number,
): Promise<RawLog[]> {
  const output: RawLog[] = [];
  for (let offset = 0; offset < vaults.length; offset += LOG_ADDRESS_BATCH) {
    const batch = vaults.slice(offset, offset + LOG_ADDRESS_BATCH);
    output.push(
      ...(await adaptiveLogs(fromBlock, toBlock, async (from, to) => {
        const result = await context.logsClient.getLogs({
          address: batch,
          events: keylessVaultEventsAbi,
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
          strict: true,
        });
        return result as unknown as RawLog[];
      })),
    );
  }
  return output;
}

async function loadKnownVaults(deploymentId: string): Promise<Map<string, VaultMeta>> {
  const rows = await db
    .select({ id: themeTokens.id, vault: themeTokens.vault, spec: themeTokens.spec })
    .from(themeTokens)
    .where(
      and(eq(themeTokens.executionDeploymentId, deploymentId), eq(themeTokens.canonical, true)),
    );
  const map = new Map<string, VaultMeta>();
  for (const row of rows) map.set(lc(row.vault), { tokenId: row.id, decimals: row.spec.decimals });
  return map;
}

interface ChunkResult {
  toBlockHash: Hex;
  themeTokenRows: NewThemeTokenRecord[];
  flowRows: NewFlowRecord[];
  rebalanceRows: NewRebalanceRecord[];
  eventRows: (typeof executionEvents.$inferInsert)[];
}

async function resolveHistoricalNav(
  context: ExecutionContext,
  pairs: readonly { vault: Address; block: number }[],
): Promise<Map<string, HistoricalNav>> {
  const out = new Map<string, HistoricalNav>();
  const byBlock = new Map<number, Address[]>();
  for (const pair of pairs) {
    const list = byBlock.get(pair.block) ?? [];
    if (!list.some((address) => lc(address) === lc(pair.vault))) list.push(pair.vault);
    byBlock.set(pair.block, list);
  }
  for (const [block, vaults] of byBlock) {
    try {
      const calls = vaults.flatMap(
        (vault) =>
          [
            { address: vault, abi: keylessVaultAbi, functionName: "navPerShare" },
            { address: vault, abi: keylessVaultAbi, functionName: "navIndicative" },
          ] as const,
      );
      const results = (await multicallRead(calls, {
        client: context.publicClient,
        blockNumber: BigInt(block),
      })) as unknown as MulticallItem<unknown>[];
      vaults.forEach((vault, index) => {
        const strict = decodeUint(results[index * 2]);
        const indicative = decodeNavIndicative(results[index * 2 + 1]);
        out.set(`${lc(vault)}:${block}`, {
          value:
            strict !== null
              ? fromWad(strict)
              : indicative !== null
                ? fromWad(indicative.value)
                : null,
          reason: strict !== null || indicative !== null ? null : "HISTORICAL_STATE_UNAVAILABLE",
        });
      });
    } catch {
      for (const vault of vaults)
        out.set(`${lc(vault)}:${block}`, {
          value: null,
          reason: "HISTORICAL_STATE_UNAVAILABLE",
        });
    }
  }
  return out;
}

async function collectChunk(
  context: ExecutionContext,
  fromBlock: number,
  toBlock: number,
  known: Map<string, VaultMeta>,
  pinnedReceipts?: Awaited<ReturnType<typeof registeredPresetReceipts>>,
): Promise<ChunkResult> {
  const initialEnd = await context.publicClient.getBlock({ blockNumber: BigInt(toBlock) });
  if (!initialEnd.hash) throw new Error("Execution chunk end is unavailable");
  const blockCache = new Map<number, { timestamp: bigint; hash: Hex }>();
  const eventRows: (typeof executionEvents.$inferInsert)[] = [];
  async function finish(rows: Omit<ChunkResult, "toBlockHash">): Promise<ChunkResult> {
    for (const event of rows.eventRows) {
      const block = await blockInfo(context.publicClient, blockCache, event.blockNumber);
      if (lc(block.hash) !== lc(event.blockHash))
        throw new Error("Execution log is not canonical; chunk was not committed");
    }
    const end = await context.publicClient.getBlock({ blockNumber: BigInt(toBlock) });
    if (end.hash !== initialEnd.hash)
      throw new Error("Execution chunk reorganized; chunk was not committed");
    return { ...rows, toBlockHash: initialEnd.hash! };
  }

  // Only the finite operator-pinned deployment receipts can create DB rows.
  // Normal vault flow logs continue indefinitely; factory log discovery does not.
  const themeTokenRows: NewThemeTokenRecord[] = [];
  const receipts = pinnedReceipts ?? (await registeredPresetReceipts(context, CONFIRMATIONS));
  for (const receipt of receipts) {
    if (receipt.row.deployBlock < fromBlock || receipt.row.deployBlock > toBlock) continue;
    themeTokenRows.push(receipt.row);
    known.set(receipt.row.vault, { tokenId: receipt.row.id, decimals: receipt.row.spec.decimals });
    for (const entry of receipt.logs)
      eventRows.push({
        deploymentId: context.manifest.deploymentId,
        transactionHash: lc(entry.transactionHash),
        logIndex: entry.logIndex,
        blockNumber: Number(entry.blockNumber),
        blockHash: lc(entry.blockHash),
        address: lc(entry.address),
        eventName: entry.eventName,
        scope: "factory",
        canonical: true,
      });
  }

  const vaultAddresses = [...known.keys()].map((address) => getAddress(address));
  const flowRows: NewFlowRecord[] = [];
  const rebalanceRows: NewRebalanceRecord[] = [];
  if (vaultAddresses.length === 0)
    return finish({ themeTokenRows, flowRows, rebalanceRows, eventRows });

  const vaultLogEntries = await vaultLogs(context, vaultAddresses, fromBlock, toBlock);
  const reimbursementByTx = new Map<string, Reimbursement>();
  const failedLegsByTx = new Map<string, string[]>();
  for (const entry of vaultLogEntries) {
    if (entry.transactionHash === null) continue;
    const txHash = lc(entry.transactionHash);
    if (entry.eventName === "KeeperReimbursed") {
      const previous = reimbursementByTx.get(txHash) ?? {
        paidWei: null,
        skippedWei: null,
        skipReason: null,
      };
      previous.paidWei = arg<bigint>(entry, "amountWei");
      reimbursementByTx.set(txHash, previous);
    } else if (entry.eventName === "KeeperReimbursementSkipped") {
      const previous = reimbursementByTx.get(txHash) ?? {
        paidWei: null,
        skippedWei: null,
        skipReason: null,
      };
      previous.skippedWei = arg<bigint>(entry, "amountWei");
      previous.skipReason = Number(arg<bigint>(entry, "reason"));
      reimbursementByTx.set(txHash, previous);
    } else if (entry.eventName === "InKindLegFailed") {
      const tokensForTx = failedLegsByTx.get(txHash) ?? [];
      tokensForTx.push(lc(arg<string>(entry, "token")));
      failedLegsByTx.set(txHash, tokensForTx);
    }
  }

  type PendingFlow = {
    vault: Address;
    meta: VaultMeta;
    block: number;
    blockHash: Hex;
    ts: Date;
    logIndex: number;
    txHash: string;
    kind: "mint" | "redeem";
    user: string;
    sharesHuman: number;
    mintUsd: number | null;
    redeemUsd: number | null;
    failedLegs: number | null;
  };
  const pending: PendingFlow[] = [];
  for (const entry of vaultLogEntries) {
    if (entry.blockNumber === null || entry.transactionHash === null || entry.logIndex === null)
      continue;
    const meta = known.get(lc(entry.address));
    if (!meta) continue;
    const block = Number(entry.blockNumber);
    const info = entry.blockHash
      ? { timestamp: 0n, hash: entry.blockHash as Hex }
      : await blockInfo(context.publicClient, blockCache, block);
    eventRows.push({
      deploymentId: context.manifest.deploymentId,
      transactionHash: lc(entry.transactionHash),
      logIndex: entry.logIndex,
      blockNumber: block,
      blockHash: info.hash.toLowerCase(),
      address: lc(entry.address),
      eventName: entry.eventName,
      scope: "vault",
      canonical: true,
    });
    const ts = new Date(
      Number((await blockInfo(context.publicClient, blockCache, block)).timestamp) * 1000,
    );
    if (entry.eventName === "Rebalanced") {
      const reimbursement = reimbursementByTx.get(lc(entry.transactionHash)) ?? {
        paidWei: null,
        skippedWei: null,
        skipReason: null,
      };
      rebalanceRows.push({
        id: `${lc(entry.transactionHash)}:${entry.logIndex}`,
        tokenId: meta.tokenId,
        ts,
        txHash: lc(entry.transactionHash),
        keeper: lc(arg<string>(entry, "keeper")),
        driftBeforePct: Number(arg<bigint>(entry, "driftBefore")) / 100,
        driftAfterPct: Number(arg<bigint>(entry, "driftAfter")) / 100,
        gasReimbursedWei: reimbursement.paidWei ?? 0n,
        gasReimbursedUsd: null,
        blockNumber: block,
        blockHash: info.hash.toLowerCase(),
        logIndex: entry.logIndex,
        executionDeploymentId: context.manifest.deploymentId,
        reimbursementSkippedWei: reimbursement.skippedWei,
        reimbursementSkipReason: reimbursement.skipReason,
        canonical: true,
        canonicalReason: null,
      });
      continue;
    }
    if (
      entry.eventName === "KeeperReimbursed" ||
      entry.eventName === "KeeperReimbursementSkipped" ||
      entry.eventName === "InKindLegFailed"
    )
      continue;
    if (
      entry.eventName !== "Minted" &&
      entry.eventName !== "Redeemed" &&
      entry.eventName !== "RedeemedToUsdg"
    )
      continue;
    const shares = arg<bigint>(entry, "shares");
    pending.push({
      vault: getAddress(entry.address),
      meta,
      block,
      blockHash: info.hash,
      ts,
      logIndex: entry.logIndex,
      txHash: lc(entry.transactionHash),
      kind: entry.eventName === "Minted" ? "mint" : "redeem",
      user: lc(arg<string>(entry, "caller")),
      sharesHuman: Number(shares) / 10 ** meta.decimals,
      mintUsd:
        entry.eventName === "Minted" ? Number(arg<bigint>(entry, "depositValueUsd")) / WAD : null,
      redeemUsd:
        entry.eventName === "RedeemedToUsdg"
          ? Number(arg<bigint>(entry, "usdgOut")) / 10 ** context.manifest.usdg.decimals
          : null,
      failedLegs: entry.eventName === "Redeemed" ? Number(arg<bigint>(entry, "failedLegs")) : null,
    });
  }
  const navByVaultBlock = await resolveHistoricalNav(
    context,
    pending.map((flow) => ({ vault: flow.vault, block: flow.block })),
  );
  for (const flow of pending) {
    const historical = navByVaultBlock.get(`${lc(flow.vault)}:${flow.block}`) ?? {
      value: null,
      reason: "HISTORICAL_STATE_UNAVAILABLE",
    };
    // A full routed exit burns the final shares before the block-pinned NAV
    // read. The event's USDG output is the authoritative settlement amount;
    // do not expose the post-burn zero NAV as a fake zero-dollar redemption.
    const navPerShare = flow.redeemUsd !== null && historical.value === 0 ? null : historical.value;
    const navReason =
      flow.redeemUsd !== null && historical.value === 0
        ? "NO_SUPPLY_AFTER_REDEEM"
        : historical.reason;
    const failedLegTokens = failedLegsByTx.get(flow.txHash) ?? null;
    flowRows.push({
      tokenId: flow.meta.tokenId,
      ts: flow.ts,
      kind: flow.kind,
      user: flow.user,
      usd:
        flow.kind === "mint"
          ? flow.mintUsd
          : flow.redeemUsd !== null
            ? flow.redeemUsd
            : historical.value === null
              ? null
              : flow.sharesHuman * historical.value,
      shares: flow.sharesHuman,
      navPerShare,
      failedLegs: failedLegTokens === null ? flow.failedLegs : failedLegTokens.length,
      failedLegTokens,
      navReason,
      txHash: flow.txHash,
      blockNumber: flow.block,
      blockHash: flow.blockHash.toLowerCase(),
      logIndex: flow.logIndex,
      executionDeploymentId: context.manifest.deploymentId,
      navGranularity: "block_end",
      canonical: true,
      canonicalReason: null,
    });
  }
  return finish({ themeTokenRows, flowRows, rebalanceRows, eventRows });
}

async function ensureIndexerStates(
  context: ExecutionContext,
  factories: IndexedFactory[],
): Promise<{ firstRun: boolean; vaultStartBlock: number }> {
  const deploymentId = context.manifest.deploymentId;
  const vaultStartBlock = factories.reduce(
    (minimum, factory) => Math.min(minimum, factory.startBlock),
    START_BLOCK,
  );
  const existing = await db
    .select({ scope: executionIndexerState.scope })
    .from(executionIndexerState)
    .where(eq(executionIndexerState.deploymentId, deploymentId));
  const hadState = existing.length > 0;
  await db.transaction(async (tx) => {
    await tx
      .insert(executionIndexerState)
      .values({
        deploymentId,
        scope: "vault",
        factoryAddress: ALL_FACTORY_ADDRESS,
        factoryVersion: ALL_FACTORY_VERSION,
        startBlock: vaultStartBlock,
        lastBlock: vaultStartBlock - 1,
        lastBlockHash: null,
        status: "healthy",
        degradedReason: null,
      })
      .onConflictDoNothing();
    for (const factory of factories) {
      await tx
        .insert(executionIndexerState)
        .values({
          deploymentId,
          scope: "factory",
          factoryAddress: lc(factory.address),
          factoryVersion: factory.version,
          startBlock: factory.startBlock,
          lastBlock: factory.startBlock - 1,
          lastBlockHash: null,
          status: "healthy",
          degradedReason: null,
        })
        .onConflictDoNothing();
    }
  });
  return { firstRun: !hadState, vaultStartBlock };
}

async function stateRows(deploymentId: string) {
  return db
    .select()
    .from(executionIndexerState)
    .where(eq(executionIndexerState.deploymentId, deploymentId));
}

async function findCommonAncestor(
  context: ExecutionContext,
  state: typeof executionIndexerState.$inferSelect,
): Promise<{ blockNumber: number; blockHash: Hex } | null> {
  const candidates = await db
    .select()
    .from(executionIndexerCheckpoints)
    .where(
      and(
        eq(executionIndexerCheckpoints.deploymentId, state.deploymentId),
        eq(executionIndexerCheckpoints.scope, state.scope),
        eq(executionIndexerCheckpoints.factoryAddress, state.factoryAddress),
        eq(executionIndexerCheckpoints.factoryVersion, state.factoryVersion),
        lte(executionIndexerCheckpoints.blockNumber, state.lastBlock),
      ),
    )
    .orderBy(desc(executionIndexerCheckpoints.blockNumber));
  for (const candidate of candidates) {
    const block = await context.publicClient.getBlock({
      blockNumber: BigInt(candidate.blockNumber),
    });
    if (block.hash && lc(block.hash) === lc(candidate.blockHash))
      return { blockNumber: candidate.blockNumber, blockHash: block.hash };
  }
  return null;
}

async function markReorgAndRewind(
  context: ExecutionContext,
  ancestor: { blockNumber: number; blockHash: Hex },
): Promise<void> {
  const deploymentId = context.manifest.deploymentId;
  const reason = `ORPHANED_BY_REORG_AFTER_${ancestor.blockNumber}`;
  const states = await stateRows(deploymentId);
  await db.transaction(async (tx) => {
    await tx
      .update(executionEvents)
      .set({ canonical: false, canonicalReason: reason })
      .where(
        and(
          eq(executionEvents.deploymentId, deploymentId),
          gt(executionEvents.blockNumber, ancestor.blockNumber),
        ),
      );
    await tx
      .update(themeTokens)
      .set({ canonical: false, canonicalReason: reason })
      .where(
        and(
          eq(themeTokens.executionDeploymentId, deploymentId),
          gt(themeTokens.deployBlock, ancestor.blockNumber),
        ),
      );
    await tx
      .update(flows)
      .set({ canonical: false, canonicalReason: reason })
      .where(
        and(
          eq(flows.executionDeploymentId, deploymentId),
          gt(flows.blockNumber, ancestor.blockNumber),
        ),
      );
    await tx
      .update(rebalances)
      .set({ canonical: false, canonicalReason: reason })
      .where(
        and(
          eq(rebalances.executionDeploymentId, deploymentId),
          gt(rebalances.blockNumber, ancestor.blockNumber),
        ),
      );
    await tx
      .update(navHistory)
      .set({ canonical: false, canonicalReason: reason })
      .where(
        and(
          eq(navHistory.executionDeploymentId, deploymentId),
          gt(navHistory.blockNumber, ancestor.blockNumber),
        ),
      );
    await tx
      .update(themeTokens)
      .set({ aumUsd: null })
      .where(eq(themeTokens.executionDeploymentId, deploymentId));
    await tx
      .update(executionPoolObservations)
      .set({ status: "stale", lastError: reason })
      .where(
        and(
          eq(executionPoolObservations.deploymentId, deploymentId),
          gt(executionPoolObservations.blockNumber, ancestor.blockNumber),
        ),
      );
    await tx
      .update(executionPools)
      .set({ authenticated: false, authenticatedAt: null })
      .where(
        and(
          eq(executionPools.deploymentId, deploymentId),
          gt(executionPools.firstSeenBlock, ancestor.blockNumber),
        ),
      );
    await tx
      .update(executionDiscoveryProgress)
      .set({
        coverageStatus: "partial",
        lastSuccessfulBlock: null,
        lastSuccessfulBlockHash: null,
        lastSuccessfulAt: null,
        lastError: reason,
      })
      .where(eq(executionDiscoveryProgress.deploymentId, deploymentId));
    await tx
      .update(themeProposals)
      .set({ status: "proposed", updatedAt: new Date() })
      .where(
        and(
          eq(themeProposals.status, "deployed"),
          eq(themeProposals.executionDeploymentId, deploymentId),
          inArray(
            themeProposals.deployTx,
            db
              .select({ deployTx: themeTokens.deployTx })
              .from(themeTokens)
              .where(
                and(
                  eq(themeTokens.executionDeploymentId, deploymentId),
                  eq(themeTokens.canonical, false),
                  gt(themeTokens.deployBlock, ancestor.blockNumber),
                ),
              ),
          ),
        ),
      );
    await tx
      .delete(executionIndexerCheckpoints)
      .where(
        and(
          eq(executionIndexerCheckpoints.deploymentId, deploymentId),
          gt(executionIndexerCheckpoints.blockNumber, ancestor.blockNumber),
        ),
      );
    for (const row of states) {
      const lastBlock =
        row.startBlock > ancestor.blockNumber ? row.startBlock - 1 : ancestor.blockNumber;
      await tx
        .update(executionIndexerState)
        .set({
          lastBlock,
          lastBlockHash:
            lastBlock === ancestor.blockNumber ? ancestor.blockHash.toLowerCase() : null,
          status: "healthy",
          degradedReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(executionIndexerState.deploymentId, deploymentId),
            eq(executionIndexerState.scope, row.scope),
            eq(executionIndexerState.factoryAddress, row.factoryAddress),
            eq(executionIndexerState.factoryVersion, row.factoryVersion),
          ),
        );
      if (lastBlock === ancestor.blockNumber) {
        await tx
          .insert(executionIndexerCheckpoints)
          .values({
            deploymentId,
            scope: row.scope,
            factoryAddress: row.factoryAddress,
            factoryVersion: row.factoryVersion,
            blockNumber: ancestor.blockNumber,
            blockHash: ancestor.blockHash.toLowerCase(),
          })
          .onConflictDoUpdate({
            target: [
              executionIndexerCheckpoints.deploymentId,
              executionIndexerCheckpoints.scope,
              executionIndexerCheckpoints.factoryAddress,
              executionIndexerCheckpoints.factoryVersion,
              executionIndexerCheckpoints.blockNumber,
            ],
            set: { blockHash: ancestor.blockHash.toLowerCase(), createdAt: new Date() },
          });
      }
    }
  });
}

async function recoverBeforeAdvance(context: ExecutionContext): Promise<string | null> {
  const states = await stateRows(context.manifest.deploymentId);
  for (const state of states) {
    if (state.lastBlock < 0 || !state.lastBlockHash) continue;
    const current = await context.publicClient.getBlock({ blockNumber: BigInt(state.lastBlock) });
    if (current.hash && lc(current.hash) === lc(state.lastBlockHash)) continue;
    const ancestor = await findCommonAncestor(context, state);
    if (!ancestor) {
      const reason = `REORG_BEYOND_RETENTION_AT_${state.lastBlock}`;
      await db
        .update(executionIndexerState)
        .set({ status: "degraded", degradedReason: reason, updatedAt: new Date() })
        .where(eq(executionIndexerState.deploymentId, context.manifest.deploymentId));
      return reason;
    }
    await markReorgAndRewind(context, ancestor);
    log.warn("execution history rewound to canonical ancestor", {
      deploymentId: context.manifest.deploymentId,
      ancestorBlock: ancestor.blockNumber,
      ancestorHash: ancestor.blockHash,
    });
    return null;
  }
  return null;
}

async function applyChunk(
  context: ExecutionContext,
  factories: IndexedFactory[],
  chunk: ChunkResult,
  toBlock: number,
  toBlockHash: Hex,
  now: Date,
): Promise<void> {
  const deploymentId = context.manifest.deploymentId;
  const states = await stateRows(deploymentId);
  await db.transaction(async (tx) => {
    if (chunk.eventRows.length > 0) {
      await tx
        .insert(executionEvents)
        .values(chunk.eventRows)
        .onConflictDoUpdate({
          target: [
            executionEvents.deploymentId,
            executionEvents.transactionHash,
            executionEvents.logIndex,
          ],
          set: {
            ...conflictUpdateSet(executionEvents, [
              "blockNumber",
              "blockHash",
              "address",
              "eventName",
              "scope",
              "payload",
            ]),
            canonical: sql`true`,
            canonicalReason: sql`NULL`,
            observedAt: now,
          },
        });
    }
    if (chunk.themeTokenRows.length > 0) {
      await tx
        .insert(themeTokens)
        .values(chunk.themeTokenRows)
        .onConflictDoUpdate({
          target: themeTokens.id,
          set: {
            ...conflictUpdateSet(themeTokens, [
              "creator",
              "theme",
              "token",
              "vault",
              "spec",
              "creatorFeeBps",
              "chainId",
              "deployTx",
              "deployedAt",
              "deployBlock",
              "executionDeploymentId",
              "deployBlockHash",
              "deployLogIndex",
              "factoryAddress",
              "factoryVersion",
              "executionCompatibility",
              "executionCompatibilityReason",
            ]),
            canonical: sql`true`,
            canonicalReason: sql`NULL`,
          },
        });
      await tx
        .update(themeProposals)
        .set({ status: "deployed", updatedAt: now })
        .where(
          and(
            eq(themeProposals.executionDeploymentId, deploymentId),
            inArray(themeProposals.deployTx, [
              ...new Set(chunk.themeTokenRows.map((row) => row.deployTx)),
            ]),
          ),
        );
    }
    if (chunk.flowRows.length > 0) {
      await tx
        .insert(flows)
        .values(chunk.flowRows)
        .onConflictDoUpdate({
          target: [flows.executionDeploymentId, flows.txHash, flows.logIndex, flows.ts],
          set: {
            ...conflictUpdateSet(flows, [
              "tokenId",
              "kind",
              "user",
              "usd",
              "shares",
              "navPerShare",
              "failedLegs",
              "failedLegTokens",
              "navReason",
              "blockNumber",
              "blockHash",
              "navGranularity",
            ]),
            canonical: sql`true`,
            canonicalReason: sql`NULL`,
          },
        });
    }
    if (chunk.rebalanceRows.length > 0) {
      await tx
        .insert(rebalances)
        .values(chunk.rebalanceRows)
        .onConflictDoUpdate({
          target: [rebalances.executionDeploymentId, rebalances.id],
          set: {
            ...conflictUpdateSet(rebalances, [
              "tokenId",
              "ts",
              "txHash",
              "keeper",
              "driftBeforePct",
              "driftAfterPct",
              "gasReimbursedWei",
              "gasReimbursedUsd",
              "blockNumber",
              "blockHash",
              "logIndex",
              "reimbursementSkippedWei",
              "reimbursementSkipReason",
            ]),
            canonical: sql`true`,
            canonicalReason: sql`NULL`,
          },
        });
    }
    const checkpoints = [
      {
        deploymentId,
        scope: "vault" as const,
        factoryAddress: ALL_FACTORY_ADDRESS,
        factoryVersion: ALL_FACTORY_VERSION,
        blockNumber: toBlock,
        blockHash: toBlockHash.toLowerCase(),
      },
      ...factories.map((factory) => ({
        deploymentId,
        scope: "factory" as const,
        factoryAddress: lc(factory.address),
        factoryVersion: factory.version,
        blockNumber: toBlock,
        blockHash: toBlockHash.toLowerCase(),
      })),
    ];
    await tx
      .insert(executionIndexerCheckpoints)
      .values(checkpoints)
      .onConflictDoUpdate({
        target: [
          executionIndexerCheckpoints.deploymentId,
          executionIndexerCheckpoints.scope,
          executionIndexerCheckpoints.factoryAddress,
          executionIndexerCheckpoints.factoryVersion,
          executionIndexerCheckpoints.blockNumber,
        ],
        set: { blockHash: toBlockHash.toLowerCase(), createdAt: now },
      });
    for (const row of states) {
      if (
        row.scope === "factory" &&
        !factories.some(
          (factory) =>
            lc(factory.address) === row.factoryAddress &&
            factory.version === row.factoryVersion &&
            toBlock >= factory.startBlock,
        )
      )
        continue;
      await tx
        .update(executionIndexerState)
        .set({
          lastBlock: toBlock,
          lastBlockHash: toBlockHash.toLowerCase(),
          status: "healthy",
          degradedReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionIndexerState.deploymentId, deploymentId),
            eq(executionIndexerState.scope, row.scope),
            eq(executionIndexerState.factoryAddress, row.factoryAddress),
            eq(executionIndexerState.factoryVersion, row.factoryVersion),
          ),
        );
    }
    const cutoff = toBlock - CHECKPOINT_RETENTION * Math.max(CHUNK_BLOCKS, 1);
    if (cutoff > 0)
      await tx
        .delete(executionIndexerCheckpoints)
        .where(
          and(
            eq(executionIndexerCheckpoints.deploymentId, deploymentId),
            lt(executionIndexerCheckpoints.blockNumber, cutoff),
          ),
        );
  });
}

export async function indexVault(now = new Date()): Promise<VaultIndexSummary> {
  const startedMs = Date.now();
  const summary = emptySummary(now, startedMs);
  const context = await ensureExecutionBinding().catch((error) => {
    log.warn("execution binding unavailable, vault indexer is idle", { error });
    return null;
  });
  if (!context) {
    summary.durationMs = Date.now() - startedMs;
    return summary;
  }
  const factories = manifestFactories(context);
  if (factories.length === 0) {
    summary.durationMs = Date.now() - startedMs;
    return summary;
  }
  summary.factoryConfigured = true;
  const { firstRun, vaultStartBlock } = await ensureIndexerStates(context, factories);
  summary.firstRun = firstRun;
  summary.startBlock = vaultStartBlock;
  const chain = await countRpcRequests(
    async () => {
      const head = Number(await context.publicClient.getBlockNumber());
      const pinnedReceipts = await loadVerifiedPresetReceipts(context);
      const degradedReason = await recoverBeforeAdvance(context);
      if (degradedReason)
        return {
          head,
          degradedReason,
          chunks: 0,
          themes: 0,
          flows: 0,
          rebalances: 0,
          capped: false,
          from: vaultStartBlock,
          to: vaultStartBlock - 1,
        };
      const [state] = await db
        .select()
        .from(executionIndexerState)
        .where(
          and(
            eq(executionIndexerState.deploymentId, context.manifest.deploymentId),
            eq(executionIndexerState.scope, "vault"),
          ),
        );
      if (!state) throw new Error("vault indexer state was not initialized");
      const target = Math.max(0, head - CONFIRMATIONS);
      // Restore pinned deployment rows after a reorg/cold start before reading
      // their flow logs. This does not advance any indexer cursor.
      await syncPresetRecords(context, db, pinnedReceipts);
      let cursor = state.lastBlock + 1;
      if (pinnedReceipts.length) {
        // A worker may advance while operator bootstrap is still pending. When
        // the complete registry first appears, backfill from each unrecorded
        // creation, including any direct deposits made before publication.
        const recorded = await db
          .select()
          .from(executionEvents)
          .where(
            and(
              eq(executionEvents.deploymentId, context.manifest.deploymentId),
              eq(executionEvents.scope, "factory"),
              eq(executionEvents.eventName, "ThemeDeployed"),
              eq(executionEvents.canonical, true),
              inArray(
                executionEvents.transactionHash,
                pinnedReceipts.map((receipt) => receipt.row.deployTx),
              ),
            ),
          );
        for (const receipt of pinnedReceipts) {
          if (
            !recorded.some(
              (event) =>
                event.transactionHash === receipt.row.deployTx &&
                event.blockHash === receipt.blockHash.toLowerCase(),
            )
          )
            cursor = Math.min(cursor, receipt.row.deployBlock);
        }
      }
      const replayFrom = cursor;
      let chunks = 0;
      let themes = 0;
      let flowCount = 0;
      let rebalanceCount = 0;
      while (cursor <= target && chunks < MAX_CHUNKS_PER_RUN) {
        const chunkTo = Math.min(cursor + CHUNK_BLOCKS - 1, target);
        const chunk = await collectChunk(
          context,
          cursor,
          chunkTo,
          await loadKnownVaults(context.manifest.deploymentId),
          pinnedReceipts,
        );
        const end = await context.publicClient.getBlock({ blockNumber: BigInt(chunkTo) });
        if (!end.hash || end.hash !== chunk.toBlockHash)
          throw new Error(`execution block ${chunkTo} changed before commit`);
        await applyChunk(context, factories, chunk, chunkTo, end.hash, now);
        themes += chunk.themeTokenRows.length;
        flowCount += chunk.flowRows.length;
        rebalanceCount += chunk.rebalanceRows.length;
        cursor = chunkTo + 1;
        chunks += 1;
      }
      return {
        head,
        degradedReason: null,
        chunks,
        themes,
        flows: flowCount,
        rebalances: rebalanceCount,
        capped: cursor <= target,
        from: replayFrom,
        to: cursor - 1,
      };
    },
    { operation: "execution-vault-index", context: "execution", priority: "recovery" },
  );
  summary.rpcRequests = chain.requests;
  summary.head = chain.value.head;
  summary.lagBlocks = Math.max(0, chain.value.head - chain.value.to);
  summary.fromBlock = chain.value.from;
  summary.toBlock = chain.value.to;
  summary.chunks = chain.value.chunks;
  summary.themesIndexed = chain.value.themes;
  summary.flowsIndexed = chain.value.flows;
  summary.rebalancesIndexed = chain.value.rebalances;
  summary.cappedByMaxChunks = chain.value.capped;
  summary.degradedReason = chain.value.degradedReason;
  summary.status = chain.value.degradedReason ? "degraded" : "healthy";
  summary.durationMs = Date.now() - startedMs;
  log.info("vault indexed", { ...summary });
  return summary;
}

export async function indexerStatus() {
  const context = await ensureExecutionBinding();
  const deploymentId = context.manifest.deploymentId;
  const head = Number(await context.publicClient.getBlockNumber());
  const [binding, cursors, orphanEvents, orphanThemes, orphanFlows, orphanRebalances, orphanNav] =
    await Promise.all([
      db.select().from(executionBindings).where(eq(executionBindings.id, 1)),
      stateRows(deploymentId),
      db
        .select({ value: count() })
        .from(executionEvents)
        .where(
          and(eq(executionEvents.deploymentId, deploymentId), eq(executionEvents.canonical, false)),
        ),
      db
        .select({ value: count() })
        .from(themeTokens)
        .where(
          and(
            eq(themeTokens.executionDeploymentId, deploymentId),
            eq(themeTokens.canonical, false),
          ),
        ),
      db
        .select({ value: count() })
        .from(flows)
        .where(and(eq(flows.executionDeploymentId, deploymentId), eq(flows.canonical, false))),
      db
        .select({ value: count() })
        .from(rebalances)
        .where(
          and(eq(rebalances.executionDeploymentId, deploymentId), eq(rebalances.canonical, false)),
        ),
      db
        .select({ value: count() })
        .from(navHistory)
        .where(
          and(eq(navHistory.executionDeploymentId, deploymentId), eq(navHistory.canonical, false)),
        ),
    ]);
  const vault = cursors.find((cursor) => cursor.scope === "vault");
  return {
    deploymentId,
    chainId: context.manifest.chainId,
    head,
    status: cursors.some((cursor) => cursor.status === "degraded") ? "degraded" : "healthy",
    binding: binding[0] ?? null,
    cursors: cursors.map((cursor) => ({
      ...cursor,
      lagBlocks: Math.max(0, head - cursor.lastBlock),
    })),
    lagBlocks: vault ? Math.max(0, head - vault.lastBlock) : null,
    orphaned: {
      events: Number(orphanEvents[0]?.value ?? 0),
      themes: Number(orphanThemes[0]?.value ?? 0),
      flows: Number(orphanFlows[0]?.value ?? 0),
      rebalances: Number(orphanRebalances[0]?.value ?? 0),
      nav: Number(orphanNav[0]?.value ?? 0),
    },
  };
}

/** Operator-selected replay. It only reads canonical execution logs and writes execution projections. */
export async function replayVaultRange(fromBlock: number, toBlock: number, now = new Date()) {
  if (
    !Number.isInteger(fromBlock) ||
    !Number.isInteger(toBlock) ||
    fromBlock < 0 ||
    fromBlock > toBlock
  )
    throw new Error("replay range must be non-negative integers with from <= to");
  const context = await ensureExecutionBinding();
  const head = Number(await context.publicClient.getBlockNumber());
  if (toBlock > head) throw new Error(`replay end ${toBlock} is above execution head ${head}`);
  const factories = manifestFactories(context);
  await ensureIndexerStates(context, factories);
  const chunk = await collectChunk(
    context,
    fromBlock,
    toBlock,
    await loadKnownVaults(context.manifest.deploymentId),
  );
  const end = await context.publicClient.getBlock({ blockNumber: BigInt(toBlock) });
  if (!end.hash || end.hash !== chunk.toBlockHash)
    throw new Error(`execution block ${toBlock} changed before commit`);
  await applyChunk(context, factories, chunk, toBlock, end.hash, now);
  return {
    deploymentId: context.manifest.deploymentId,
    fromBlock,
    toBlock,
    blockHash: end.hash,
    themesIndexed: chunk.themeTokenRows.length,
    flowsIndexed: chunk.flowRows.length,
    rebalancesIndexed: chunk.rebalanceRows.length,
  };
}

/** Explicit operator rewind for a deeper-than-retained local or mainnet reorg. */
export async function rewindExecutionIndexer(
  ancestorBlock: number,
): Promise<{ blockNumber: number; blockHash: Hex }> {
  if (!Number.isInteger(ancestorBlock) || ancestorBlock < 0)
    throw new Error("ancestor block must be non-negative");
  const context = await ensureExecutionBinding();
  const block = await context.publicClient.getBlock({ blockNumber: BigInt(ancestorBlock) });
  if (!block.hash) throw new Error(`execution block ${ancestorBlock} has no hash`);
  await markReorgAndRewind(context, { blockNumber: ancestorBlock, blockHash: block.hash });
  return { blockNumber: ancestorBlock, blockHash: block.hash };
}
