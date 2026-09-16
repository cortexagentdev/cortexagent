import { z } from "zod";

/**
 * Wire schemas for the free Robinhood `/rhj` REST API, plus the domain shapes
 * the rest of the service consumes.
 *
 * Two layers on purpose:
 *
 * - The `*Wire` schemas mirror the upstream JSON exactly, including its habit of
 *   sending every decimal as a string and an absent value as `""`. They are
 *   strict about the fields we depend on, so an upstream shape change fails at
 *   the boundary instead of quietly writing nonsense into the universe table.
 * - The `Rhj*` domain types are what callers see: numbers where a number is
 *   meant, `null` where the value is genuinely absent, and no empty strings.
 *
 * Money-like registry values (`currentMultiplier`) stay strings. They are 18-dp
 * fixed point and `CortexBackend.md` PART 5 stores them as strings for that
 * reason; turning them into floats would lose the exactness the on-chain
 * comparison in BE-13 depends on.
 */

// --- Primitives -------------------------------------------------------------

/** A decimal that upstream always sends, e.g. `"183.23"`, `"1.000000000000000000"`. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "expected a decimal string");

/** A decimal that upstream may send as `""` to mean "no value". */
const optionalDecimalString = z.union([decimalString, z.literal("")]);

/** `""` is upstream's absent marker, not a value. */
const optionalString = z.string();

const addressString = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");

export function toNumber(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toNullable(value: string): string | null {
  return value === "" ? null : value;
}

// --- Deployments ------------------------------------------------------------

/**
 * Every `/rhj` object carries the same deployment list. Observed: exactly one
 * entry, chain 4663 (RHC mainnet, locked decision 6). Modelled as a list anyway
 * because that is what the wire says, and the client picks the RHC entry.
 */
const deploymentWire = z.object({
  contractAddress: addressString,
  chainId: z.number().int(),
  // Populated on /assets ("Robinhood Chain"), empty on /prices and
  // /corporate-actions. Never load-bearing.
  networkName: optionalString,
});

export type RhjDeployment = z.infer<typeof deploymentWire>;

// --- /assets ----------------------------------------------------------------

const tradingStatusWire = z.object({
  whole: z.string(),
  fractional: z.string(),
});

const tradingCapabilitiesWire = z.object({
  market: tradingStatusWire,
  extended: tradingStatusWire,
  overnight: tradingStatusWire,
});

export const assetWire = z.object({
  /** 32-byte asset UID. The same value `StockFactory.tokenAddress(uid)` takes. */
  id: z.string(),
  tokenSymbol: z.string().min(1),
  tokenName: z.string(),
  deployments: z.array(deploymentWire).min(1),
  currentMultiplier: decimalString,
  /** `""` unless a corporate action has a multiplier change queued. */
  pendingMultiplier: optionalDecimalString,
  /** `ASSET_STATUS_*`. Only `ASSET_STATUS_ACTIVE` is served today, but the
   *  string is passed through: BE-5 owns the eligibility decision, not this. */
  status: z.string().min(1),
  logoUrl: optionalString,
  tradingCapabilities: tradingCapabilitiesWire,
  tokenDecimals: z.number().int(),
  isin: optionalString,
});

export const assetsResponseWire = z.object({
  assets: z.array(assetWire),
});

export interface RhjTradingCapabilities {
  market: { whole: string; fractional: string };
  extended: { whole: string; fractional: string };
  overnight: { whole: string; fractional: string };
}

export interface RhjAsset {
  /** Robinhood asset UID (`id` on the wire). Matched against the factory. */
  uid: string;
  symbol: string;
  name: string;
  /** Canonical token address on RHC. Authenticity is an address match, never a
   *  symbol match (global do-not 3). */
  address: `0x${string}`;
  chainId: number;
  deployments: RhjDeployment[];
  /** 18-dp fixed point, kept as a string. */
  currentMultiplier: string;
  pendingMultiplier: string | null;
  status: string;
  logoUrl: string | null;
  tradingCapabilities: RhjTradingCapabilities;
  decimals: number;
  isin: string | null;
}

export function toRhjAsset(wire: z.infer<typeof assetWire>): RhjAsset {
  const deployment = wire.deployments[0]!;
  return {
    uid: wire.id,
    symbol: wire.tokenSymbol,
    name: wire.tokenName,
    address: deployment.contractAddress as `0x${string}`,
    chainId: deployment.chainId,
    deployments: wire.deployments,
    currentMultiplier: wire.currentMultiplier,
    pendingMultiplier: toNullable(wire.pendingMultiplier),
    status: wire.status,
    logoUrl: toNullable(wire.logoUrl),
    tradingCapabilities: wire.tradingCapabilities,
    decimals: wire.tokenDecimals,
    isin: toNullable(wire.isin),
  };
}

// --- /prices/{symbol} -------------------------------------------------------

export const quoteWire = z.object({
  tokenSymbol: z.string().min(1),
  deployments: z.array(deploymentWire).min(1),
  bid: optionalDecimalString,
  ask: optionalDecimalString,
  currency: z.string(),
  dailyTradingVolume: optionalDecimalString,
  /** Per-name halt of the underlying equity. Not a calendar event (PART 3). */
  isTradingHalt: z.boolean(),
  /** RFC 3339 with nanosecond precision, e.g. `2026-08-16T20:41:51.117836871Z`. */
  generatedAt: z.string().min(1),
  dailyHigh: optionalDecimalString,
  dailyLow: optionalDecimalString,
  /** Authorized-participant creation volume. The highest-signal FLOW input. */
  mintBurnTokenVolume: optionalDecimalString,
  mintBurnUsdVolume: optionalDecimalString,
});

export const pricesResponseWire = z.object({
  quotes: z.array(quoteWire),
});

export interface RhjQuote {
  symbol: string;
  address: `0x${string}`;
  chainId: number;
  /** `null` when upstream has no quote. Never 0 (global do-not 2). */
  bid: number | null;
  ask: number | null;
  /** Midpoint of bid and ask, `null` unless both sides are present. This is the
   *  independent counterparty for the agreement test (Design Law 3a). */
  mid: number | null;
  currency: string;
  dailyTradingVolume: number | null;
  isTradingHalt: boolean;
  generatedAt: Date;
  dailyHigh: number | null;
  dailyLow: number | null;
  mintBurnTokenVolume: number | null;
  mintBurnUsdVolume: number | null;
}

export function toRhjQuote(wire: z.infer<typeof quoteWire>): RhjQuote {
  const deployment = wire.deployments[0]!;
  const bid = toNumber(wire.bid);
  const ask = toNumber(wire.ask);
  return {
    symbol: wire.tokenSymbol,
    address: deployment.contractAddress as `0x${string}`,
    chainId: deployment.chainId,
    bid,
    ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    currency: wire.currency,
    dailyTradingVolume: toNumber(wire.dailyTradingVolume),
    isTradingHalt: wire.isTradingHalt,
    generatedAt: new Date(wire.generatedAt),
    dailyHigh: toNumber(wire.dailyHigh),
    dailyLow: toNumber(wire.dailyLow),
    mintBurnTokenVolume: toNumber(wire.mintBurnTokenVolume),
    mintBurnUsdVolume: toNumber(wire.mintBurnUsdVolume),
  };
}

// --- /corporate-actions -----------------------------------------------------

const processDateWire = z.object({
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int(),
});

/**
 * Only `cashDividend` has been observed, but the field is a oneof upstream and
 * splits will arrive here too. Unknown variants are carried through rather than
 * rejected: a split we cannot type is still a corporate action BE-13 must see,
 * and the on-chain `newUIMultiplier()` pair is the authority on the number.
 */
const corporateActionDetailsWire = z.looseObject({
  cashDividend: z
    .object({
      underlyingSymbol: z.string(),
      rate: decimalString,
    })
    .optional(),
});

export const corporateActionWire = z.object({
  id: z.string(),
  /** `CORPORATE_ACTION_TYPE_*`. */
  type: z.string().min(1),
  /** `CORPORATE_ACTION_STATUS_*`, e.g. `..._IN_PROGRESS`, `..._COMPLETED`. */
  status: z.string().min(1),
  processDate: processDateWire,
  tokenSymbol: z.string().min(1),
  deployments: z.array(deploymentWire).min(1),
  details: corporateActionDetailsWire,
});

export const corporateActionsResponseWire = z.object({
  corpActions: z.array(corporateActionWire),
});

export interface RhjCorporateAction {
  id: string;
  type: string;
  status: string;
  /** Calendar date upstream processes the action on, as `YYYY-MM-DD`. Kept as a
   *  date string, not a `Date`: it has no time or zone and inventing one would
   *  shift it a day for anyone east of UTC. */
  processDate: string;
  symbol: string;
  address: `0x${string}`;
  chainId: number;
  cashDividendRate: number | null;
  /** The raw `details` object, including variants this client does not type. */
  details: Record<string, unknown>;
}

function toIsoDate(date: z.infer<typeof processDateWire>): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

export function toRhjCorporateAction(
  wire: z.infer<typeof corporateActionWire>,
): RhjCorporateAction {
  const deployment = wire.deployments[0]!;
  return {
    id: wire.id,
    type: wire.type,
    status: wire.status,
    processDate: toIsoDate(wire.processDate),
    symbol: wire.tokenSymbol,
    address: deployment.contractAddress as `0x${string}`,
    chainId: deployment.chainId,
    cashDividendRate: wire.details.cashDividend ? toNumber(wire.details.cashDividend.rate) : null,
    details: wire.details,
  };
}

// --- /price-deviations ------------------------------------------------------

/**
 * Robinhood's own published peg-deviation feed. It returns `{"rows":[]}` when
 * clean, which is the only state observed so far, so the row shape is asserted
 * loosely: every field is optional and unknown keys pass through in `raw`.
 *
 * This is the one place where strictness would be wrong. A schema guessed from
 * zero samples would reject the first real deviation row, and a deviation row
 * dropped at the boundary is exactly the event PEG_DRIFT (BE-12) exists to
 * catch. `rowCount` is trustworthy regardless of what the rows contain.
 */
export const priceDeviationRowWire = z.looseObject({
  tokenSymbol: z.string().optional(),
  deployments: z.array(deploymentWire).optional(),
});

export const priceDeviationsResponseWire = z.object({
  rows: z.array(priceDeviationRowWire),
});

export interface RhjPriceDeviationRow {
  symbol: string | null;
  address: `0x${string}` | null;
  /** The full upstream row, untouched. */
  raw: Record<string, unknown>;
}

export function toRhjPriceDeviationRow(
  wire: z.infer<typeof priceDeviationRowWire>,
): RhjPriceDeviationRow {
  const deployment = wire.deployments?.[0];
  return {
    symbol: wire.tokenSymbol ?? null,
    address: (deployment?.contractAddress as `0x${string}`) ?? null,
    raw: wire,
  };
}

// --- Upstream error body ----------------------------------------------------

/** 4xx bodies look like `{"code":5,"message":"no whitelisted asset ...","details":[]}`. */
export const upstreamErrorWire = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
});
