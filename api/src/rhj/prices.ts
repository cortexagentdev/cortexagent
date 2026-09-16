import {
  fetchJson,
  isRhjError,
  mapWithConcurrency,
  RhjError,
  RHJ_PRICE_CACHE_TTL_SEC,
} from "./client.ts";
import { pricesResponseWire, toRhjQuote, type RhjQuote } from "./types.ts";

/**
 * `GET /prices/{symbol}` — the only price source that covers every active Stock
 * Token, including the ones with no Chainlink feed, and the independent
 * counterparty for the agreement test that replaces staleness checking
 * (Design Law 3a).
 *
 * Upstream serves one symbol per request. There is no batch form: a comma list
 * comes back as `no whitelisted asset with symbol "CRM,AAPL"`. A sweep is
 * therefore N requests, which is what the rate limiter is sized for.
 */

// v2 stores a provenance envelope rather than the old raw wire body. Keeping
// a new namespace makes a rolling restart safe for old clients.
const CACHE_PREFIX = "rhj:prices:v2:";

/** Concurrency for a sweep. The limiter sets the pace; this sets the pipelining. */
const SWEEP_CONCURRENCY = 8;

const nonEmptyPricesResponseWire = pricesResponseWire.refine(
  (response) => response.quotes.length > 0,
  "prices response contained no quote",
);

function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "") {
    throw new RhjError("validation", "prices", "fetchQuote requires a symbol");
  }
  return normalized;
}

function cacheKey(symbol: string): string {
  return `${CACHE_PREFIX}${symbol}`;
}

/**
 * One quote, served from Redis when it was fetched less than 15s ago.
 *
 * Throws `RhjError` on failure, including `kind: "not_found"` for a symbol
 * upstream does not list. A missing quote is never a zero price (global
 * do-not 2) and never an empty result.
 */
export async function fetchQuote(symbol: string): Promise<RhjQuote> {
  const normalized = normalizeSymbol(symbol);

  const response = await fetchJson({
    path: `/prices/${encodeURIComponent(normalized)}`,
    endpoint: "prices",
    schema: nonEmptyPricesResponseWire,
    cache: { key: cacheKey(normalized), ttlSec: RHJ_PRICE_CACHE_TTL_SEC },
  });

  const quote = response.quotes[0];
  // The refined wire schema already rejects an empty response before it can
  // reach Redis; keep this guard for type-level and future-schema changes.
  if (!quote)
    throw new RhjError("validation", "prices", `prices returned no quote for ${normalized}`);

  return toRhjQuote(quote);
}

export interface QuoteSweepFailure {
  symbol: string;
  error: RhjError;
}

export interface QuoteSweep {
  /** Keyed by the requested symbol, uppercased. */
  quotes: Map<string, RhjQuote>;
  /** Symbols that failed, with the typed reason. Never silently dropped. */
  failures: QuoteSweepFailure[];
}

/**
 * Sweeps many symbols and reports per-symbol outcomes.
 *
 * A sweep does not throw on a partial failure, because one delisted ticker must
 * not blank the other 95 names. It does not hide the failure either: every
 * failed symbol comes back in `failures` with its `RhjError`, so a caller that
 * gets fewer quotes than it asked for can always say why. A caller that needs
 * all-or-nothing checks `failures.length`.
 */
export async function fetchQuotes(symbols: readonly string[]): Promise<QuoteSweep> {
  const quotes = new Map<string, RhjQuote>();
  const failures: QuoteSweepFailure[] = [];

  await mapWithConcurrency(symbols, SWEEP_CONCURRENCY, async (symbol) => {
    const normalized = symbol.trim().toUpperCase();
    try {
      const quote = await fetchQuote(symbol);
      quotes.set(normalized, quote);
    } catch (err) {
      const error = isRhjError(err)
        ? err
        : new RhjError("network", "prices", `prices request failed for ${symbol}`, { cause: err });
      failures.push({ symbol: normalized, error });
    }
  });

  return { quotes, failures };
}
