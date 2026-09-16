/**
 * HOLDER_CONCENTRATION — day-over-day change in top-N holder share (BE-15).
 *
 * `spec/CortexBackend.md` PART 3, "Flow / liquidity / holder signals". This is
 * the one C1 signal that needs event logs: the forward-only indexer in
 * `workers/transfer-indexer.ts` accumulates per-address balances, and this
 * processor turns the top of that distribution into a signal when it shifts.
 *
 * ## What fires
 *
 * The top-`SIGNAL_HOLDER_CONCENTRATION_TOP_N` holder share moved by at least
 * `SIGNAL_HOLDER_CONCENTRATION_MIN_DELTA_PP` percentage points against the same
 * measurement ~24h earlier. `magnitude` is the signed point change: positive is
 * concentration rising, negative is it dispersing.
 *
 * ## Multiplier-adjusted math (PART 3)
 *
 * The share is computed from `balanceOfUI()` and `totalSupplyUI()`, read
 * directly off the token. Those views are already multiplier-adjusted. Deriving
 * them from a raw balance times `uiMultiplier` would drift exactly at a
 * corporate action, which is the moment holder numbers matter most, so it is
 * not done. `holder_balances` is only the candidate list: its raw, forward-only
 * balances pick which addresses to read `balanceOfUI` for, and the read is the
 * authority for the arithmetic.
 *
 * ## Honesty while the baseline is short (BE-15 scope section 4)
 *
 * Indexing is forward-only, so for the first 30 days the history is genuinely
 * partial: a wallet that held tokens before the indexer started and has not
 * moved them since is invisible to `holder_balances`. Until 30 days of forward
 * data exist every signal carries LOW confidence and the explanation states the
 * baseline length. Confidence never reaches HIGH for this kind at all, because
 * the candidate set can never be proven complete.
 *
 * ## Sources
 *
 * The `balanceOfUI` read block, the forward-index block range, the count of
 * known holder addresses, and the tx hashes of the largest recent transfers
 * (from the indexer's Redis buffer, best-effort).
 */

import { eq, sql } from "drizzle-orm";
import { getAddress, type Address } from "viem";

import { stockAbi } from "../chain/abis/index.ts";
import { publicClient } from "../chain/client.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { indexerState, universe } from "../db/schema.ts";
import { env } from "../env.ts";
import { redis } from "../lib/redis.ts";
import { loadRecentTransfers, TRANSFER_INDEXER } from "../workers/transfer-indexer.ts";
import { registerProcessor } from "./registry.ts";
import type {
  Confidence,
  ProcessorContext,
  SignalCandidate,
  SignalProcessor,
  TimeWindow,
} from "./types.ts";

export const MIN_DELTA_PP = env.SIGNAL_HOLDER_CONCENTRATION_MIN_DELTA_PP;
export const TOP_N = env.SIGNAL_HOLDER_CONCENTRATION_TOP_N;
export const CANDIDATES_PER_TOKEN = env.SIGNAL_HOLDER_CONCENTRATION_CANDIDATES;

/** HOLDER_CONCENTRATION measures day over day. Anchored to the computer's
 *  aligned window end, so the deterministic signal id is unaffected. */
const WINDOW_ISO = "P1D";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far a stored sample may sit from "exactly 24h ago" and still count as
 *  the prior-day measurement. The computer ticks every 15m, so a sample within
 *  this of the target is the intended comparison point. */
const PRIOR_TOLERANCE_MS = 8 * 60 * 60 * 1000;
/** 30 days of forward data is the point the baseline stops being called short. */
const FULL_BASELINE_DAYS = 30;

/** Mint/burn and common burn sinks, excluded from holder ranking. */
const NON_HOLDER = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

/** Per-symbol Redis hash: `windowEndMs -> {s: share, top: [addr]}`. */
const SHARE_KEY_PREFIX = "signals:holderconc:share:v1:";
const SHARE_TTL_SEC = 40 * 24 * 60 * 60;

interface ShareSample {
  /** Top-N share, percent. */
  s: number;
  /** The top-N addresses, lowercased, most held first. */
  top: string[];
}

function shareKey(symbol: string): string {
  return SHARE_KEY_PREFIX + symbol.toUpperCase();
}

function roundPct(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function roundZ(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function fmtPp(value: number): string {
  return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}pp`;
}

/**
 * Records this window's share and returns the sample closest to 24h earlier,
 * within `PRIOR_TOLERANCE_MS`. Idempotent on the window: the field is the window
 * end in ms, so a recompute overwrites.
 */
async function recordAndLoadPriorDay(
  symbol: string,
  windowEnd: Date,
  sample: ShareSample,
): Promise<ShareSample | null> {
  const key = shareKey(symbol);
  const field = String(windowEnd.getTime());

  await redis.hset(key, field, JSON.stringify(sample));
  await redis.expire(key, SHARE_TTL_SEC);

  const all = await redis.hgetall(key);
  const target = windowEnd.getTime() - DAY_MS;
  const cutoff = windowEnd.getTime() - SHARE_TTL_SEC * 1000;

  let best: ShareSample | null = null;
  let bestDist = PRIOR_TOLERANCE_MS + 1;
  const stale: string[] = [];

  for (const [tsField, value] of Object.entries(all)) {
    const tsMs = Number(tsField);
    if (!Number.isFinite(tsMs) || tsMs < cutoff) {
      stale.push(tsField);
      continue;
    }
    if (tsMs === windowEnd.getTime()) continue;
    const dist = Math.abs(tsMs - target);
    if (dist > PRIOR_TOLERANCE_MS || dist >= bestDist) continue;
    try {
      const parsed = JSON.parse(value) as ShareSample;
      if (typeof parsed.s === "number" && Array.isArray(parsed.top)) {
        best = parsed;
        bestDist = dist;
      }
    } catch {
      stale.push(tsField);
    }
  }

  if (stale.length > 0) await redis.hdel(key, ...stale);
  return best;
}

// --- Candidate addresses ---------------------------------------------------

/** The largest indexed balances per token: `Map<tokenLower, address[]>`. */
async function loadCandidates(
  ctx: ProcessorContext,
  tokenAddresses: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const token of tokenAddresses) out.set(token, []);
  if (tokenAddresses.length === 0) return out;

  const tokenList = sql.join(
    tokenAddresses.map((token) => sql`${token}`),
    sql`, `,
  );
  const excluded = sql.join(
    [...NON_HOLDER].map((address) => sql`${address}`),
    sql`, `,
  );

  const rows = await ctx.db.execute<{ token_address: string; address: string }>(sql`
    SELECT token_address, address
    FROM (
      SELECT token_address, address,
             ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY balance DESC) AS rn
      FROM holder_balances
      WHERE token_address IN (${tokenList})
        AND balance > 0
        AND address NOT IN (${excluded})
    ) ranked
    WHERE rn <= ${CANDIDATES_PER_TOKEN}
  `);

  for (const row of rows) {
    const list = out.get(row.token_address.toLowerCase());
    if (list) list.push(row.address.toLowerCase());
  }
  return out;
}

// --- Chain read ----------------------------------------------------------

interface TokenHoldings {
  /** balanceOfUI per candidate, same order as the input address list. */
  balances: Map<string, bigint>;
  totalSupplyUI: bigint | null;
}

function decodeUint(item: MulticallItem<unknown> | undefined): bigint | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  return typeof value === "bigint" ? value : null;
}

async function readHoldings(
  candidates: Map<string, string[]>,
): Promise<{ byToken: Map<string, TokenHoldings>; blockNumber: number; requests: number }> {
  const tokens = [...candidates.keys()];
  const calls: {
    address: Address;
    abi: typeof stockAbi;
    functionName: string;
    args?: unknown[];
  }[] = [];
  // Layout: for each token, one totalSupplyUI then one balanceOfUI per candidate.
  const layout: { token: string; kind: "supply" | "balance"; address?: string }[] = [];

  for (const token of tokens) {
    const checksummed = getAddress(token);
    calls.push({ address: checksummed, abi: stockAbi, functionName: "totalSupplyUI" });
    layout.push({ token, kind: "supply" });
    for (const holder of candidates.get(token) ?? []) {
      calls.push({
        address: checksummed,
        abi: stockAbi,
        functionName: "balanceOfUI",
        args: [getAddress(holder)],
      });
      layout.push({ token, kind: "balance", address: holder });
    }
  }

  const byToken = new Map<string, TokenHoldings>();
  for (const token of tokens) byToken.set(token, { balances: new Map(), totalSupplyUI: null });

  if (calls.length === 0) {
    const blockNumber = Number(await publicClient.getBlockNumber());
    return { byToken, blockNumber, requests: 0 };
  }

  const chain = await countRpcRequests(
    async () => {
      const blockNumber = await publicClient.getBlockNumber();
      const batch = (await multicallRead(calls as never, {
        client: publicClient,
        blockNumber,
      })) as unknown as MulticallItem<unknown>[];
      return { blockNumber: Number(blockNumber), batch };
    },
    { operation: "research-holder-concentration", context: "research", priority: "background" },
  );

  for (const [i, slot] of layout.entries()) {
    const decoded = decodeUint(chain.value.batch[i]);
    const holdings = byToken.get(slot.token)!;
    if (slot.kind === "supply") holdings.totalSupplyUI = decoded;
    else if (slot.address !== undefined && decoded !== null)
      holdings.balances.set(slot.address, decoded);
  }

  return { byToken, blockNumber: chain.value.blockNumber, requests: chain.requests };
}

// --- Confidence --------------------------------------------------------

/**
 * - **LOW** while less than 30 days of forward data exist, or when the feed
 *   disagrees with the independent quote for this name.
 * - **MED** otherwise. Never HIGH: forward-only indexing cannot prove the
 *   candidate set is the true top of the book.
 */
function deriveHolderConfidence(input: {
  baselineDays: number;
  feedAgreesWithQuote: boolean;
}): Confidence {
  const order: Confidence[] = ["LOW", "MED", "HIGH"];
  let level = input.baselineDays >= FULL_BASELINE_DAYS ? 1 : 0;
  if (!input.feedAgreesWithQuote) level -= 1;
  return order[Math.max(0, level)]!;
}

// --- The processor ----------------------------------------------------

export const holderConcentrationProcessor: SignalProcessor = {
  kind: "HOLDER_CONCENTRATION",
  async compute(ctx: ProcessorContext, computerWindow: TimeWindow): Promise<SignalCandidate[]> {
    const log = ctx.logger.child({ module: "signals/holder-concentration" });
    const window: TimeWindow = {
      end: computerWindow.end,
      start: new Date(computerWindow.end.getTime() - DAY_MS),
      iso: WINDOW_ISO,
    };

    const stateRows = await ctx.db
      .select()
      .from(indexerState)
      .where(eq(indexerState.indexer, TRANSFER_INDEXER));
    const state = stateRows[0];
    if (!state) {
      log.info("holder-concentration: transfer indexer has not run yet, nothing to compute");
      return [];
    }

    const baselineDays = Math.max(0, (window.end.getTime() - state.startedAt.getTime()) / DAY_MS);

    const tokenAddresses = ctx.assets.map((asset) => asset.tokenAddress.toLowerCase());
    const candidates = await loadCandidates(ctx, tokenAddresses);
    const { byToken, blockNumber, requests } = await readHoldings(candidates);

    const out: SignalCandidate[] = [];

    for (const asset of ctx.assets) {
      const tokenLower = asset.tokenAddress.toLowerCase();
      const holdings = byToken.get(tokenLower);
      if (!holdings || holdings.totalSupplyUI === null || holdings.totalSupplyUI <= 0n) continue;

      const ranked = [...holdings.balances.entries()]
        .filter(([, balance]) => balance > 0n)
        .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
      if (ranked.length === 0) continue;

      const topN = ranked.slice(0, TOP_N);
      const topSum = topN.reduce((sum, [, balance]) => sum + balance, 0n);
      // bigint ratio to 4 dp of a percent, then to a JS number.
      const share = roundPct(Number((topSum * 1_000_000n) / holdings.totalSupplyUI) / 10_000);
      const topAddrs = topN.map(([address]) => address);

      const prior = await recordAndLoadPriorDay(asset.symbol, window.end, {
        s: share,
        top: topAddrs,
      });
      if (!prior) {
        // No measurement ~24h back yet. Day-over-day is undefined; nothing to
        // emit until tomorrow. Never fabricate a baseline (scope section 4).
        continue;
      }

      const deltaPp = roundPct(share - prior.s);
      if (Math.abs(deltaPp) < MIN_DELTA_PP) continue;

      const priorSet = new Set(prior.top);
      const currentSet = new Set(topAddrs);
      const entered = topAddrs.filter((address) => !priorSet.has(address));
      const left = prior.top.filter((address) => !currentSet.has(address));

      const confidence = deriveHolderConfidence({
        baselineDays,
        feedAgreesWithQuote: asset.feedAgreesWithQuote,
      });

      const direction = deltaPp >= 0 ? "rose" : "fell";
      const parts = [
        `Top-${TOP_N} holder share ${direction} ${fmtPp(deltaPp)} day over day, from ${fmtPct(prior.s)} to ${fmtPct(share)}.`,
      ];
      if (entered.length > 0 || left.length > 0) {
        const movements: string[] = [];
        if (entered.length > 0)
          movements.push(
            `${entered.length} ${entered.length === 1 ? "wallet" : "wallets"} entered the top ${TOP_N}`,
          );
        if (left.length > 0) movements.push(`${left.length} left`);
        parts.push(`${movements.join(", ")}.`);
      }
      if (baselineDays < FULL_BASELINE_DAYS) {
        parts.push(
          `Forward-only indexing since ${state.startedAt.toISOString().slice(0, 10)}, so the baseline covers ${Math.floor(baselineDays)} ${Math.floor(baselineDays) === 1 ? "day" : "days"} and confidence is low.`,
        );
      }
      if (!asset.feedAgreesWithQuote) {
        parts.push(
          "The Chainlink answer and the independent quote disagree for this name, which lowers confidence further.",
        );
      }

      const recent = await loadRecentTransfers(tokenLower);
      const material = recent
        .slice()
        .sort((a, b) => {
          const av = BigInt(a.v);
          const bv = BigInt(b.v);
          return av < bv ? 1 : av > bv ? -1 : 0;
        })
        .slice(0, 3);

      const sources: string[] = [
        `balanceOfUI / totalSupplyUI read at block ${blockNumber}`,
        `forward transfer index covers blocks ${state.startBlock} to ${state.lastBlock}`,
        `${ranked.length} known holder ${ranked.length === 1 ? "address" : "addresses"} for this token`,
      ];
      for (const transfer of material) {
        sources.push(`tx ${transfer.h} at block ${transfer.b}`);
      }
      sources.push(`window ${window.start.toISOString()} to ${window.end.toISOString()}`);

      out.push({
        ticker: asset.symbol,
        tokenAddress: asset.tokenAddress,
        kind: "HOLDER_CONCENTRATION",
        magnitude: deltaPp,
        // No distributional baseline for this kind: zScore carries the point
        // change so the feed ranks a larger concentration move higher.
        zScore: roundZ(deltaPp),
        confidence,
        explanation: parts.join(" "),
        evidence: {
          fromBlock: blockNumber,
          toBlock: blockNumber,
          observed: deltaPp,
          baseline: roundPct(prior.s),
          sampleSize: ranked.length,
        },
        sources,
        window: window.iso,
      });
    }

    log.info("holder-concentration computed", {
      rpcRequests: requests,
      assets: ctx.assets.length,
      baselineDays: Math.floor(baselineDays),
      emitted: out.length,
    });
    return out;
  },
};

registerProcessor(holderConcentrationProcessor);
