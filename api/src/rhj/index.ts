/** Typed client for the free Robinhood `/rhj` REST API (BE-4). */

export {
  getRhjMetrics,
  isRhjError,
  resetRhjMetrics,
  RhjError,
  RHJ_MAX_RPS,
  RHJ_PRICE_CACHE_TTL_SEC,
  type RhjErrorKind,
  type RhjMetrics,
} from "./client.ts";

export { ASSET_STATUS_ACTIVE, fetchAssets } from "./assets.ts";
export { fetchQuote, fetchQuotes, type QuoteSweep, type QuoteSweepFailure } from "./prices.ts";
export {
  CORPORATE_ACTION_STATUS_IN_PROGRESS,
  CORPORATE_ACTION_TYPE_CASH_DIVIDEND,
  fetchCorporateActions,
  fetchPendingCorporateActions,
} from "./corporateActions.ts";
export { fetchPriceDeviations, type PriceDeviationsResult } from "./priceDeviations.ts";

export type {
  RhjAsset,
  RhjCorporateAction,
  RhjDeployment,
  RhjPriceDeviationRow,
  RhjQuote,
  RhjTradingCapabilities,
} from "./types.ts";
