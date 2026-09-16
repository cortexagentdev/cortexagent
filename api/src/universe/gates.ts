/**
 * The universe gate, as pure functions.
 *
 * Nothing here touches a chain, a database or the network. Everything the gates
 * decide is decided from plain values, so the most safety-critical logic in the
 * product can be exercised without an RPC endpoint (`spec/CortexBackend.md`
 * PART 2). `universe-refresher.ts` does the reading; this file does the judging.
 *
 * The gate is fail-closed. An asset is excluded unless it positively passes
 * every gate, and every exclusion is named in `ineligibleReasons`, because a
 * silent exclusion is a bug and the UI displays the list (global do-not 5).
 *
 * Four things in here are counter-intuitive and each is deliberate:
 *
 * 1. **Age is never a rejection rule.** These feeds update on 0.5% movement or
 *    every 24h. A feed that has not moved in 14 hours is reporting a calm
 *    market, not a broken oracle, and the stalest feeds measured on RHC are its
 *    most liquid instruments (SGOV, 14h stale on 3.6M daily volume). The
 *    freshness test is agreement with an independent quote (Design Law 3a).
 * 2. **Factory membership is not sufficient.** 203 tokens are factory-deployed
 *    against 96 active. Gate 1 is canonical address AND active status AND
 *    `totalSupply > 0`, or 107 zero-supply ghosts walk in.
 * 3. **Two eligibility flags, not one.** Only 35 of 96 have a Chainlink feed,
 *    and a contract cannot read a REST quote, so signals run over all 96 while
 *    vault constituents come from the 35.
 * 4. **Unpriceable is `null`, never 0** (global do-not 2).
 */

import type { PriceSource } from "@shared/contracts.ts";

// --- Tuning -----------------------------------------------------------------

/**
 * How far the Chainlink answer may sit from the independent quote midpoint
 * before the feed is treated as disagreeing.
 *
 * This must stay above the feed's own 0.5% deviation threshold. A feed that has
 * not updated is guaranteed only to be within 0.5% of the market, so a tolerance
 * at or below 0.5% would mark a perfectly healthy feed as divergent every time
 * the market drifted inside its own band. The rest of the budget covers the
 * bid/ask spread of the quote and the seconds between the two reads.
 */
export const FEED_AGREEMENT_TOLERANCE_PCT = 1;

/**
 * The NAV band a redeem has to hold, in percent.
 *
 * Set above the oracle's 0.5% deviation threshold so bounded oracle mispricing
 * cannot be arbitraged out of a vault (Design Law 3a2). The extra 0.1 is the
 * fee headroom.
 */
export const NAV_BAND_PCT = 0.6;

/**
 * Gate 2 floor, in USD of sampled pool depth.
 *
 * Zero by default, and that is a statement about our own data rather than about
 * the assets: no DEX venue registry for RHC exists on the free tier yet, so
 * `data/pools.json` ships empty and every asset currently samples zero venues.
 * A non-zero floor against zero samples would exclude all 96 names for a reason
 * that is really "Cortex has not surveyed the pools", which is exactly the kind
 * of misattributed exclusion `ineligibleReasons` exists to prevent. Raise it
 * (`UNIVERSE_DEPTH_FLOOR_USD`) once venues are populated.
 */
export const DEFAULT_DEPTH_FLOOR_USD = 0;

/** Gate 3 floor: the smallest redeem worth calling redeemable, in USD. */
export const DEFAULT_MIN_REDEEM_USD = 0;

/** 18-dp fixed point, the scale every Stock Token multiplier uses. */
const WAD = 10n ** 18n;

// --- Reasons ----------------------------------------------------------------

/**
 * Every exclusion string the gate can produce, in one place.
 *
 * Human-readable because the UI renders them verbatim. No em dashes: the repo
 * removed them from user-facing copy deliberately.
 */
export const REASONS = {
  registryUnreachable: "registry unreachable. authenticity unverified",
  registryReadFailed: "on-chain registry read failed. authenticity unverified",
  notInRegistry: "not in the on-chain registry. StockFactory returned address(0)",
  invalidUid: "registry uid is not a bytes32. cannot be checked against the factory",
  delisted: "no longer listed in the registry",
  addressMismatch: "address does not match the factory-canonical address. possible spoof",
  inactive: (status: string) => `inactive: ${status}`,
  supplyUnreadable: "totalSupply could not be read",
  unlaunched: "unlaunched: totalSupply == 0",
  noPrice: "no price from any source",
  feedUnreadable: "Chainlink feed did not return a usable answer",
  feedDisagrees: "feed disagrees with quote",
  noQuoteToCheckFeed: "no independent quote to test the feed against",
  noFeed: "no Chainlink feed",
  feedDirectoryUnavailable: "Chainlink feed directory unavailable. feed coverage unknown",
  depthBelowFloor: (depth: number, floor: number) =>
    `depth below floor: ${depth.toFixed(2)} USD against ${floor.toFixed(2)}`,
  noVenues: "no pool venue sampled for depth",
  redeemBelowFloor: "full redeem does not clear the depth floor",
  oraclePaused: "oracle paused",
  tokenPaused: "token paused",
  paused: "transfers paused",
  tradingHalt: "underlying equity trading halted",
} as const;

// --- Small pure helpers -----------------------------------------------------

/**
 * `now - updatedAt`, clamped at 0.
 *
 * The clamp is not defensive tidiness. A feed on this chain was measured
 * reporting `updatedAt` 14 seconds in the future; without the clamp that lands
 * in the database as a negative age and reads as a bug in the terminal.
 */
export function clampFeedAgeSec(nowSec: number, updatedAtSec: number | null): number | null {
  if (updatedAtSec === null) return null;
  return Math.max(0, Math.floor(nowSec - updatedAtSec));
}

/**
 * Parses an 18-dp decimal string ("1.000000000000000000") into WAD units.
 *
 * Done with strings and BigInt rather than `Number`, because this value is
 * compared for exact equality against an on-chain `uint256` and a float
 * round-trip of `4.000000000000000000` is not reliably `4e18`.
 */
export function parseFixed18(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;

  const negative = trimmed.startsWith("-");
  const [whole = "0", fraction = ""] = trimmed.replace("-", "").split(".");
  // Pad or truncate to exactly 18 decimal places.
  const padded = (fraction + "0".repeat(18)).slice(0, 18);
  const magnitude = BigInt(whole) * WAD + BigInt(padded || "0");
  return negative ? -magnitude : magnitude;
}

/** Formats WAD units back to an 18-dp decimal string. */
export function formatFixed18(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / WAD;
  const fraction = (magnitude % WAD).toString().padStart(18, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * `answer x uiMultiplier`, scaled out of both fixed-point representations.
 *
 * Returns null rather than 0 for a non-positive answer. A feed answering 0 or a
 * negative is a broken round, not a free asset (global do-not 2).
 */
export function deriveChainlinkPrice(input: {
  answer: bigint;
  feedDecimals: number;
  uiMultiplier: bigint;
}): number | null {
  const { answer, feedDecimals, uiMultiplier } = input;
  if (answer <= 0n) return null;
  if (uiMultiplier <= 0n) return null;
  if (!Number.isInteger(feedDecimals) || feedDecimals < 0 || feedDecimals > 36) return null;

  const scaled = Number(answer) / 10 ** feedDecimals;
  const multiplier = Number(uiMultiplier) / Number(WAD);
  const price = scaled * multiplier;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * The agreement test that replaces staleness checking off-chain.
 *
 * Returns false when either side is missing. That is the fail-closed reading:
 * an untested feed is not an agreeing feed, and the caller turns that into a
 * named reason rather than a silent pass.
 */
export function feedAgrees(
  feedPrice: number | null,
  quoteMid: number | null,
  tolerancePct: number = FEED_AGREEMENT_TOLERANCE_PCT,
): boolean {
  if (feedPrice === null || quoteMid === null) return false;
  if (!Number.isFinite(feedPrice) || !Number.isFinite(quoteMid)) return false;
  if (feedPrice <= 0 || quoteMid <= 0) return false;

  const divergencePct = (Math.abs(feedPrice - quoteMid) / quoteMid) * 100;
  return divergencePct <= tolerancePct;
}

// --- Gate 1, authenticity ---------------------------------------------------

export interface AuthenticityInput {
  /** The address `/rhj/assets` claims for this asset. */
  tokenAddress: string;
  /** What `StockFactory.tokenAddress(uid)` returned. `null` when the read
   *  failed, which is not the same as the zero address and must not be
   *  collapsed into it. */
  factoryAddress: string | null;
  /** False when `/rhj/assets` could not be reached at all. */
  registryReachable: boolean;
  assetStatus: string;
  activeStatus: string;
  /** `null` when the read failed. */
  totalSupply: bigint | null;
}

export interface AuthenticityResult {
  authentic: boolean;
  registrySource: "onchain-registry" | "rhj-assets";
  reasons: string[];
}

const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000";

/**
 * Gate 1: factory-canonical address AND active status AND `totalSupply > 0`.
 *
 * All three conditions are evaluated even after one fails, so a row that is
 * both unlaunched and inactive says both things rather than the first thing.
 */
export function evaluateAuthenticity(input: AuthenticityInput): AuthenticityResult {
  const reasons: string[] = [];

  if (!input.registryReachable) {
    // An unreachable registry makes assets non-eligible. It never makes them
    // assumed-authentic, which is why BE-4 raises a typed error instead of
    // returning an empty list.
    return {
      authentic: false,
      registrySource: "rhj-assets",
      reasons: [REASONS.registryUnreachable],
    };
  }

  const registrySource = input.factoryAddress === null ? "rhj-assets" : "onchain-registry";

  if (input.factoryAddress === null) {
    reasons.push(REASONS.registryReadFailed);
  } else if (input.factoryAddress.toLowerCase() === ZERO_ADDRESS_LOWER) {
    // An unknown uid resolves to address(0). Fail-closed by construction.
    reasons.push(REASONS.notInRegistry);
  } else if (input.factoryAddress.toLowerCase() !== input.tokenAddress.toLowerCase()) {
    // A same-ticker token at another address is a spoof. Authenticity is an
    // address match, never a symbol match (global do-not 3).
    reasons.push(REASONS.addressMismatch);
  }

  if (input.assetStatus !== input.activeStatus) {
    reasons.push(REASONS.inactive(input.assetStatus));
  }

  if (input.totalSupply === null) {
    reasons.push(REASONS.supplyUnreadable);
  } else if (input.totalSupply === 0n) {
    // The 107-ghost case: factory-deployed, never launched, zero liquidity.
    reasons.push(REASONS.unlaunched);
  }

  return { authentic: reasons.length === 0, registrySource, reasons };
}

// --- Pricing ----------------------------------------------------------------

export interface PricingInput {
  /** Null for the 61 active names with no feed. */
  chainlinkFeed: string | null;
  /** Raw `latestRoundData().answer`. Null when there is no feed or the read failed. */
  answer: bigint | null;
  feedDecimals: number | null;
  uiMultiplier: bigint | null;
  /** `/rhj/prices` midpoint. The independent counterparty for the agreement test. */
  quoteMid: number | null;
  /** Direct pool read, last resort. Null until a venue registry exists. */
  dexPriceUsd: number | null;
  tolerancePct?: number;
}

export interface PricingResult {
  priceUsd: number | null;
  priceSource: PriceSource | null;
  /** The Chainlink price before the agreement test, for the record. */
  feedPriceUsd: number | null;
  feedAgreesWithQuote: boolean;
  reasons: string[];
}

/**
 * Resolves a price and runs the freshness test.
 *
 * The order is chainlink, then quote, then dex, and it is an order of
 * confidence, not of preference: a feed that fails the agreement test loses to
 * the quote, because the quote is the independent observation and the feed is
 * the one under suspicion.
 *
 * Divergence does not blank the price. It records the quote, flags
 * `feedAgreesWithQuote: false` and names the reason, so the terminal can show a
 * price and say why the asset is not eligible at the same time.
 */
export function resolvePricing(input: PricingInput): PricingResult {
  const reasons: string[] = [];

  const feedPriceUsd =
    input.answer !== null && input.feedDecimals !== null && input.uiMultiplier !== null
      ? deriveChainlinkPrice({
          answer: input.answer,
          feedDecimals: input.feedDecimals,
          uiMultiplier: input.uiMultiplier,
        })
      : null;

  if (input.chainlinkFeed !== null && feedPriceUsd !== null) {
    const agrees = feedAgrees(feedPriceUsd, input.quoteMid, input.tolerancePct);

    if (agrees) {
      // Good regardless of age. This is the SGOV case: a 14-hour-old feed that
      // matches the quote is a calm market, not a broken oracle.
      return {
        priceUsd: feedPriceUsd,
        priceSource: "chainlink",
        feedPriceUsd,
        feedAgreesWithQuote: true,
        reasons,
      };
    }

    reasons.push(input.quoteMid === null ? REASONS.noQuoteToCheckFeed : REASONS.feedDisagrees);
  } else if (input.chainlinkFeed !== null) {
    // The asset has a feed and the feed gave us nothing usable: a reverted read,
    // or an answer of 0 or less. Named rather than silently falling through to
    // the quote, because "there is a feed and it is not answering" is a
    // different fact from "there is no feed".
    reasons.push(REASONS.feedUnreadable);
  }

  if (input.quoteMid !== null && input.quoteMid > 0) {
    return {
      priceUsd: input.quoteMid,
      priceSource: "rhj-quote",
      feedPriceUsd,
      feedAgreesWithQuote: false,
      reasons,
    };
  }

  if (input.dexPriceUsd !== null && input.dexPriceUsd > 0) {
    return {
      priceUsd: input.dexPriceUsd,
      priceSource: "dex",
      feedPriceUsd,
      feedAgreesWithQuote: false,
      reasons,
    };
  }

  reasons.push(REASONS.noPrice);
  return {
    priceUsd: null,
    priceSource: null,
    feedPriceUsd,
    feedAgreesWithQuote: false,
    reasons,
  };
}

// --- Gate 2, liquidity ------------------------------------------------------

export interface LiquidityInput {
  poolDepthUsd: number;
  venueCount: number;
  depthFloorUsd?: number;
}

export interface LiquidityResult {
  passes: boolean;
  reasons: string[];
}

export function evaluateLiquidity(input: LiquidityInput): LiquidityResult {
  const floor = input.depthFloorUsd ?? DEFAULT_DEPTH_FLOOR_USD;

  if (input.poolDepthUsd >= floor) return { passes: true, reasons: [] };

  const reasons = [REASONS.depthBelowFloor(input.poolDepthUsd, floor)];
  // A zero depth from zero sampled venues is a gap in our own venue registry,
  // not a finding about the asset. Say which one it is rather than letting the
  // user read "no liquidity" into "not measured".
  if (input.venueCount === 0) reasons.push(REASONS.noVenues);

  return { passes: false, reasons };
}

// --- Gate 3, redeemability --------------------------------------------------

export interface RedeemInput {
  poolDepthUsd: number;
  navBandPct?: number;
  minRedeemUsd?: number;
}

export interface RedeemResult {
  redeemable: boolean;
  maxRedeemUsd: number;
  reasons: string[];
}

/**
 * Simulates a full redeem against sampled depth.
 *
 * For a constant-product pool, selling a fraction `f` of the asset-side reserve
 * moves the execution price by roughly `f / (1 - f)`. Inverting that for a band
 * `b` gives `f = b / (1 + b)`: the largest slice of depth that still clears
 * inside the NAV band. At a 0.6% band that is about 0.6% of sampled depth,
 * which is deliberately conservative. Deeper concentrated-liquidity venues will
 * beat it, and beating a conservative bound is the safe direction to be wrong.
 */
export function simulateFullRedeem(input: RedeemInput): RedeemResult {
  const band = (input.navBandPct ?? NAV_BAND_PCT) / 100;
  const minRedeem = input.minRedeemUsd ?? DEFAULT_MIN_REDEEM_USD;

  const maxRedeemUsd = Math.max(0, input.poolDepthUsd) * (band / (1 + band));
  const redeemable = maxRedeemUsd >= minRedeem;

  return {
    redeemable,
    maxRedeemUsd,
    reasons: redeemable ? [] : [REASONS.redeemBelowFloor],
  };
}

// --- Advisory flags ---------------------------------------------------------

export interface AdvisoryFlags {
  oraclePaused: boolean;
  tokenPaused: boolean;
  paused: boolean;
  isTradingHalt: boolean;
}

/**
 * The four advisory flags, as reasons.
 *
 * They downgrade vault eligibility and are never a pricing gate on their own
 * (Design Law 3c). A paused token still gets a price and still appears in the
 * feed; it just cannot back a vault, because a vault has to be able to redeem.
 */
export function advisoryReasons(flags: AdvisoryFlags): string[] {
  const reasons: string[] = [];
  if (flags.oraclePaused) reasons.push(REASONS.oraclePaused);
  if (flags.tokenPaused) reasons.push(REASONS.tokenPaused);
  if (flags.paused) reasons.push(REASONS.paused);
  if (flags.isTradingHalt) reasons.push(REASONS.tradingHalt);
  return reasons;
}

// --- The whole gate ---------------------------------------------------------

export interface GateInput {
  authenticity: AuthenticityInput;
  pricing: PricingInput;
  liquidity: LiquidityInput;
  redeem: RedeemInput;
  advisory: AdvisoryFlags;
  /** On-chain `uiMultiplier()`, WAD. Null when the read failed. */
  onchainMultiplier: bigint | null;
  /** `currentMultiplier` from `/rhj/assets`, an 18-dp decimal string. */
  registryMultiplier: string;
  /** Overrides the "no Chainlink feed" reason. The caller sets this when the
   *  feed directory itself was unreachable, because "we could not look" and
   *  "there is no feed" are different facts and both end in the same flag. */
  noFeedReason?: string;
}

export interface GateResult {
  authentic: boolean;
  registrySource: "onchain-registry" | "rhj-assets";
  priceUsd: number | null;
  priceSource: PriceSource | null;
  feedPriceUsd: number | null;
  feedAgreesWithQuote: boolean;
  multiplierMismatch: boolean;
  redeemable: boolean;
  maxRedeemUsd: number;
  signalEligible: boolean;
  vaultEligible: boolean;
  ineligibleReasons: string[];
}

/**
 * The whole gate for one asset.
 *
 * ```
 * signalEligible = authentic && priced by any source
 * vaultEligible  = signalEligible && chainlinkFeed != null && depth >= floor && redeemable
 * ```
 *
 * Two flags because a contract cannot read a REST quote: signals run over all
 * 96 active names, vault constituents come from the 35 with an on-chain feed.
 *
 * `ineligibleReasons` accumulates from every stage, including stages that did
 * not themselves cause the exclusion. A name that is signal-eligible but not
 * vault-eligible carries the reason for the second decision, which is what the
 * three-state eligibility UI (FE-3) renders.
 */
export function evaluateAsset(input: GateInput): GateResult {
  const authenticity = evaluateAuthenticity(input.authenticity);
  const pricing = resolvePricing(input.pricing);
  const liquidity = evaluateLiquidity(input.liquidity);
  const redeem = simulateFullRedeem(input.redeem);
  const advisory = advisoryReasons(input.advisory);

  const registryMultiplier = parseFixed18(input.registryMultiplier);
  const multiplierMismatch =
    input.onchainMultiplier !== null &&
    registryMultiplier !== null &&
    input.onchainMultiplier !== registryMultiplier;

  const hasFeed = input.pricing.chainlinkFeed !== null;

  // A divergent feed is not just a lower-confidence price, it is a
  // non-eligible asset. The reason is already in pricing.reasons.
  const feedTrusted = !hasFeed || pricing.feedAgreesWithQuote;

  const signalEligible = authenticity.authentic && pricing.priceUsd !== null && feedTrusted;
  const vaultEligible =
    signalEligible && hasFeed && liquidity.passes && redeem.redeemable && advisory.length === 0;

  const reasons = new Set<string>([
    ...authenticity.reasons,
    ...pricing.reasons,
    ...advisory,
    // Liquidity and redeemability only bear on the vault flag, so their reasons
    // are recorded only when the asset was otherwise a vault candidate. A name
    // with no feed says "no Chainlink feed", not a depth complaint it can do
    // nothing about.
    ...(signalEligible && hasFeed ? [...liquidity.reasons, ...redeem.reasons] : []),
  ]);

  if (signalEligible && !hasFeed) reasons.add(input.noFeedReason ?? REASONS.noFeed);

  return {
    authentic: authenticity.authentic,
    registrySource: authenticity.registrySource,
    priceUsd: pricing.priceUsd,
    priceSource: pricing.priceSource,
    feedPriceUsd: pricing.feedPriceUsd,
    feedAgreesWithQuote: pricing.feedAgreesWithQuote,
    multiplierMismatch,
    redeemable: redeem.redeemable,
    maxRedeemUsd: redeem.maxRedeemUsd,
    signalEligible,
    vaultEligible,
    ineligibleReasons: [...reasons],
  };
}
