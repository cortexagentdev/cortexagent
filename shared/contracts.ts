// shared/contracts.ts

export type SignalKind =
  | "FLOW"
  | "LIQUIDITY_SHIFT"
  | "HOLDER_CONCENTRATION"
  | "PEG_DRIFT"
  | "AFTER_HOURS_DISLOCATION"
  | "CORPORATE_ACTION";
// NOTE: SENTIMENT is intentionally absent. See A5 decision 3.

export type Confidence = "HIGH" | "MED" | "LOW";

export interface SignalEvidence {
  fromBlock: number;
  toBlock: number;
  observed: number;
  baseline: number;
  sampleSize: number;
}

export interface Signal {
  id: string;                       // deterministic: hash(kind|ticker|windowEnd)
  ts: string;                       // ISO 8601
  ticker: string;
  tokenAddress: `0x${string}`;
  kind: SignalKind;
  magnitude: number;                // signed, kind-native unit
  zScore: number;
  rank: number;                     // feed ordering score
  confidence: Confidence;
  explanation: string;              // plain language, mandatory
  evidence: SignalEvidence;
  sources: string[];                // tx hashes, feed round ids, pool addresses
  window: string;                   // ISO 8601 duration, e.g. "PT4H"
  afterHours: boolean;
  supersededBy: string | null;
}

export type PriceSource = "chainlink" | "rhj-quote" | "dex";

/** Display projection returned by universeRouter.list() */
export interface UniverseRow {
  symbol: string;
  name: string;
  tokenAddress: `0x${string}`;
  priceUsd: number | null;          // null when unpriceable. NEVER 0
  change24hPct: number | null;
  feedAgeSec: number | null;        // seconds, clamped at 0. Format at render
  feedAgreesWithQuote: boolean;
  signalEligible: boolean;
  vaultEligible: boolean;
  ineligibleReasons: string[];
  spark: number[];                  // downsampled 24h series for the sparkline
}

/** Full record returned by universeRouter.byAddress(). Mirrors CortexBackend.md PART 2. */
export interface UniverseAsset extends UniverseRow {
  decimals: number;
  onchainUid: string;
  authentic: boolean;
  registrySource: "onchain-registry" | "rhj-assets";
  registryCheckedAt: string;
  assetStatus: string;
  chainlinkFeed: `0x${string}` | null;
  feedDecimals: number | null;
  heartbeatSec: number | null;
  quoteBid: number | null;
  quoteAsk: number | null;
  uiMultiplier: string;
  newUIMultiplier: string;
  multiplierEffectiveAt: number;
  registryMultiplier: string;
  multiplierMismatch: boolean;
  lastAnswer: string | null;
  lastUpdatedAt: number | null;
  oraclePaused: boolean;
  tokenPaused: boolean;
  paused: boolean;
  isTradingHalt: boolean;
  priceSource: PriceSource | null;
  liquidityUsd: number;
  poolDepthUsd: number;
  venues: `0x${string}`[];
  redeemable: boolean;
  maxRedeemUsd: number;
  sector: string | null;
  factors: string[];
  jurisdictionBlocks: string[];
  refreshedAt: string;
}

export type MarketSession = "pre" | "rth" | "after" | "closed";

export interface OverviewStats {
  session: MarketSession;
  signals24h: number;
  signals24hDeltaPct: number;
  feedAgreementPct: number;
  feedsTotal: number;
  assetsActive: number;
  vaultEligibleCount: number;
  multiplierMismatchesToday: number;
}

export interface LensMember {
  symbol: string;
  weightPct: number;
  change24hPct: number | null;
}

export interface LensSummary {
  slug: string;
  name: string;
  color: string;
  movePct: number;
  netFlowUsd: number;
  memberCount: number;
  series: number[];
}

export interface LensDetail extends LensSummary {
  thesis: string;
  signalCount24h: number;
  members: LensMember[];
  vaultTokenId: string | null;
}

export interface AlertRule {
  id: string;
  kind: SignalKind | "ANY";
  ticker: string;                   // symbol or "ANY"
  threshold: number;                // z-score, 1.5 to 5.0
  active: boolean;
  fires: number;                    // rolling 30d
  lastFiredAt: string | null;
  createdAt: string;
}

/**
 * One entry in the alert delivery surface: a rule that matched a signal.
 * `alertRouter.fires()` returns these newest first, each joined to the rule that
 * matched and the signal that triggered it. `signal` is null when the matched
 * signal row can no longer be read (it aged out of its window).
 */
export interface AlertFire {
  id: string;
  alertId: string;
  signalId: string;
  ts: string;                       // matched signal's window end, ISO 8601
  seenAt: string | null;            // null until the terminal marks it seen
  rule: {
    kind: SignalKind | "ANY";
    ticker: string;
    threshold: number;
  };
  signal: {
    ticker: string;
    kind: SignalKind;
    zScore: number;
    explanation: string;
    confidence: Confidence;
  } | null;
}

export interface VaultConstituent {
  symbol: string;
  tokenAddress: `0x${string}`;
  targetWeightPct: number;
  actualWeightPct: number;
  priceUsd: number | null;
  paused: boolean;
  halted: boolean;
}

export interface VaultSummary {
  tokenId: string;
  name: string;
  symbol: string;
  navPerShare: number;
  indicative: boolean;              // true when market closed or any feed stale
  aumUsd: number;
  driftPct: number;
  constituents: VaultConstituent[];
  feedCoverage: { withFeed: number; total: number };
  /** Chain observation start, or the indexed row's actual timestamp. */
  observedAt: string | null;
  /** Block pinned for a chain-backed display read; null for indexed fallback. */
  observedBlock: string | null;
  /** Whether the displayed state came from the chain or the indexed fallback. */
  source: "chain" | "indexed";
}

/* --- Shareable Research Cards ---------------------------------------------
   A card is a citable snapshot of one piece of Cortex research, built to leave
   the terminal: a group chat, a timeline, a README. Signals, asset-quality
   reads and lenses project into the same shape, so the renderer never learns
   what a subject is and a new card costs a projection rather than a layout. */

export type ResearchCardKind = "signal" | "asset" | "lens";

/** One labelled figure on a card. `value` arrives display-ready, because the
 *  card is rendered to a PNG by a service with none of the UI's formatters, and
 *  the two must not drift into formatting a number differently. */
export interface ResearchCardStat {
  label: string;
  value: string;
  /** Figures that should line up in the mono face, as they do in the terminal. */
  mono: boolean;
}

export interface ResearchCardSnapshot {
  kind: ResearchCardKind;
  /** Canonical and stable. For a signal, the signal's own deterministic id; for
   *  an asset, its lower-case token address; for a lens, its slug. */
  id: string;
  /** Path of the public card page, origin-relative so either host can serve it. */
  path: string;
  headline: string;
  /** The plain-language read from the signal, asset-quality, or lens projection. */
  summary: string;
  /** Brand hex the card is keyed to, taken from the subject's own colour. */
  accent: string;
  /** Short qualifier, e.g. a confidence grade. Null when the subject has none. */
  badge: string | null;
  stats: ResearchCardStat[];
  /** The one-line proof under the figures: what was observed against what was
   *  expected, and over which blocks. Too long to survive a stat tile without
   *  wrapping, and too central to the claim to leave off the image. Null when
   *  the subject has no such reading. */
  evidenceLine: string | null;
  /** Tx hashes, feed round ids, pool addresses. Empty is a fact, not a gap. */
  sources: string[];
  /** When the underlying research was computed. The card's "as of". */
  asOf: string;
  /** When this document was produced. Differs from `asOf` for a live subject. */
  generatedAt: string;
  /** True when the subject can never change again, so the card is a permanent
   *  record; false when it is a reading of something still moving. */
  immutable: boolean;
  /** What this card could not establish, named rather than rendered as a zero.
   *  Empty means everything above was read successfully. */
  unavailable: string[];
}
