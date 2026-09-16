/**
 * AFTER_HOURS_DISLOCATION — a price move while the reference market is closed
 * (BE-14).
 *
 * `spec/CortexBackend.md` PART 3, "Peg / basis + after-hours dislocation", and
 * PART 2, "Market sessions and the equity calendar". Tokenized equities trade
 * on-chain 24/7; the underlying equity market does not. The same percentage move
 * is a different event depending on when it happens: during RTH there is a
 * reference price forming and a deep book to trade against, and outside RTH
 * there is neither. This kind is the "outside RTH" case, and only that case.
 *
 * ## Fire condition
 *
 * The on-chain price moved by more than `SIGNAL_AFTER_HOURS_THRESHOLD_PCT` over
 * the window **and** `getSession(window.end)` is not `rth`. A move that large
 * during regular hours is PEG_DRIFT's or LIQUIDITY_SHIFT's business, so this
 * processor returns nothing at all when the market is open, even on a huge move
 * (BE-14 acceptance criterion 1).
 *
 * ## Halts are checked separately
 *
 * A per-name trading halt from `/rhj/prices` `isTradingHalt` is not a calendar
 * event (`lib/session.ts` header). A halted name during RTH is not "after
 * hours": the market is open and that one name is not trading. The two gates are
 * independent and both suppress the signal:
 *
 * - not `rth`  — required to fire at all,
 * - not halted — a halted underlying dislocates by construction and reporting
 *   that as an overnight move is noise.
 *
 * ## Confidence never reaches HIGH
 *
 * An overnight move sits on a thin book with no forming reference price to
 * corroborate it, so it is weak evidence by nature and the terminal must not
 * present it as equal to an RTH signal (BE-14 scope section 3). Base confidence
 * is MED on a deep sampled book and LOW on a thin or unsampled one, then one
 * notch down again if the Chainlink answer and the independent quote disagree
 * for this asset.
 *
 * ## magnitude, zScore and the baseline
 *
 * `magnitude` is the signed percentage move over the window: positive is up,
 * negative is down. A dislocation is a discrete event, not a draw from a
 * distribution, so there is no trailing baseline and `zScore` in the
 * FLOW / PEG_DRIFT sense does not exist. `zScore` instead carries the size of
 * the move so the feed ranks a 6% overnight gap above a 2.5% one;
 * `evidence.baseline` is 0 (no move) and `evidence.sampleSize` is 0, the honest
 * statement that this kind has no statistical baseline.
 *
 * ## Where the prices come from
 *
 * The two ends of the window are read from `price_history` (BE-6): the newest
 * sample at or before `window.start` and the newest at or before `window.end`,
 * each within a 30-minute lookbehind. No chain is read here, so
 * `evidence.fromBlock` / `toBlock` are 0 and the observation timestamps travel
 * in `sources`. Sampled pool depth and the venue addresses come from the
 * `universe` row, which BE-5's refresher keeps current; re-reading pools here
 * would double the chain budget for a number that only shades confidence.
 */

import { eq, sql } from "drizzle-orm";

import type { MarketSession } from "@shared/contracts.ts";

import type { Db } from "../db/client.ts";
import { universe } from "../db/schema.ts";
import { env } from "../env.ts";
import { getSession, MARKET_CALENDAR_VERSION } from "../lib/session.ts";
import { fetchQuotes } from "../rhj/index.ts";
import { registerProcessor } from "./registry.ts";
import type {
  Confidence,
  ProcessorContext,
  SignalAsset,
  SignalCandidate,
  SignalProcessor,
  TimeWindow,
} from "./types.ts";

/** Cited in `sources` so a reader can re-fetch the exact input. */
const RHJ_PRICES_ENDPOINT = "GET /rhj/prices/{symbol}";

/** `|move|` in percent at or above which the signal fires. Env-tunable. */
export const AFTER_HOURS_THRESHOLD_PCT = env.SIGNAL_AFTER_HOURS_THRESHOLD_PCT;
/** The window the move is measured over, default PT2H. Env-tunable. */
export const AFTER_HOURS_WINDOW_ISO = env.SIGNAL_AFTER_HOURS_WINDOW_ISO;
/** Sampled depth below which the overnight book is thin: signal capped at LOW. */
export const AFTER_HOURS_MIN_DEPTH_USD = env.SIGNAL_AFTER_HOURS_MIN_DEPTH_USD;

/** Seconds in a `PT<n>H<n>M` duration. */
export function isoDurationSec(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!match) throw new Error(`SIGNAL_AFTER_HOURS_WINDOW_ISO is not a PT<n>H<n>M duration: ${iso}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60;
}

const AFTER_HOURS_WINDOW_SEC = isoDurationSec(AFTER_HOURS_WINDOW_ISO);

/**
 * How far behind a window end a `price_history` sample may sit and still stand
 * in for it. One half of `price-series.ts`'s step: at a 60s poll a healthy
 * series has ~30 samples inside this, so needing to reach back further means the
 * poller was down and the two ends of the window are not a clean pair.
 */
const SAMPLE_LOOKBEHIND_SEC = 30 * 60;

/** `PT2H` -> `2h`, `PT90M` -> `90m`, `PT1H30M` -> `1h 30m`. */
function humanizeWindow(iso: string): string {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!match) return iso;
  const parts: string[] = [];
  if (match[1]) parts.push(`${match[1]}h`);
  if (match[2]) parts.push(`${match[2]}m`);
  return parts.join(" ") || "0m";
}

/** Round a percentage to 4 dp so the value that round-trips through Postgres
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

/** `$2.4M`, `$690.0K`, `$1.2K`, `$0`. Modelled on the fixture copy in
 *  `src/components/dash/data.ts`. */
function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function fmtPrice(value: number): string {
  return `$${value.toFixed(4)}`;
}

function isPrice(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Human phrase for the session state, for the explanation. `rth` is guarded
 *  out before this is reached. */
function sessionPhrase(session: MarketSession): string {
  switch (session) {
    case "pre":
      return "during the pre-market session, before the US equity market opens";
    case "after":
      return "during the after-hours session, after the US equity market close";
    case "closed":
      return "while the US equity market is closed";
    case "rth":
      return "during regular trading hours";
  }
}

// --- Pure evaluation ------------------------------------------------------

export interface AfterHoursInput {
  asset: SignalAsset;
  /** `getSession(window.end)`. The signal never fires when this is `rth`. */
  session: MarketSession;
  /** `/rhj/prices` per-name halt. Suppresses the signal independently of the
   *  session (BE-14 scope section 4). */
  isTradingHalt: boolean;
  /** Newest `price_history` price at or before `window.start`. */
  startPrice: number | null;
  startObservedAt: Date | null;
  startSource: string | null;
  /** Newest `price_history` price at or before `window.end`. */
  endPrice: number | null;
  endObservedAt: Date | null;
  endSource: string | null;
  /** Deepest sampled venue for this asset, USD. 0 when no venue was sampled. */
  poolDepthUsd: number;
  /** Pool addresses the depth was sampled from. */
  venues: readonly `0x${string}`[];
  window: TimeWindow;
  thresholdPct: number;
  minDepthUsd: number;
}

/**
 * Pure evaluation: the two window-end prices plus the session and halt state in,
 * one candidate or null out. No IO, so a fixture drives it directly and the same
 * inputs always produce the same signal.
 */
export function evaluateAfterHours(input: AfterHoursInput): SignalCandidate | null {
  const {
    asset,
    session,
    isTradingHalt,
    startPrice,
    startObservedAt,
    startSource,
    endPrice,
    endObservedAt,
    endSource,
    poolDepthUsd,
    venues,
    window,
    thresholdPct,
    minDepthUsd,
  } = input;

  // Session gate (BE-14 acceptance criterion 1). A move this size during RTH is
  // a different kind's signal.
  if (session === "rth") return null;

  // Halt suppression (BE-14 acceptance criterion 4), checked independently of
  // the session.
  if (isTradingHalt) return null;

  if (!isPrice(startPrice) || !isPrice(endPrice)) return null;
  if (startObservedAt === null || endObservedAt === null) return null;

  const movePct = roundPct(((endPrice - startPrice) / startPrice) * 100);
  if (Math.abs(movePct) <= thresholdPct) return null;

  const poolThin = poolDepthUsd <= 0 || (minDepthUsd > 0 && poolDepthUsd < minDepthUsd);
  const confidence = deriveAfterHoursConfidence({
    poolThin,
    feedAgreesWithQuote: asset.feedAgreesWithQuote,
  });

  const direction = movePct >= 0 ? "up" : "down";
  const explanationParts = [
    `${asset.symbol} is ${direction} ${fmtPct(Math.abs(movePct))} over ${humanizeWindow(window.iso)} ${sessionPhrase(session)}.`,
    "The reference equity market is not forming a price, so there is nothing to mark this move against.",
  ];
  if (poolThin) {
    explanationParts.push(
      `On-chain depth${poolDepthUsd > 0 ? ` is thin at ${fmtUsd(poolDepthUsd)}` : " was not sampled"}, so confidence is reduced on thin overnight depth.`,
    );
  } else {
    explanationParts.push(`Sampled on-chain depth is ${fmtUsd(poolDepthUsd)}.`);
  }
  if (!asset.feedAgreesWithQuote) {
    explanationParts.push(
      "The Chainlink answer and the independent quote disagree for this name, which lowers confidence further.",
    );
  }

  const sources: string[] = [
    `price observation ${fmtPrice(startPrice)} at ${startObservedAt.toISOString()} source=${startSource ?? "unknown"}`,
    `price observation ${fmtPrice(endPrice)} at ${endObservedAt.toISOString()} source=${endSource ?? "unknown"}`,
  ];
  if (venues.length > 0) sources.push(...venues.map((venue) => `pool ${venue}`));
  else sources.push("no pool venue sampled for depth");
  sources.push(
    `session ${session} at ${window.end.toISOString()} per market calendar ${MARKET_CALENDAR_VERSION}`,
  );
  sources.push(`window ${window.start.toISOString()} to ${window.end.toISOString()}`);

  return {
    ticker: asset.symbol,
    tokenAddress: asset.tokenAddress,
    kind: "AFTER_HOURS_DISLOCATION",
    magnitude: movePct,
    // No distributional baseline: this carries the move size so ranking still
    // orders a large dislocation above a small one.
    zScore: roundZ(movePct),
    confidence,
    explanation: explanationParts.join(" "),
    evidence: {
      // Prices are read from price_history, no chain logs: there is no block
      // range (see header).
      fromBlock: 0,
      toBlock: 0,
      observed: movePct,
      baseline: 0,
      sampleSize: 0,
    },
    sources,
    window: window.iso,
  };
}

/**
 * Confidence for an after-hours dislocation (BE-14 scope section 3).
 *
 * - **MED** at best: a deep sampled book, no feed disagreement. Never HIGH,
 *   because there is no forming reference price to corroborate the move.
 * - **LOW**: a thin or unsampled book, or the feed disagrees with the quote for
 *   this name. The two weaknesses compound: a thin book on a disagreeing feed is
 *   still LOW, not below it.
 */
function deriveAfterHoursConfidence(input: {
  poolThin: boolean;
  feedAgreesWithQuote: boolean;
}): Confidence {
  const order: Confidence[] = ["LOW", "MED", "HIGH"];
  let level = input.poolThin ? 0 : 1; // LOW or MED, never HIGH
  if (!input.feedAgreesWithQuote) level -= 1;
  return order[Math.max(0, level)]!;
}

// --- The processor -------------------------------------------------------

interface WindowObservation {
  price: number;
  ts: Date;
  source: string | null;
}

interface WindowPrices {
  start: WindowObservation | null;
  end: WindowObservation | null;
}

/**
 * The price at each end of the window for every asset: the newest
 * `price_history` sample at or before the target, within `SAMPLE_LOOKBEHIND_SEC`.
 *
 * One statement, not 2N: the targets are a two-row VALUES list, the addresses
 * are an array, and the lateral join takes the newest row per (address, target)
 * off the `(token_address, ts)` primary key. A target with no sample inside its
 * lookbehind comes back null, which is what makes an unmeasurable window visible
 * instead of guessed.
 */
async function loadWindowPrices(
  db: Db,
  addresses: readonly string[],
  window: TimeWindow,
): Promise<Map<string, WindowPrices>> {
  const out = new Map<string, WindowPrices>();
  for (const address of addresses) out.set(address.toLowerCase(), { start: null, end: null });
  if (addresses.length === 0) return out;

  const addressList = sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  );
  // A constant, not input. Interpolated because a bound parameter inside
  // make_interval() has no type for Postgres to infer.
  const lookbehind = sql.raw(`make_interval(secs => ${SAMPLE_LOOKBEHIND_SEC})`);

  const rows = await db.execute<{
    token_address: string;
    idx: number;
    price: string | null;
    ts: string | null;
    source: string | null;
  }>(sql`
    SELECT a.token_address, t.idx, s.price, s.ts, s.source
    FROM unnest(ARRAY[${addressList}]::text[]) AS a(token_address)
    CROSS JOIN (VALUES
      (0, ${window.start.toISOString()}::timestamptz),
      (1, ${window.end.toISOString()}::timestamptz)
    ) AS t(idx, target)
    LEFT JOIN LATERAL (
      SELECT h.price, h.ts, h.source
      FROM price_history h
      WHERE h.token_address = a.token_address
        AND h.ts <= t.target
        AND h.ts > t.target - ${lookbehind}
      ORDER BY h.ts DESC
      LIMIT 1
    ) s ON TRUE
  `);

  for (const row of rows) {
    const entry = out.get(row.token_address.toLowerCase());
    if (!entry || row.price === null || row.ts === null) continue;
    // numeric and timestamptz arrive as strings. Convert here rather than cast
    // in SQL, so the values that land in the signal are the ones Postgres stored.
    const observation: WindowObservation = {
      price: Number(row.price),
      ts: new Date(row.ts),
      source: row.source,
    };
    if (Number(row.idx) === 0) entry.start = observation;
    else if (Number(row.idx) === 1) entry.end = observation;
  }

  return out;
}

/** AFTER_HOURS's own window, anchored to the computer's aligned window end so
 *  the deterministic signal id is unaffected by the duration knob. */
function afterHoursWindow(computerWindow: TimeWindow): TimeWindow {
  const end = computerWindow.end;
  return {
    end,
    start: new Date(end.getTime() - AFTER_HOURS_WINDOW_SEC * 1000),
    iso: AFTER_HOURS_WINDOW_ISO,
  };
}

interface UniverseDepthExtras {
  poolDepthUsd: number;
  venues: `0x${string}`[];
}

export const afterHoursProcessor: SignalProcessor = {
  kind: "AFTER_HOURS_DISLOCATION",
  async compute(ctx: ProcessorContext, computerWindow: TimeWindow): Promise<SignalCandidate[]> {
    const log = ctx.logger.child({ module: "signals/after-hours" });
    const window = afterHoursWindow(computerWindow);
    const session = getSession(window.end);

    if (session === "rth") {
      // Regular hours: a move this size is PEG_DRIFT's or LIQUIDITY_SHIFT's, not
      // this kind's (BE-14 acceptance criterion 1). Nothing to compute.
      log.info("after-hours: regular trading hours, nothing to compute");
      return [];
    }

    const rows = await ctx.db
      .select({
        tokenAddress: universe.tokenAddress,
        poolDepthUsd: universe.poolDepthUsd,
        venues: universe.venues,
      })
      .from(universe)
      .where(eq(universe.signalEligible, true));

    const extras = new Map<string, UniverseDepthExtras>();
    for (const row of rows) {
      extras.set(row.tokenAddress.toLowerCase(), {
        poolDepthUsd: Number(row.poolDepthUsd) || 0,
        venues: row.venues ?? [],
      });
    }

    // REST: the halt state. Independent of the price reads, so it runs alongside.
    const quoteSweep = fetchQuotes(ctx.assets.map((asset) => asset.symbol));
    const prices = await loadWindowPrices(
      ctx.db,
      ctx.assets.map((asset) => asset.tokenAddress),
      window,
    );

    const { quotes, failures } = await quoteSweep;
    for (const failure of failures) {
      // A missing quote means the halt state is unknown this tick. Treated as
      // not halted, matching FLOW and PEG_DRIFT: a briefly unavailable symbol is
      // not a defect.
      log.warn("after-hours: quote unavailable, halt state unknown for asset", {
        symbol: failure.symbol,
        kind: failure.error.kind,
      });
    }

    const candidates: SignalCandidate[] = [];
    let halted = 0;

    for (const asset of ctx.assets) {
      const quote = quotes.get(asset.symbol.toUpperCase());
      if (quote?.isTradingHalt) {
        halted += 1;
        continue;
      }

      const extra = extras.get(asset.tokenAddress.toLowerCase());
      const windowPrices = prices.get(asset.tokenAddress.toLowerCase());

      const candidate = evaluateAfterHours({
        asset,
        session,
        isTradingHalt: false,
        startPrice: windowPrices?.start?.price ?? null,
        startObservedAt: windowPrices?.start?.ts ?? null,
        startSource: windowPrices?.start?.source ?? null,
        endPrice: windowPrices?.end?.price ?? null,
        endObservedAt: windowPrices?.end?.ts ?? null,
        endSource: windowPrices?.end?.source ?? null,
        poolDepthUsd: extra?.poolDepthUsd ?? 0,
        venues: extra?.venues ?? [],
        window,
        thresholdPct: AFTER_HOURS_THRESHOLD_PCT,
        minDepthUsd: AFTER_HOURS_MIN_DEPTH_USD,
      });
      if (candidate) candidates.push(candidate);
    }

    log.info("after-hours computed", {
      session,
      assets: ctx.assets.length,
      halted,
      emitted: candidates.length,
    });
    return candidates;
  },
};

registerProcessor(afterHoursProcessor);
