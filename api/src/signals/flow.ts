/**
 * FLOW — authorized-participant issuance flow (BE-11).
 *
 * `spec/CortexBackend.md` PART 3, "Primary issuance flow (free, no archive
 * needed)": `/rhj/prices/{symbol}` returns `mintBurnTokenVolume` and
 * `mintBurnUsdVolume`, the wrapper's own creation and redemption volume. That is
 * authorized-participant flow, structurally different from secondary DEX trading
 * (that is `LIQUIDITY_SHIFT`, BE-16), and it is free: no archive node, no log
 * reconstruction, no paid data (locked decisions 7 and 9).
 *
 * ## No block range
 *
 * Every other FLOW-family processor reconstructs from archive logs and can name
 * the block span it read. This one reads a REST quote and reads no chain at all,
 * so `evidence.fromBlock` / `toBlock` are 0. The window bounds and the quote's
 * own `generatedAt` travel in `sources` instead, which is the real provenance
 * for a REST-derived figure.
 *
 * ## The sign carries meaning
 *
 * `magnitude` is signed USD: positive is net mint (creation), negative is net
 * burn (redemption). The direction comes from `mintBurnTokenVolume` when
 * present, falling back to the sign of `mintBurnUsdVolume`. An absolute value
 * would throw away the one thing the reader most wants to know.
 *
 * ## The baseline is FLOW's own, in Redis
 *
 * `signals/baseline.ts` builds its trailing baseline from prior non-superseded
 * signal rows, which is at most one row per ticker: it cannot bootstrap a kind
 * that has never fired. FLOW keeps its own series instead, exactly the case the
 * baseline helper's header calls out. Every tick's observed net flow is written
 * to a per-symbol Redis hash keyed by window end, trimmed to 30 days, and read
 * back as the sample. No archive, no schema, no paid data (locked decisions 7,
 * 9). A cache flush only costs a rebuild; the series is not authoritative money.
 */

import { env } from "../env.ts";
import { redis } from "../lib/redis.ts";
import { fetchQuotes } from "../rhj/index.ts";
import type { RhjQuote } from "../rhj/index.ts";
import { baselineStats, deriveConfidence, TRAILING_BASELINE_DAYS, zScore } from "./baseline.ts";
import { registerProcessor } from "./registry.ts";
import type {
  ProcessorContext,
  SignalAsset,
  SignalCandidate,
  SignalProcessor,
  TimeWindow,
} from "./types.ts";

/** Cited in `sources` so a reader can re-fetch the exact input. */
const RHJ_PRICES_ENDPOINT = "GET /rhj/prices/{symbol}";

/** `|zScore|` at or above which a FLOW signal fires. Env-tunable (BE-11 scope). */
export const FLOW_Z_THRESHOLD = env.SIGNAL_FLOW_Z_THRESHOLD;
/** The window FLOW labels its observed figure with. Env-tunable, default PT4H. */
export const FLOW_WINDOW_ISO = env.SIGNAL_FLOW_WINDOW_ISO;

/** Seconds in an ISO-8601 `PT<n>H<n>M` duration. */
export function isoDurationSec(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!match) throw new Error(`FLOW_WINDOW_ISO is not a PT<n>H<n>M duration: ${iso}`);
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  return hours * 3600 + minutes * 60;
}

const FLOW_WINDOW_SEC = isoDurationSec(FLOW_WINDOW_ISO);

/** Per-symbol Redis hash of `windowEndMs -> observed net USD`. */
const FLOW_OBS_KEY_PREFIX = "signals:flow:obs:v1:";
const FLOW_BASELINE_MS = TRAILING_BASELINE_DAYS * 24 * 60 * 60 * 1000;
/** Key TTL. Longer than the baseline so a symbol that stops trading ages out
 *  rather than lingering, shorter than forever so a delisting self-cleans. */
const FLOW_OBS_TTL_SEC = Math.ceil(FLOW_BASELINE_MS / 1000) + 10 * 24 * 60 * 60;

function obsKey(symbol: string): string {
  return FLOW_OBS_KEY_PREFIX + symbol.toUpperCase();
}

/**
 * Records this window's observation and returns the 30-day trailing sample that
 * precedes it.
 *
 * Idempotent on the window: the field is `windowEndMs`, so a recompute of the
 * same window overwrites rather than appends. The current window is excluded
 * from its own baseline, matching `loadBaseline`'s `ts < windowEnd`.
 */
async function recordAndLoadBaseline(
  symbol: string,
  windowEnd: Date,
  observed: number,
): Promise<number[]> {
  const key = obsKey(symbol);
  const field = String(windowEnd.getTime());

  await redis.hset(key, field, String(observed));
  await redis.expire(key, FLOW_OBS_TTL_SEC);

  const all = await redis.hgetall(key);
  const cutoff = windowEnd.getTime() - FLOW_BASELINE_MS;
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

/** Seconds in one FLOW window. The lens aggregator (BE-19) buckets on this so it
 *  does not sum the same window's overlapping 15-minute snapshots many times. */
export const FLOW_WINDOW_SECONDS = FLOW_WINDOW_SEC;

/**
 * BE-19 reads this: the signed net authorized-participant mint/burn USD that
 * FLOW has recorded for one symbol over a trailing window.
 *
 * FLOW writes one observation per aligned 15-minute tick, each holding the net
 * mint/burn USD over a `FLOW_WINDOW_SECONDS` span ending at that tick (see
 * `netFlowUsd`). Those spans overlap, so a raw sum would count each window ~16
 * times. This buckets observations onto a non-overlapping `FLOW_WINDOW_SECONDS`
 * grid by their window end, keeps the latest per bucket, and sums those.
 *
 * Deterministic in the observations present: same hash contents, same result.
 * Returns `null` when FLOW has recorded nothing in range, so a caller can tell
 * "no flow data" from "net zero flow" (global do-not 2).
 */
export async function trailingNetFlowUsd(
  symbol: string,
  sinceMs: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const all = await redis.hgetall(obsKey(symbol));
  const bucketMs = FLOW_WINDOW_SEC * 1000;
  const latestPerBucket = new Map<number, { endMs: number; value: number }>();

  for (const [field, raw] of Object.entries(all)) {
    const endMs = Number(field);
    const value = Number(raw);
    if (!Number.isFinite(endMs) || !Number.isFinite(value)) continue;
    if (endMs <= sinceMs || endMs > nowMs) continue;
    const bucket = Math.floor(endMs / bucketMs);
    const current = latestPerBucket.get(bucket);
    if (current === undefined || endMs > current.endMs) {
      latestPerBucket.set(bucket, { endMs, value });
    }
  }

  if (latestPerBucket.size === 0) return null;
  let sum = 0;
  for (const { value } of latestPerBucket.values()) sum += value;
  return roundUsd(sum);
}

/**
 * FLOW's own window, anchored to the signal computer's aligned window end.
 *
 * The id hashes `windowEnd`, which is unchanged, so a different FLOW duration
 * does not fork one logical window into two ids. Only the span the signal
 * reports as covered moves.
 */
function flowWindowFor(computerWindow: TimeWindow): TimeWindow {
  const end = computerWindow.end;
  return {
    end,
    start: new Date(end.getTime() - FLOW_WINDOW_SEC * 1000),
    iso: FLOW_WINDOW_ISO,
  };
}

/** Round to cents so a value that round-trips through Postgres `double precision`
 *  is the one this processor decided (matches `computeRank`'s intent). */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundZ(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** `$2.4M`, `$690.0K`, `-$1.2M`. Modelled on the fixture copy in
 *  `src/components/dash/data.ts`. */
function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
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

type FlowQuote = Pick<RhjQuote, "mintBurnUsdVolume" | "mintBurnTokenVolume" | "generatedAt">;

/**
 * The window's net issuance flow in signed USD, or null when the quote carries
 * no usable mint/burn figure.
 *
 * Sign is the direction of `mintBurnTokenVolume` (net token flow), falling back
 * to the sign of `mintBurnUsdVolume`. Positive is net mint, negative net burn.
 */
export function netFlowUsd(quote: FlowQuote): number | null {
  const usdVolume = quote.mintBurnUsdVolume;
  if (usdVolume === null || usdVolume === 0) return null;

  const directionSource = quote.mintBurnTokenVolume ?? usdVolume;
  const direction = Math.sign(directionSource) || Math.sign(usdVolume);
  const observed = roundUsd(direction * Math.abs(usdVolume));
  return observed === 0 ? null : observed;
}

export interface FlowInput {
  asset: SignalAsset;
  quote: FlowQuote;
  /** Prior observed net-flow values, 30-day trailing, from
   *  `recordAndLoadBaseline`. */
  baseline: readonly number[];
  /** FLOW's window (from `flowWindowFor`). */
  window: TimeWindow;
}

/**
 * Pure evaluation: quote plus baseline in, one candidate or null out. No IO, so
 * the same inputs always produce the same signal (BE-11 acceptance criterion 1).
 */
export function evaluateFlow(input: FlowInput): SignalCandidate | null {
  const { asset, quote, baseline, window } = input;

  const observed = netFlowUsd(quote);
  if (observed === null) return null;

  const { mean: baselineMean, sampleSize } = baselineStats(baseline);
  const z = roundZ(zScore(observed, baseline));
  if (Math.abs(z) < FLOW_Z_THRESHOLD) return null;

  const confidence = deriveConfidence({
    sampleSize,
    feedAgreesWithQuote: asset.feedAgreesWithQuote,
  });

  const baselineUsd = roundUsd(baselineMean);
  const isMint = observed > 0;
  const relation = z >= 0 ? "above" : "below";
  const explanation =
    `Mint/burn flow ${formatUsd(observed)} in ${humanizeWindow(window.iso)}. ` +
    `${Math.abs(z).toFixed(1)} sigma ${relation} the 30-day baseline of ${formatUsd(baselineUsd)}, ` +
    `driven by authorized-participant ${isMint ? "issuance" : "redemption"}.`;

  return {
    ticker: asset.symbol,
    tokenAddress: asset.tokenAddress,
    kind: "FLOW",
    magnitude: observed,
    zScore: z,
    confidence,
    explanation,
    evidence: {
      // REST-derived, no chain logs read: there is no block range (see header).
      fromBlock: 0,
      toBlock: 0,
      observed,
      baseline: baselineUsd,
      sampleSize,
    },
    sources: [
      `${RHJ_PRICES_ENDPOINT} symbol=${asset.symbol}`,
      `window ${window.start.toISOString()} to ${window.end.toISOString()}`,
      `quote generatedAt ${quote.generatedAt.toISOString()}`,
    ],
    window: window.iso,
  };
}

export const flowProcessor: SignalProcessor = {
  kind: "FLOW",
  async compute(ctx: ProcessorContext, computerWindow: TimeWindow): Promise<SignalCandidate[]> {
    const window = flowWindowFor(computerWindow);
    const log = ctx.logger.child({ module: "signals/flow" });

    const { quotes, failures } = await fetchQuotes(ctx.assets.map((asset) => asset.symbol));
    for (const failure of failures) {
      // A delisted or briefly-unavailable symbol is not a defect: skip it, keep
      // the other 95. Never throw for an ordinary partial failure (types.ts).
      log.warn("flow: quote unavailable, asset skipped this tick", {
        symbol: failure.symbol,
        kind: failure.error.kind,
      });
    }

    const candidates: SignalCandidate[] = [];
    for (const asset of ctx.assets) {
      const quote = quotes.get(asset.symbol.toUpperCase());
      if (!quote) continue;

      const observed = netFlowUsd(quote);
      if (observed === null) continue;

      // Record this window's observation, then evaluate against the sample that
      // precedes it. Recording every tick, not just firing ticks, is what lets
      // the baseline exist at all.
      const baseline = await recordAndLoadBaseline(asset.symbol, window.end, observed);
      const candidate = evaluateFlow({ asset, quote, baseline, window });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  },
};

registerProcessor(flowProcessor);
