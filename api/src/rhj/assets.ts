import { fetchJson } from "./client.ts";
import { assetsResponseWire, toRhjAsset, type RhjAsset } from "./types.ts";

/**
 * `GET /assets` — the status and enrichment layer for the universe.
 *
 * This is not the root of trust. Authenticity is `StockFactory.tokenAddress(uid)`
 * matched on address (BE-3); this endpoint says which of those addresses are
 * live and what their registry multiplier is. BE-5 combines the two.
 */

/** The only status observed on this endpoint. BE-5 owns what to do about it. */
export const ASSET_STATUS_ACTIVE = "ASSET_STATUS_ACTIVE";

/**
 * Every asset upstream serves, in wire order.
 *
 * Throws `RhjError` if the registry is unreachable or malformed. It never
 * returns `[]` on failure: an empty universe and an unreachable registry lead to
 * opposite decisions in BE-5, and only an empty `{"assets":[]}` body means the
 * first one.
 */
export async function fetchAssets(): Promise<RhjAsset[]> {
  const response = await fetchJson({
    path: "/assets",
    endpoint: "assets",
    schema: assetsResponseWire,
  });

  return response.assets.map(toRhjAsset);
}
