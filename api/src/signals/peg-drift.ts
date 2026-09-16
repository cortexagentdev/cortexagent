/**
 * PEG_DRIFT — on-chain DEX price against the Chainlink reference (BE-12).
 *
 * `spec/CortexBackend.md` PART 3, "Peg / basis + after-hours dislocation":
 * three price sources are read for every feed-carrying name and compared.
 *
 * | Source           | How                                                       |
 * | ---------------- | --------------------------------------------------------- |
 * | DEX              | direct pool reads (`slot0` / `getReserves`) via Multicall3 |
 * | Chainlink        | `latestRoundData().answer` scaled by `uiMultiplier()`      |
 * | Independent quote| `/rhj/prices/{symbol}` bid/ask midpoint                    |
 *
 * The DEX price is a direct pool read, never a routed aggregator quote (locked
 * decision 8): for a peg check you want the pool's own price, and an aggregator
 * would also reintroduce a paid dependency. The venue registry is
 * `api/data/pools.json`, which ships empty, so this processor is dormant until a
 * venue is configured. That is the same conservative posture `universe/pools.ts`
 * takes: a guessed pool address would put a measured-looking divergence on an
 * asset nobody measured.
 *
 * ## Fire condition
 *
 * The DEX price diverges from the Chainlink reference beyond
 * `SIGNAL_PEG_DRIFT_TOLERANCE_PCT`, and that divergence is at least
 * `SIGNAL_PEG_DRIFT_Z_THRESHOLD` sigma from the 30-day trailing baseline. Both
 * gates must trip.
 *
 * ## The official deviation feed
 *
 * `/rhj/price-deviations` is Robinhood's own published peg-deviation feed. Two
 * cases are both worth surfacing (PART 3):
 *
 * - **We fire, their rows are empty.** We detected a divergence their published
 *   feed has not. The explanation says so explicitly.
 * - **They report a deviation we did not detect.** PART 3 calls this "a bug in
 *   our detector". The signal is still emitted, at LOW confidence, with the
 *   disagreement stated rather than hidden.
 *
 * ## Halt suppression
 *
 * When `/rhj/prices` reports `isTradingHalt` for the asset, the signal is
 * suppressed entirely. A halted underlying diverges by construction and
 * reporting that as a peg anomaly is noise.
 *
 * ## The baseline is PEG_DRIFT's own, in Redis
 *
 * `signals/baseline.ts` builds its trailing baseline from prior signal rows,
 * which cannot bootstrap a kind that has never fired. Like FLOW, PEG_DRIFT
 * records every tick's observed divergence to a per-symbol Redis hash keyed by
 * window end, trimmed to 30 days, and reads it back as the sample. A cache
 * flush only costs a rebuild.
 */

import { eq } from "drizzle-orm";
import { getAddress, type Address } from "viem";

import { aggregatorV3Abi } from "../chain/abis/index.ts";
import { publicClient } from "../chain/client.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { universe } from "../db/schema.ts";
import { env } from "../env.ts";
import { redis } from "../lib/redis.ts";
import { fetchPriceDeviations, fetchQuotes } from "../rhj/index.ts";
import { deriveChainlinkPrice, feedAgrees, parseFixed18 } from "../universe/gates.ts";
import {
  hasConfiguredVenues,
  samplePoolDepth,
  usdgDecimalsCall,
  type PoolSample,
} from "../universe/pools.ts";
import {
  baselineStats,
  MIN_SAMPLES_FOR_HIGH,
  MIN_SAMPLES_FOR_MED,
  TRAILING_BASELINE_DAYS,
  zScore,
} from "./baseline.ts";
import { registerProcessor } from "./registry.ts";
import type {
  Confidence,
  ProcessorContext,
  SignalAsset,
  SignalCandidate,
  SignalProcessor,
  TimeWindow,
} from "./types.ts";

/** Cited in `sources`. */
const RHJ_PRICES_ENDPOINT = "GET /rhj/prices/{symbol}";
const RHJ_DEVIATIONS_ENDPOINT = "GET /rhj/price-deviations";

/** Both gates must trip to fire. Env-tunable (BE-12 scope). */
export const PEG_DRIFT_TOLERANCE_PCT = env.SIGNAL_PEG_DRIFT_TOLERANCE_PCT;
export const PEG_DRIFT_Z_THRESHOLD = env.SIGNAL_PEG_DRIFT_Z_THRESHOLD;
/** Below this sampled depth the DEX read is thin: signal capped at LOW. */
export const PEG_DRIFT_MIN_DEPTH_USD = env.SIGNAL_PEG_DRIFT_MIN_DEPTH_USD;

const CONFIDENCE_ORDER: Confidence[] = ["LOW", "MED", "HIGH"];

/** Per-symbol Redis hash of `windowEndMs -> observed divergence percent`. */
const OBS_KEY_PREFIX = "signals:pegdrift:obs:v1:";
const BASELINE_MS = TRAILING_BASELINE_DAYS * 24 * 60 * 60 * 1000;
/** Longer than the baseline so a symbol that stops trading ages out, shorter
 *  than forever so a delisting self-cleans. Matches FLOW. */
const OBS_TTL_SEC = Math.ceil(BASELINE_MS / 1000) + 10 * 24 * 60 * 60;

function obsKey(symbol: string): string {
  return OBS_KEY_PREFIX + symbol.toUpperCase();
}

/** Round a percentage to 4 dp so a value that round-trips through Postgres
 *  `double precision` is the one this processor decided. */
function roundPct(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function roundZ(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** `$2.4M`, `$690.0K`, `$1.2K`. Modelled on the fixture copy in
 *  `src/components/dash/data.ts`. */
function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(a), CONFIDENCE_ORDER.indexOf(b))]!;
}

/**
 * Records this window's observation and returns the 30-day trailing sample that
 * precedes it. Idempotent on the window: the field is `windowEndMs`, so a
 * recompute overwrites rather than appends. Same shape as FLOW's.
 */
async function recordAndLoadBaseline(
  symbol: string,
  windowEnd: Date,
  observed: number,
): Promise<number[]> {
  const key = obsKey(symbol);
  const field = String(windowEnd.getTime());

  await redis.hset(key, field, String(observed));
  await redis.expire(key, OBS_TTL_SEC);

  const all = await redis.hgetall(key);
  const cutoff = windowEnd.getTime() - BASELINE_MS;
  const stale: string[] = [];
  const samples: number[] = [];

  for (const [tsField, value] of Object.entries(all)) {
    const tsMs = Number(tsField);
    if (!Number.isFinite(tsMs) || tsMs < cutoff) {
      stale.push(tsField);
      continue;
    }
    if (tsMs === windowEnd.getTime()) continue;
    const num = Number(value);
    if (Number.isFinite(num)) samples.push(num);
  }

  if (stale.length > 0) await redis.hdel(key, ...stale);
  return samples;
}

// --- Chainlink round decode ------------------------------------------------

interface RoundRead {
  roundId: bigint;
  answer: bigint;
}

/**
 * `latestRoundData()` out of a Multicall3 batch entry, as `roundId` and
 * `answer`. A reverted entry, a malformed tuple, or a non-positive answer is
 * `null` and never a substituted zero: a feed that did not answer and a feed
 * that answered zero lead to opposite decisions (global do-not 2).
 */
function decodeRound(item: MulticallItem<unknown> | undefined): RoundRead | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  if (!Array.isArray(value) || value.length < 2) return null;
  const [roundId, answer] = value as unknown[];
  if (typeof roundId !== "bigint" || typeof answer !== "bigint") return null;
  if (answer <= 0n) return null;
  return { roundId, answer };
}

// --- Pure evaluation ------------------------------------------------------

export interface PegDriftInput {
  asset: SignalAsset;
  /** Direct pool read. Null when no venue was sampled or none was priceable. */
  dexPriceUsd: number | null;
  /** `answer x uiMultiplier`, scaled. Null when the feed read failed. */
  chainlinkPriceUsd: number | null;
  chainlinkRoundId: bigint | null;
  feedAddress: Address | null;
  /** `/rhj/prices` midpoint, the independent third source. Null unless both
   *  bid and ask are present. */
  quoteMid: number | null;
  isTradingHalt: boolean;
  /** Deepest sampled venue, USD. */
  poolDepthUsd: number;
  venues: readonly Address[];
  /** Prior observed divergence percentages, 30-day trailing. */
  baseline: readonly number[];
  window: TimeWindow;
  /** Single block every read was pinned to. */
  blockNumber: number;
  /**
   * `/rhj/price-deviations` cross-check for this symbol:
   * - `true`  upstream lists it,
   * - `false` upstream is clean / omits it,
   * - `null`  the feed could not be read this cycle.
   */
  officialDeviation: boolean | null;
  tolerancePct: number;
  zThreshold: number;
  minDepthUsd: number;
}

/**
 * Pure evaluation: prices plus baseline in, one candidate or null out. No IO,
 * so the same inputs always produce the same signal.
 */
export function evaluatePegDrift(input: PegDriftInput): SignalCandidate | null {
  const {
    asset,
    dexPriceUsd,
    chainlinkPriceUsd,
    chainlinkRoundId,
    feedAddress,
    quoteMid,
    isTradingHalt,
    poolDepthUsd,
    venues,
    baseline,
    window,
    blockNumber,
    officialDeviation,
    tolerancePct,
    zThreshold,
    minDepthUsd,
  } = input;

  // Halt suppression (BE-12 scope section 4). A halted underlying diverges by
  // construction.
  if (isTradingHalt) return null;

  // The comparison is DEX vs Chainlink. Without both there is nothing to say.
  if (dexPriceUsd === null || chainlinkPriceUsd === null) return null;
  if (!(dexPriceUsd > 0) || !(chainlinkPriceUsd > 0)) return null;

  const divergencePct = roundPct(((dexPriceUsd - chainlinkPriceUsd) / chainlinkPriceUsd) * 100);
  const { mean: baselineMean, sampleSize } = baselineStats(baseline);
  const baselinePct = roundPct(baselineMean);
  const z = roundZ(zScore(divergencePct, baseline));

  const beyondTolerance = Math.abs(divergencePct) > tolerancePct;
  const zFires = Math.abs(z) >= zThreshold;
  const weFire = beyondTolerance && zFires;

  const officialReportsIt = officialDeviation === true;
  const officialClean = officialDeviation === false;
  const officialUnknown = officialDeviation === null;

  // We did not fire and their feed does not flag it: nothing to emit.
  if (!weFire && !officialReportsIt) return null;

  const haveQuote = quoteMid !== null && quoteMid > 0;
  const poolThin = minDepthUsd > 0 && poolDepthUsd < minDepthUsd;

  const dexVsChain = feedAgrees(dexPriceUsd, chainlinkPriceUsd, tolerancePct);
  const dexVsQuote = haveQuote ? feedAgrees(dexPriceUsd, quoteMid, tolerancePct) : false;
  const chainVsQuote = haveQuote ? feedAgrees(chainlinkPriceUsd, quoteMid, tolerancePct) : false;

  // Which single source is the outlier, when there is a clean 2-1 split.
  const chainIsOutlier = haveQuote && !dexVsChain && dexVsQuote && !chainVsQuote;
  const dexIsOutlier = haveQuote && !dexVsChain && chainVsQuote && !dexVsQuote;

  let confidence = derivePegConfidence({
    haveQuote,
    poolThin,
    chainIsOutlier,
    dexIsOutlier,
    sampleSize,
  });
  // They report, we did not: PART 3 treats this as a gap in our detector, so it
  // is emitted at LOW confidence with the disagreement stated.
  if (!weFire && officialReportsIt) confidence = "LOW";

  const explanation = buildExplanation({
    symbol: asset.symbol,
    divergencePct,
    z,
    baselinePct,
    tolerancePct,
    weFire,
    officialReportsIt,
    officialClean,
    officialUnknown,
    haveQuote,
    chainIsOutlier,
    dexIsOutlier,
    poolThin,
    poolDepthUsd,
  });

  const sources = [
    ...venues.map((venue) => `pool ${venue}`),
    feedAddress
      ? `Chainlink feed ${feedAddress} round ${chainlinkRoundId ?? "unknown"}`
      : "Chainlink feed address unknown",
    `${RHJ_PRICES_ENDPOINT} symbol=${asset.symbol}`,
    RHJ_DEVIATIONS_ENDPOINT,
    `window ${window.start.toISOString()} to ${window.end.toISOString()}`,
    `block ${blockNumber}`,
  ];

  return {
    ticker: asset.symbol,
    tokenAddress: asset.tokenAddress,
    kind: "PEG_DRIFT",
    // Signed: positive means the DEX is trading above the reference.
    magnitude: divergencePct,
    zScore: z,
    confidence,
    explanation,
    evidence: {
      // Every read pinned to one block, so the range is that single block.
      fromBlock: blockNumber,
      toBlock: blockNumber,
      observed: divergencePct,
      baseline: baselinePct,
      sampleSize,
    },
    sources,
    window: window.iso,
  };
}

/**
 * Confidence from source agreement (BE-12 scope section 5).
 *
 * - **HIGH**: the DEX price and the independent quote agree while the Chainlink
 *   reference is the outlier. Two independent market observations corroborate
 *   the real price and the oracle is the one lagging.
 * - **MED**: only two sources are available (no independent quote), so the
 *   DEX-to-Chainlink divergence cannot be corroborated by a third.
 * - **LOW**: the DEX is the outlier (a thin- or stale-pool artifact is at least
 *   as likely as a genuine dislocation), the three sources do not agree at all,
 *   or the sampled pool is thin.
 *
 * The result is then capped by sample size: a z-score off a handful of
 * observations is arithmetic, not evidence (`signals/baseline.ts`).
 */
function derivePegConfidence(input: {
  haveQuote: boolean;
  poolThin: boolean;
  chainIsOutlier: boolean;
  dexIsOutlier: boolean;
  sampleSize: number;
}): Confidence {
  let base: Confidence;
  if (input.poolThin) base = "LOW";
  else if (input.chainIsOutlier) base = "HIGH";
  else if (!input.haveQuote) base = "MED";
  else base = "LOW";

  const cap: Confidence =
    input.sampleSize < MIN_SAMPLES_FOR_MED
      ? "LOW"
      : input.sampleSize < MIN_SAMPLES_FOR_HIGH
        ? "MED"
        : "HIGH";

  return minConfidence(base, cap);
}

function buildExplanation(input: {
  symbol: string;
  divergencePct: number;
  z: number;
  baselinePct: number;
  tolerancePct: number;
  weFire: boolean;
  officialReportsIt: boolean;
  officialClean: boolean;
  officialUnknown: boolean;
  haveQuote: boolean;
  chainIsOutlier: boolean;
  dexIsOutlier: boolean;
  poolThin: boolean;
  poolDepthUsd: number;
}): string {
  const direction = input.divergencePct >= 0 ? "above" : "below";
  const parts: string[] = [];

  if (input.weFire) {
    parts.push(
      `DEX price is ${fmtPct(Math.abs(input.divergencePct))} ${direction} the Chainlink reference, ` +
        `${Math.abs(input.z).toFixed(1)} sigma from the 30-day baseline of ${fmtPct(input.baselinePct)}.`,
    );

    if (input.chainIsOutlier) {
      parts.push(
        "The independent quote agrees with the DEX price, which points to a lagging Chainlink reference.",
      );
    } else if (input.dexIsOutlier) {
      parts.push(
        "The independent quote agrees with the Chainlink reference, so the DEX price is the outlier.",
      );
    } else if (!input.haveQuote) {
      parts.push("No independent quote was available to break the tie.");
    } else {
      parts.push(
        "The DEX price, the Chainlink reference and the independent quote do not agree with each other.",
      );
    }

    if (input.poolThin) {
      parts.push(
        `Sampled pool depth is thin at ${fmtUsd(input.poolDepthUsd)}, so the DEX read is low-confidence.`,
      );
    }
  } else {
    // Only reached when the official feed flags a deviation we did not.
    parts.push(
      `Our DEX-to-Chainlink check reads ${fmtPct(Math.abs(input.divergencePct))} ${direction} reference, ` +
        `inside the ${fmtPct(input.tolerancePct)} tolerance, so our detector did not fire.`,
    );
  }

  if (input.officialUnknown) {
    parts.push(
      "Robinhood's price-deviation feed could not be read this cycle, so the cross-check is unavailable.",
    );
  } else if (input.officialReportsIt && input.weFire) {
    parts.push(`Robinhood's published price-deviation feed also flags ${input.symbol}.`);
  } else if (input.officialReportsIt && !input.weFire) {
    parts.push(
      `Robinhood's published price-deviation feed flags ${input.symbol} while our detector did not. ` +
        "Per the design this counts as a gap in our detector, not a clean result, so it is emitted at low confidence.",
    );
  } else if (input.officialClean && input.weFire) {
    parts.push(
      `Robinhood's published price-deviation feed shows nothing for ${input.symbol}, ` +
        "so this is a divergence we detected independently.",
    );
  }

  return parts.join(" ");
}

// --- The processor -------------------------------------------------------

interface UniverseExtras {
  decimals: number;
  feedDecimals: number | null;
  uiMultiplier: string;
  poolDepthUsd: number;
}

export const pegDriftProcessor: SignalProcessor = {
  kind: "PEG_DRIFT",
  async compute(ctx: ProcessorContext, window: TimeWindow): Promise<SignalCandidate[]> {
    const log = ctx.logger.child({ module: "signals/peg-drift" });

    if (!hasConfiguredVenues()) {
      // No DEX venue registry for RHC on the free tier yet, so there is no
      // pool price to compare against. Dormant, not broken (locked decision 8).
      log.info("peg-drift: no DEX venue configured, nothing to compare");
      return [];
    }

    const rows = await ctx.db
      .select({
        tokenAddress: universe.tokenAddress,
        decimals: universe.decimals,
        feedDecimals: universe.feedDecimals,
        uiMultiplier: universe.uiMultiplier,
        poolDepthUsd: universe.poolDepthUsd,
      })
      .from(universe)
      .where(eq(universe.signalEligible, true));

    const extras = new Map<string, UniverseExtras>();
    for (const row of rows) {
      extras.set(row.tokenAddress.toLowerCase(), {
        decimals: row.decimals,
        feedDecimals: row.feedDecimals,
        uiMultiplier: row.uiMultiplier,
        poolDepthUsd: Number(row.poolDepthUsd) || 0,
      });
    }

    // REST: the quote sweep and the official deviation feed. Neither depends on
    // the chain reads.
    const quoteSweep = fetchQuotes(ctx.assets.map((asset) => asset.symbol));
    const deviationsResult = fetchPriceDeviations()
      .then((result) => ({ ok: true as const, ...result }))
      .catch((err) => {
        // A failed fetch must not read as "their feed is clean" (rhj header):
        // the cross-check is simply unavailable this cycle.
        log.warn("peg-drift: price-deviations unreachable, cross-check unavailable this tick", {
          err,
        });
        return { ok: false as const };
      });

    const feedAssets = ctx.assets.filter(
      (asset): asset is SignalAsset & { chainlinkFeed: Address } => asset.chainlinkFeed !== null,
    );
    const feedAddresses = [...new Set(feedAssets.map((asset) => getAddress(asset.chainlinkFeed)))];

    const chain = await countRpcRequests(
      async () => {
        // Pin every read to one block so the DEX, Chainlink and USDG reads in this
        // tick agree with each other.
        const blockNumber = await publicClient.getBlockNumber();

        const usdgBatch = (await multicallRead([usdgDecimalsCall()], {
          client: publicClient,
          blockNumber,
        })) as unknown as MulticallItem<unknown>[];
        const usdgRaw = resultOrUndefined(usdgBatch[0]!);
        const usdgDecimals = typeof usdgRaw === "number" ? usdgRaw : 18;

        const feedBatch =
          feedAddresses.length === 0
            ? []
            : ((await multicallRead(
                feedAddresses.map(
                  (address) =>
                    ({ address, abi: aggregatorV3Abi, functionName: "latestRoundData" }) as const,
                ),
                { client: publicClient, blockNumber },
              )) as unknown as MulticallItem<unknown>[]);

        const pools = await samplePoolDepth(
          ctx.assets.map((asset) => ({
            tokenAddress: getAddress(asset.tokenAddress),
            decimals: extras.get(asset.tokenAddress.toLowerCase())?.decimals ?? 18,
          })),
          { blockNumber, usdgDecimals },
        );

        return { blockNumber, feedBatch, pools };
      },
      { operation: "research-peg-drift", context: "research", priority: "background" },
    );

    const { blockNumber, feedBatch, pools } = chain.value;

    const roundFor = new Map<Address, RoundRead>();
    for (const [i, address] of feedAddresses.entries()) {
      const round = decodeRound(feedBatch[i]);
      if (round !== null) roundFor.set(address, round);
    }

    const { quotes, failures } = await quoteSweep;
    for (const failure of failures) {
      log.warn("peg-drift: quote unavailable, asset skipped this tick", {
        symbol: failure.symbol,
        kind: failure.error.kind,
      });
    }

    const deviations = await deviationsResult;
    const officialSymbols: Set<string> | null = deviations.ok
      ? new Set(
          deviations.rows
            .map((row) => row.symbol?.toUpperCase())
            .filter((symbol): symbol is string => typeof symbol === "string"),
        )
      : null;

    const candidates: SignalCandidate[] = [];
    let halted = 0;

    for (const asset of ctx.assets) {
      const extra = extras.get(asset.tokenAddress.toLowerCase());
      if (!extra) continue;

      const quote = quotes.get(asset.symbol.toUpperCase());
      if (quote?.isTradingHalt) {
        halted += 1;
        continue;
      }

      const feedAddress = asset.chainlinkFeed ? getAddress(asset.chainlinkFeed) : null;
      const round = feedAddress ? (roundFor.get(feedAddress) ?? null) : null;
      const uiMultiplier = parseFixed18(extra.uiMultiplier);
      const chainlinkPriceUsd =
        round !== null && extra.feedDecimals !== null && uiMultiplier !== null
          ? deriveChainlinkPrice({
              answer: round.answer,
              feedDecimals: extra.feedDecimals,
              uiMultiplier,
            })
          : null;

      const pool: PoolSample | undefined = pools.get(asset.tokenAddress.toLowerCase());
      const dexPriceUsd = pool?.dexPriceUsd ?? null;
      if (dexPriceUsd === null || chainlinkPriceUsd === null) continue;

      const poolDepthUsd = pool?.poolDepthUsd ?? extra.poolDepthUsd;
      const venues = pool?.venues ?? [];

      const divergencePct = roundPct(((dexPriceUsd - chainlinkPriceUsd) / chainlinkPriceUsd) * 100);
      const baseline = await recordAndLoadBaseline(asset.symbol, window.end, divergencePct);

      const officialDeviation =
        officialSymbols === null ? null : officialSymbols.has(asset.symbol.toUpperCase());

      const candidate = evaluatePegDrift({
        asset,
        dexPriceUsd,
        chainlinkPriceUsd,
        chainlinkRoundId: round?.roundId ?? null,
        feedAddress,
        quoteMid: quote?.mid ?? null,
        isTradingHalt: false,
        poolDepthUsd,
        venues,
        baseline,
        window,
        blockNumber: Number(blockNumber),
        officialDeviation,
        tolerancePct: PEG_DRIFT_TOLERANCE_PCT,
        zThreshold: PEG_DRIFT_Z_THRESHOLD,
        minDepthUsd: PEG_DRIFT_MIN_DEPTH_USD,
      });
      if (candidate) candidates.push(candidate);
    }

    log.info("peg-drift computed", {
      rpcRequests: chain.requests,
      feeds: feedAddresses.length,
      halted,
      emitted: candidates.length,
    });
    return candidates;
  },
};

registerProcessor(pegDriftProcessor);
