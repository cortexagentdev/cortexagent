/**
 * The NAV poller (BE-26).
 *
 * `spec/CortexBackend.md` PART 4 (`navPerShare`, `navIndicative`) and PART 5
 * (`nav_history`, `theme_tokens.aumUsd`). One row per deployed theme token per
 * cycle, so the vault surface has a NAV chart and an AUM figure.
 *
 * All reads target the RHC testnet client (chain 46630, locked decision 5). C1
 * never touches this chain and this worker never touches the mainnet one.
 *
 * ## `navPerShare()` reverting is the safe failure, not an alarm
 *
 * `navPerShare()` and `navValue()` revert when any constituent feed sits outside
 * its liveness bound (heartbeat + grace). That is the designed behaviour
 * (BE-25b): a stale feed must not let a mint price itself off a number nobody
 * can stand behind. This worker does not alarm on it and does not log it per
 * feed. It reads through `Multicall3` with `allowFailure`, so the revert is a
 * per-call failure, and on that failure it records the observation from
 * `navIndicative()` and sets `indicative = true`.
 *
 * ## `navIndicative()` stays strictly on the read path
 *
 * `navIndicative()` is read-only and no mint or redeem path consumes it. It
 * exists for display. This worker only ever writes its value into `nav_history`
 * for a chart; nothing downstream treats an indicative row as a price to trade
 * against.
 *
 * ## When a row is indicative
 *
 * `indicative = true` when the equity market is closed (outside RTH), OR any
 * constituent feed is stale (`navIndicative().stale`), OR the strict read
 * reverted. Any one is enough.
 */

import { and, eq, sql } from "drizzle-orm";
import { getAddress, type Address } from "viem";

import { keylessVaultAbi, themeTokenAbi } from "../chain/abis/index.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { multicallRead, type MulticallItem } from "../chain/multicall.ts";
import { decodeNavIndicative, decodeUint, fromWad } from "../chain/vault-reads.ts";
import { db } from "../db/client.ts";
import { navHistory, themeTokens, type NewNavHistoryRecord } from "../db/schema.ts";
import { ensureExecutionBinding } from "../execution/registry.ts";
import { logger } from "../lib/logger.ts";
import { getSession } from "../lib/session.ts";

const log = logger.child({ module: "nav-poller" });

/** BullMQ repeatable interval. One sample a minute, matching the price poller. */
export const NAV_POLL_INTERVAL_MS = 60_000;

/** RHC testnet. Vault writes and vault indexing only (locked decision 5). */
export const TESTNET_CHAIN_ID = 46630;

export interface NavPollSummary {
  startedAt: string;
  durationMs: number;
  /** Deployed theme tokens polled. */
  tokens: number;
  /** `nav_history` rows written this cycle. */
  written: number;
  /** Rows written with `indicative = true`. */
  indicative: number;
  /** Rows whose `navPerShare` came from the strict `navPerShare()` read. */
  firm: number;
  /** Tokens no value could be read for at all (vault unreachable). */
  unreadable: number;
  /** True when the equity market was closed for this cycle. */
  marketClosed: boolean;
  /** JSON-RPC requests the cycle made. */
  rpcRequests: number;
}

function emptySummary(startedAt: Date, startedMs: number, marketClosed: boolean): NavPollSummary {
  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    tokens: 0,
    written: 0,
    indicative: 0,
    firm: 0,
    unreadable: 0,
    marketClosed,
    rpcRequests: 0,
  };
}

interface DeployedToken {
  id: string;
  vault: string;
}

/**
 * One poll cycle. Returns a summary; throws only on a genuine defect (the DB
 * write failing). A vault that cannot be read is a `null` observation, not an
 * error, and a stale feed is an `indicative` one.
 */
export async function pollNav(now = new Date()): Promise<NavPollSummary> {
  const startedMs = Date.now();
  const marketClosed = getSession(now) !== "rth";

  const context = await ensureExecutionBinding().catch((error) => {
    log.warn("execution binding unavailable, NAV poller is idle", { error });
    return null;
  });
  if (!context) return emptySummary(now, startedMs, marketClosed);

  const tokens: DeployedToken[] = await db
    .select({ id: themeTokens.id, vault: themeTokens.vault })
    .from(themeTokens)
    .where(
      and(
        eq(themeTokens.status, "deployed"),
        eq(themeTokens.chainId, context.manifest.chainId),
        eq(themeTokens.executionDeploymentId, context.manifest.deploymentId),
        eq(themeTokens.canonical, true),
      ),
    );

  if (tokens.length === 0) {
    // Nothing deployed yet, or RHC_TESTNET_THEME_FACTORY is unset so the indexer
    // has produced no rows. Not an error.
    log.info("no deployed theme tokens, nothing to poll");
    return emptySummary(now, startedMs, marketClosed);
  }

  const vaultAddresses: Address[] = tokens.map((token) => getAddress(token.vault));
  const tokenAddresses: Address[] = tokens.map((token) => getAddress(token.id));

  const chain = await countRpcRequests(
    async () => {
      // Pin every read to one testnet block so the whole cycle is one chain state.
      const blockNumber = await context.publicClient.getBlockNumber();
      const block = await context.publicClient.getBlock({ blockNumber });
      if (!block.hash) throw new Error("execution head has no canonical hash");

      const calls = tokens.flatMap((_, i) => [
        {
          address: vaultAddresses[i]!,
          abi: keylessVaultAbi,
          functionName: "navIndicative",
        } as const,
        { address: vaultAddresses[i]!, abi: keylessVaultAbi, functionName: "navPerShare" } as const,
        { address: vaultAddresses[i]!, abi: keylessVaultAbi, functionName: "navValue" } as const,
        { address: tokenAddresses[i]!, abi: themeTokenAbi, functionName: "totalSupply" } as const,
      ]);

      const results = (await multicallRead(calls, {
        client: context.publicClient,
        blockNumber,
      })) as unknown as MulticallItem<unknown>[];

      const canonical = await context.publicClient.getBlock({ blockNumber });
      if (canonical.hash !== block.hash) throw new Error("NAV block reorganized before commit");
      return { blockNumber, blockHash: block.hash, results };
    },
    { operation: "execution-nav-poll", context: "execution", priority: "background" },
  );

  const summary = emptySummary(now, startedMs, marketClosed);
  summary.tokens = tokens.length;
  summary.rpcRequests = chain.requests;

  const rows: NewNavHistoryRecord[] = [];
  const aumByToken = new Map<string, number | null>();

  tokens.forEach((token, i) => {
    const base = i * 4;
    const indicative = decodeNavIndicative(chain.value.results[base]);
    const strictPerShare = decodeUint(chain.value.results[base + 1]);
    const strictValue = decodeUint(chain.value.results[base + 2]);
    const supply = decodeUint(chain.value.results[base + 3]);

    const strictOk = strictPerShare !== null && strictValue !== null;
    const feedStale = indicative === null ? true : indicative.stale;
    const rowIndicative = marketClosed || feedStale || !strictOk;

    let navPerShare: number | null;
    let aumUsd: number | null;

    if (supply === 0n) {
      // An empty vault: AUM is a true 0, per-share is undefined (nothing to
      // divide), so null, not 0 (global do-not 2).
      navPerShare = null;
      aumUsd = 0;
    } else if (strictOk) {
      navPerShare = fromWad(strictPerShare);
      aumUsd = fromWad(strictValue);
    } else if (indicative !== null && supply !== null) {
      // navIndicative().value is the same per-share figure navPerShare() would
      // return; AUM is that times supply.
      navPerShare = fromWad(indicative.value);
      aumUsd = fromWad(indicative.value) * fromWad(supply);
    } else if (indicative !== null) {
      navPerShare = fromWad(indicative.value);
      aumUsd = null;
    } else {
      navPerShare = null;
      aumUsd = null;
      summary.unreadable += 1;
    }

    if (rowIndicative) summary.indicative += 1;
    if (strictOk && supply !== 0n) summary.firm += 1;

    const valuationStatus = supply === 0n ? "unavailable" : rowIndicative ? "indicative" : "strict";
    const valuationReason =
      supply === 0n
        ? "ZERO_SUPPLY"
        : rowIndicative
          ? marketClosed
            ? "MARKET_CLOSED"
            : feedStale || !strictOk
              ? "FEED_STALE_OR_STRICT_REVERT"
              : null
          : null;
    rows.push({
      tokenId: token.id,
      ts: now,
      navPerShare,
      aumUsd,
      indicative: rowIndicative,
      executionDeploymentId: context.manifest.deploymentId,
      blockNumber: Number(chain.value.blockNumber),
      blockHash: chain.value.blockHash.toLowerCase(),
      valuationStatus,
      valuationReason,
      navGranularity: "block_end",
      canonical: true,
      canonicalReason: null,
    });
    aumByToken.set(token.id, aumUsd);
  });

  if (rows.length > 0) {
    // One timestamp per cycle, so a retried cycle collides with itself and is
    // discarded rather than doubling an observation.
    await db.insert(navHistory).values(rows).onConflictDoNothing();
    summary.written = rows.length;

    // Push the latest AUM onto theme_tokens. That column is this worker's; the
    // indexer's upsert leaves it alone. Only tokens with a value this cycle: a
    // transient RPC failure records a null nav_history observation but must not
    // blank the headline AUM figure (a true 0 for an empty vault still writes).
    const updates = [...aumByToken.entries()]
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .map(([id, aum]) => sql`(${id}, ${aum}::numeric)`);
    if (updates.length > 0) {
      await db.execute(sql`
        UPDATE theme_tokens AS t
        SET aum_usd = v.aum_usd
        FROM (VALUES ${sql.join(updates, sql`, `)}) AS v(id, aum_usd)
        WHERE t.id = v.id
          AND t.execution_deployment_id = ${context.manifest.deploymentId}
          AND t.canonical = true
      `);
    }
  }

  summary.durationMs = Date.now() - startedMs;
  log.info("nav polled", { ...summary });
  return summary;
}
