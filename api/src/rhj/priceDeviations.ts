import { fetchJson } from "./client.ts";
import {
  priceDeviationsResponseWire,
  toRhjPriceDeviationRow,
  type RhjPriceDeviationRow,
} from "./types.ts";

/**
 * `GET /price-deviations` — Robinhood's own published peg-deviation feed.
 *
 * BE-12 cross-checks our PEG_DRIFT detector against it: our signal firing while
 * their rows are empty is itself worth surfacing, and the reverse is a bug in
 * our detector. Both readings depend on knowing the feed was actually read, so a
 * failed fetch must raise rather than look clean.
 */

export interface PriceDeviationsResult {
  rows: RhjPriceDeviationRow[];
  /** True when upstream reports no deviations. Only meaningful after a
   *  successful fetch, which is why failure throws instead of returning this. */
  isClean: boolean;
}

export async function fetchPriceDeviations(): Promise<PriceDeviationsResult> {
  const response = await fetchJson({
    path: "/price-deviations",
    endpoint: "price-deviations",
    schema: priceDeviationsResponseWire,
  });

  const rows = response.rows.map(toRhjPriceDeviationRow);
  return { rows, isClean: rows.length === 0 };
}
