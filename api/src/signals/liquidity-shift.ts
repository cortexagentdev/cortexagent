/**
 * LIQUIDITY_SHIFT — pool depth adds and removes against the trailing baseline
 * (BE-16).
 *
 * `spec/CortexBackend.md` PART 3, "Flow / liquidity / holder signals", and
 * locked decision 8. Pool depth moving is an early indicator of liquidity
 * conditions changing, which feeds straight back into whether an asset stays
 * `vaultEligible` (Gate 2 and Gate 3 in BE-5).
 *
 * ## Two sources, both free
 *
 * 1. **Periodic direct depth reads.** `universe/pools.ts` `samplePoolDepth`
 *    reads every configured venue (`getReserves` for a v2 pair, `slot0` for a
 *    v3 pool) through Multicall3, exactly as BE-5's refresher does. Never an
 *    aggregator API (locked decision 8). The USD side of a USDG-quoted pair,
 *    doubled, is that venue's depth; v3 pools are recorded but contribute no
 *    depth until tick math lands.
 * 2. **Pool events from the forward-only indexer.** The BE-15 `Transfer` indexer
 *    already decodes every Stock Token transfer and buffers the recent ones in
 *    Redis. A transfer whose counterparty is a sampled venue is an LP add (into
 *    the pool) or an LP remove (out of it), and its tx hash is the richest
 *    natural sourcing this kind has. Only the Stock Token leg is visible, so the
 *    USD figure on a single contributor is an estimate off `universe.priceUsd`,
 *    not the pool's own accounting.
 *
 * ## The baseline is LIQUIDITY_SHIFT's own, in Redis
 *
 * `signals/baseline.ts` builds its trailing baseline from prior signal rows,
 * which cannot bootstrap a kind that has never fired. Like FLOW and PEG_DRIFT,
 * this processor keeps its own series: every tick it records the total sampled
 * depth keyed by window end, and the signed change since the sample one window
 * earlier is the observation. The 30-day trailing set of those observations is
 * the baseline. A cache flush only costs a rebuild; the series is not
 * authoritative money.
 *
 * ## What fires
 *
 * Any non-zero depth change on an asset with at least one sampled venue and a
 * start-of-window depth to compare against. `magnitude` is the signed USD change
 * in pool depth: positive is depth added, negative is depth withdrawn.
 *
 * A change is **material** when it clears both `SIGNAL_LIQUIDITY_SHIFT_MIN_DEPTH_USD`
 * and `SIGNAL_LIQUIDITY_SHIFT_Z_THRESHOLD` sigma from the baseline. A material
 * change takes the normal confidence ladder (`deriveConfidence`). A change below
 * either gate is **not suppressed**: it is emitted at LOW confidence and the
 * explanation says "below materiality threshold, logged for pattern tracking"
 * (BE-16 scope section 7), so the pattern is still on the record.
 *
 * ## Dormant until a venue is configured
 *
 * `api/data/pools.json` ships empty (no public DEX venue registry for RHC on the
 * free tier), so `hasConfiguredVenues()` is false and this processor returns
 * nothing. Same conservative posture as PEG_DRIFT: a guessed pool address would
 * put a measured-looking depth change on an asset nobody measured.
 */

import { eq, sql } from "drizzle-orm";
import { getAddress, type Address } from "viem";

import { publicClient } from "../chain/client.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import type { Db } from "../db/client.ts";
import { universe } from "../db/schema.ts";
import { env } from "../env.ts";
import { redis } from "../lib/redis.ts";
import { hasConfiguredVenues, samplePoolDepth, usdgDecimalsCall } from "../universe/pools.ts";
import { loadRecentTransfers, type RecentTransfer } from "../workers/transfer-indexer.ts";
import { baselineStats, deriveConfidence, TRAILING_BASELINE_DAYS, zScore } from "./baseline.ts";
import { registerProcessor } from "./registry.ts";
import type {
  Confidence,
  ProcessorContext,
  SignalAsset,
  SignalCandidate,
  SignalProcessor,
  TimeWindow,
} from "./types.ts";

/** Signed USD depth change at or above which the change is treated as material.
 *  A smaller change is emitted at LOW confidence, not dropped. Env-tunable. */
export const LIQUIDITY_SHIFT_MIN_DEPTH_USD = env.SIGNAL_LIQUIDITY_SHIFT_MIN_DEPTH_USD;
/** `|zScore|` of the depth change against the 30-day baseline the change must
 *  also clear to count as material. Env-tunable. */
export const LIQUIDITY_SHIFT_Z_THRESHOLD = env.SIGNAL_LIQUIDITY_SHIFT_Z_THRESHOLD;
/** The window the depth change is measured over, default PT4H. Env-tunable. */
export const LIQUIDITY_SHIFT_WINDOW_ISO = env.SIGNAL_LIQUIDITY_SHIFT_WINDOW_ISO;

/** Seconds in a `PT<n>H<n>M` duration. */
export function isoDurationSec(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!match) {
    throw new Error(`SIGNAL_LIQUIDITY_SHIFT_WINDOW_ISO is not a PT<n>H<n>M duration: ${iso}`);
  }
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60;
}

const LIQUIDITY_SHIFT_WINDOW_SEC = isoDurationSec(LIQUIDITY_SHIFT_WINDOW_ISO);

/** Per-symbol Redis hash of `windowEndMs -> {d: total depth USD, o: signed
 *  window change, b: block}`. */
const DEPTH_KEY_PREFIX = "signals:liqshift:depth:v1:";
const BASELINE_MS = TRAILING_BASELINE_DAYS * 24 * 60 * 60 * 1000;
/** Longer than the baseline so a symbol that stops trading ages out, shorter
 *  than forever so a delisting self-cleans. Matches FLOW and PEG_DRIFT. */
const DEPTH_TTL_SEC = Math.ceil(BASELINE_MS / 1000) + 10 * 24 * 60 * 60;
/** Tx hashes cited per signal. The largest movers carry the story; the rest are
 *  in the block range. */
const MAX_EVENT_SOURCES = 3;

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundZ(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** `+$2.4M`, `-$180.0K`, `+$0`. Sign is always shown: the direction is the point. */
function fmtSignedUsd(value: number): string {
  const sign = value < 0 ? "-" : "+";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** `$2.4M`, `$690.0K`, `$0`. Modelled on the fixture copy in
 *  `src/components/dash/data.ts`. */
function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function fmtQty(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** `PT4H` -> `4h`, `PT90M` -> `90m`, `PT1H30M` -> `1h 30m`. */
function humanizeWindow(iso: string): string {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!match) return iso;
  const parts: string[] = [];
  if (match[1]) parts.push(`${match[1]}h`);
  if (match[2]) parts.push(`${match[2]}m`);
  return parts.join(" ") || "0m";
}

/** LIQUIDITY_SHIFT's own window, anchored to the signal computer's aligned
 *  window end so the deterministic id is unaffected by the duration knob. */
function liquidityShiftWindow(computerWindow: TimeWindow): TimeWindow {
  const end = computerWindow.end;
  return {
    end,
    start: new Date(end.getTime() - LIQUIDITY_SHIFT_WINDOW_SEC * 1000),
    iso: LIQUIDITY_SHIFT_WINDOW_ISO,
  };
}

// --- Redis depth series --------------------------------------------------

interface StoredDepth {
  /** Total sampled depth, USD. */
  d: number;
  /** Signed change since the sample one window earlier, USD, or null when there
   *  was no earlier sample to difference against. */
  o: number | null;
  /** Block the depth read was pinned to. */
  b: number;
}

interface DepthHistory {
  /** Total depth one window before `windowEnd`, or null when no sample sits
   *  close enough to that instant yet. */
  startDepthUsd: number | null;
  /** Block of the start-of-window sample, 0 when unknown. */
  startBlock: number;
  /** Prior windows' signed depth changes, 30-day trailing. */
  baseline: number[];
}

/**
 * Records this window's total depth and returns the start-of-window depth plus
 * the 30-day trailing set of prior window changes.
 *
 * Idempotent on the window: the field is `windowEndMs`, so a recompute
 * overwrites rather than appends, and the current window is never part of its
 * own history. The start-of-window sample is the stored sample closest to
 * `windowEnd - window`, within half a window, so the reported change genuinely
 * spans the window rather than the 15-minute compute cadence.
 */
async function recordAndLoadDepth(
  symbol: string,
  windowEnd: Date,
  current: { d: number; b: number },
): Promise<DepthHistory> {
  const key = DEPTH_KEY_PREFIX + symbol.toUpperCase();
  const field = String(windowEnd.getTime());
  const endMs = windowEnd.getTime();
  const startTarget = endMs - LIQUIDITY_SHIFT_WINDOW_SEC * 1000;
  const startTolerance = Math.max(1000, Math.round((LIQUIDITY_SHIFT_WINDOW_SEC / 2) * 1000));
  const cutoff = endMs - BASELINE_MS;

  const all = await redis.hgetall(key);

  let startDepthUsd: number | null = null;
  let startBlock = 0;
  let startDist = startTolerance + 1;
  const baseline: number[] = [];
  const stale: string[] = [];

  for (const [tsField, value] of Object.entries(all)) {
    const tsMs = Number(tsField);
    if (!Number.isFinite(tsMs) || tsMs < cutoff) {
      stale.push(tsField);
      continue;
    }
    if (tsMs === endMs) continue; // the current window is not part of its own history

    let parsed: StoredDepth;
    try {
      parsed = JSON.parse(value) as StoredDepth;
    } catch {
      stale.push(tsField);
      continue;
    }
    if (typeof parsed.d !== "number" || !Number.isFinite(parsed.d)) continue;

    if (tsMs < endMs && typeof parsed.o === "number" && Number.isFinite(parsed.o)) {
      baseline.push(parsed.o);
    }

    if (tsMs < endMs) {
      const dist = Math.abs(tsMs - startTarget);
      if (dist <= startTolerance && dist < startDist) {
        startDepthUsd = parsed.d;
        startBlock = Number.isFinite(parsed.b) ? Number(parsed.b) : 0;
        startDist = dist;
      }
    }
  }

  const observed = startDepthUsd === null ? null : roundUsd(current.d - startDepthUsd);
  await redis.hset(key, field, JSON.stringify({ d: current.d, o: observed, b: current.b }));
  await redis.expire(key, DEPTH_TTL_SEC);
  if (stale.length > 0) await redis.hdel(key, ...stale);

  return { startDepthUsd, startBlock, baseline };
}

// --- Pool events --------------------------------------------------------

export interface LiquidityEvent {
  txHash: string;
  block: number;
  /** `add` when the Stock Token moved into a venue, `remove` when it moved out. */
  direction: "add" | "remove";
  /** Stock Token units moved. */
  amountTokens: number;
  /** Estimate off `universe.priceUsd`, or null when the asset is unpriceable. */
  amountUsd: number | null;
  /** The non-pool side of the transfer, lowercased. */
  counterparty: string;
  /** Whether `counterparty` has a positive forward-indexed balance for this
   *  token. `false` means "no prior indexed balance", `null` means not checked. */
  counterpartyHasPriorBalance: boolean | null;
  /** The venue address, lowercased. */
  pool: string;
}

/**
 * The pool-touching transfers in the window, valued and sorted largest first.
 *
 * A transfer is a pool event when exactly one side is a sampled venue. Buffered
 * transfers older than the start-of-window block are dropped when that block is
 * known; the buffer is a capped ring, so this is best-effort.
 */
function buildPoolEvents(
  recent: readonly RecentTransfer[],
  poolSet: ReadonlySet<string>,
  opts: { decimals: number; priceUsd: number | null; fromBlock: number },
): LiquidityEvent[] {
  const out: LiquidityEvent[] = [];
  for (const transfer of recent) {
    if (opts.fromBlock > 0 && transfer.b > 0 && transfer.b < opts.fromBlock) continue;

    const intoPool = poolSet.has(transfer.t);
    const outOfPool = poolSet.has(transfer.f);
    if (intoPool === outOfPool) continue; // neither side, or pool-to-pool

    const raw = Number(transfer.v);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const amountTokens = raw / 10 ** opts.decimals;
    if (!(amountTokens > 0)) continue;

    out.push({
      txHash: transfer.h,
      block: transfer.b,
      direction: intoPool ? "add" : "remove",
      amountTokens,
      amountUsd: opts.priceUsd === null ? null : roundUsd(amountTokens * opts.priceUsd),
      counterparty: intoPool ? transfer.f : transfer.t,
      counterpartyHasPriorBalance: null,
      pool: intoPool ? transfer.t : transfer.f,
    });
  }

  out.sort((a, b) => {
    const av = Math.abs(a.amountUsd ?? a.amountTokens);
    const bv = Math.abs(b.amountUsd ?? b.amountTokens);
    return bv - av;
  });
  return out;
}

/**
 * Whether an address has a positive forward-indexed balance for a token.
 *
 * `holder_balances` is forward-only (BE-15), so a `false` here means "no balance
 * since the indexer started", not "provably a new wallet". The explanation is
 * worded to match. A read failure returns null so the claim is simply dropped.
 */
async function lookupPriorBalance(
  db: Db,
  tokenAddress: string,
  address: string,
): Promise<boolean | null> {
  if (address === "") return null;
  try {
    const rows = await db.execute<{ balance: string }>(sql`
      SELECT balance::text AS balance
      FROM holder_balances
      WHERE token_address = ${tokenAddress} AND address = ${address}
      LIMIT 1
    `);
    for (const row of rows) {
      const balance = Number(row.balance);
      return Number.isFinite(balance) && balance > 0;
    }
    return false;
  } catch {
    return null;
  }
}

// --- Pure evaluation ----------------------------------------------------

export interface LiquidityShiftInput {
  asset: SignalAsset;
  /** Total sampled depth now, USD. */
  currentDepthUsd: number;
  /** Total sampled depth one window earlier, or null. */
  startDepthUsd: number | null;
  /** Prior windows' signed depth changes, 30-day trailing. */
  baseline: readonly number[];
  /** Sampled venues for this asset. */
  venues: readonly Address[];
  /** Pool-touching transfers in the window, largest first. */
  events: readonly LiquidityEvent[];
  window: TimeWindow;
  fromBlock: number;
  toBlock: number;
  thresholdUsd: number;
  zThreshold: number;
}

/**
 * Pure evaluation: sampled depth plus baseline plus pool events in, one
 * candidate or null out. No IO, so the same inputs always produce the same
 * signal (BE-16 acceptance criterion 1).
 */
export function evaluateLiquidityShift(input: LiquidityShiftInput): SignalCandidate | null {
  const {
    asset,
    currentDepthUsd,
    startDepthUsd,
    baseline,
    venues,
    events,
    window,
    fromBlock,
    toBlock,
    thresholdUsd,
    zThreshold,
  } = input;

  if (venues.length === 0) return null;
  if (startDepthUsd === null) return null;

  const observed = roundUsd(currentDepthUsd - startDepthUsd);
  if (observed === 0) return null;

  const { mean: baselineMean, sampleSize: observations } = baselineStats(baseline);
  const baselineUsd = roundUsd(baselineMean);
  const z = roundZ(zScore(observed, baseline));

  const material = Math.abs(observed) >= thresholdUsd;
  const zFires = Math.abs(z) >= zThreshold;
  const belowMateriality = !material || !zFires;

  const confidence: Confidence = belowMateriality
    ? "LOW"
    : deriveConfidence({
        sampleSize: observations,
        feedAgreesWithQuote: asset.feedAgreesWithQuote,
      });

  const venueWord = venues.length === 1 ? "venue" : "venues";
  const parts: string[] = [
    `Pool depth ${fmtSignedUsd(observed)} across ${venues.length} sampled ${venueWord} in ${humanizeWindow(window.iso)}, against a 30-day baseline of ${fmtSignedUsd(baselineUsd)}.`,
  ];

  const largest = events[0];
  if (largest) {
    const verb = largest.direction === "add" ? "add" : "removal";
    const size =
      largest.amountUsd !== null
        ? fmtUsd(largest.amountUsd)
        : `${fmtQty(largest.amountTokens)} ${asset.symbol}`;
    const newLp =
      largest.direction === "add" && largest.counterpartyHasPriorBalance === false
        ? " from a wallet with no prior indexed balance"
        : "";
    parts.push(`Largest single ${verb} was ${size}${newLp}.`);
  }

  if (belowMateriality) {
    parts.push("Change is below materiality threshold, logged for pattern tracking.");
  } else if (!asset.feedAgreesWithQuote) {
    parts.push(
      "The Chainlink answer and the independent quote disagree for this name, which lowers confidence.",
    );
  }

  const sources: string[] = venues.map((venue) => `pool ${getAddress(venue)}`);
  for (const event of events.slice(0, MAX_EVENT_SOURCES)) {
    const valued = event.amountUsd !== null ? ` ~${fmtUsd(event.amountUsd)}` : "";
    sources.push(`tx ${event.txHash} at block ${event.block} (${event.direction}${valued})`);
  }
  sources.push(
    `pool depth ${fmtUsd(startDepthUsd)} to ${fmtUsd(currentDepthUsd)} over blocks ${fromBlock} to ${toBlock}`,
  );
  sources.push(
    `30-day baseline over ${observations} ${observations === 1 ? "observation" : "observations"}`,
  );
  sources.push(`window ${window.start.toISOString()} to ${window.end.toISOString()}`);

  return {
    ticker: asset.symbol,
    tokenAddress: asset.tokenAddress,
    kind: "LIQUIDITY_SHIFT",
    // Signed USD: positive is depth added, negative is depth withdrawn.
    magnitude: observed,
    zScore: z,
    confidence,
    explanation: parts.join(" "),
    evidence: {
      fromBlock,
      toBlock,
      observed,
      baseline: baselineUsd,
      // The venue count. A LIQUIDITY_SHIFT sample is the set of venues read this
      // window; the baseline observation count travels in `sources`.
      sampleSize: venues.length,
    },
    sources,
    window: window.iso,
  };
}

// --- The processor -----------------------------------------------------

interface UniverseExtras {
  decimals: number;
  priceUsd: number | null;
}

export const liquidityShiftProcessor: SignalProcessor = {
  kind: "LIQUIDITY_SHIFT",
  async compute(ctx: ProcessorContext, computerWindow: TimeWindow): Promise<SignalCandidate[]> {
    const log = ctx.logger.child({ module: "signals/liquidity-shift" });
    const window = liquidityShiftWindow(computerWindow);

    if (!hasConfiguredVenues()) {
      // No DEX venue registry for RHC on the free tier yet, so there is no pool
      // depth to sample. Dormant, not broken (locked decision 8).
      log.info("liquidity-shift: no DEX venue configured, nothing to sample");
      return [];
    }

    const rows = await ctx.db
      .select({
        tokenAddress: universe.tokenAddress,
        decimals: universe.decimals,
        priceUsd: universe.priceUsd,
      })
      .from(universe)
      .where(eq(universe.signalEligible, true));

    const extras = new Map<string, UniverseExtras>();
    for (const row of rows) {
      extras.set(row.tokenAddress.toLowerCase(), {
        decimals: row.decimals,
        priceUsd: row.priceUsd,
      });
    }

    const chain = await countRpcRequests(
      async () => {
        // Pin every read to one block so the depth reads in this tick agree with
        // each other.
        const blockNumber = await publicClient.getBlockNumber();

        const usdgBatch = (await multicallRead([usdgDecimalsCall()], {
          client: publicClient,
          blockNumber,
        })) as unknown as MulticallItem<unknown>[];
        const usdgRaw = resultOrUndefined(usdgBatch[0]!);
        const usdgDecimals = typeof usdgRaw === "number" ? usdgRaw : 18;

        const pools = await samplePoolDepth(
          ctx.assets.map((asset) => ({
            tokenAddress: getAddress(asset.tokenAddress),
            decimals: extras.get(asset.tokenAddress.toLowerCase())?.decimals ?? 18,
          })),
          { client: publicClient, blockNumber, usdgDecimals },
        );

        return { blockNumber: Number(blockNumber), pools };
      },
      { operation: "research-liquidity-shift", context: "research", priority: "background" },
    );

    const { blockNumber, pools } = chain.value;
    const candidates: SignalCandidate[] = [];

    for (const asset of ctx.assets) {
      const tokenLower = asset.tokenAddress.toLowerCase();
      const pool = pools.get(tokenLower);
      if (!pool || pool.venues.length === 0) continue;

      const extra = extras.get(tokenLower);
      const currentDepthUsd = roundUsd(pool.liquidityUsd);

      const { startDepthUsd, startBlock, baseline } = await recordAndLoadDepth(
        asset.symbol,
        window.end,
        { d: currentDepthUsd, b: blockNumber },
      );
      if (startDepthUsd === null) continue; // no prior depth point; never fabricate one

      const observed = roundUsd(currentDepthUsd - startDepthUsd);
      if (observed === 0) continue;

      // Pool events: Stock Token transfers into or out of a sampled venue,
      // buffered by the forward-only transfer indexer (BE-15).
      const poolSet = new Set(pool.venues.map((venue) => venue.toLowerCase()));
      const recent = await loadRecentTransfers(tokenLower);
      const events = buildPoolEvents(recent, poolSet, {
        decimals: extra?.decimals ?? 18,
        priceUsd: extra?.priceUsd ?? null,
        fromBlock: startBlock,
      });

      // Only the single largest add carries the "new LP" phrasing, so that is
      // the only counterparty worth a lookup.
      const largest = events[0];
      if (largest && largest.direction === "add") {
        largest.counterpartyHasPriorBalance = await lookupPriorBalance(
          ctx.db,
          tokenLower,
          largest.counterparty,
        );
      }

      const eventBlocks = events.map((event) => event.block).filter((block) => block > 0);
      const rawFrom = eventBlocks.length > 0 ? Math.min(...eventBlocks) : startBlock || blockNumber;
      const toBlock = Math.max(0, blockNumber);
      const fromBlock = Math.max(0, Math.min(rawFrom, toBlock));

      const candidate = evaluateLiquidityShift({
        asset,
        currentDepthUsd,
        startDepthUsd,
        baseline,
        venues: pool.venues,
        events,
        window,
        fromBlock,
        toBlock,
        thresholdUsd: LIQUIDITY_SHIFT_MIN_DEPTH_USD,
        zThreshold: LIQUIDITY_SHIFT_Z_THRESHOLD,
      });
      if (candidate) candidates.push(candidate);
    }

    log.info("liquidity-shift computed", {
      rpcRequests: chain.requests,
      assets: ctx.assets.length,
      emitted: candidates.length,
    });
    return candidates;
  },
};

registerProcessor(liquidityShiftProcessor);
