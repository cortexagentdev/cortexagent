/** Execution-only constituent checks used when constructing an immutable theme.
 *
 * Research universe rows remain useful for lens membership and classification,
 * but are deliberately not evidence that a token can settle on the configured
 * execution chain.  This module turns the stage-05 pinned quote primitive into
 * that separate evidence.  It never falls back to research RPC or TVL.
 */
import { getAddress, type Address, type Hex } from "viem";

import { adapterConfiguration } from "./adapter-routes.ts";
import { prepareCandidate, type RouteQuote } from "./quotes.ts";
import { ensureExecutionBinding } from "./registry.ts";

const WAD = 10n ** 18n;

export type ExecutionEligibility =
  | {
      eligible: true;
      tokenAddress: Address;
      feed: Address;
      /** A conservative, demonstrated exit amount, not a TVL estimate. */
      measuredExitCapacityUsdWad: string;
      checkedAt: string;
      blockNumber: string;
      blockHash: Hex;
      adapter: Address;
      adapterRuntimeHash: Hex;
      routeHash: Hex;
      buy: RouteQuote;
      sell: RouteQuote;
    }
  | { eligible: false; code: string; reason: string };

function failure(error: unknown): ExecutionEligibility {
  const value = error as { code?: unknown; message?: unknown };
  return {
    eligible: false,
    code: typeof value.code === "string" ? value.code : "EXECUTION_UNAVAILABLE",
    reason:
      typeof value.message === "string"
        ? value.message
        : "Execution eligibility could not be verified from the configured fork.",
  };
}

/**
 * Verify both immutable directions at one canonical execution block.  The
 * amount is deliberately modest ($100): it establishes a real executable
 * route and gives a conservative measured exit floor.  Larger capacity is
 * separately rechecked before a deployment; we never turn missing TVL into 0.
 */
export async function executionEligibility(symbol: string): Promise<ExecutionEligibility> {
  try {
    const buySnapshot = await prepareCandidate(symbol, "buy");
    const sellSnapshot = await prepareCandidate(symbol, "sell", undefined, buySnapshot.blockHash);
    const usdgDecimals = buySnapshot.metadata[0]!.decimals;
    const stock = sellSnapshot.metadata[0]!;
    if (!stock.feed || stock.wholeValueWad === "0")
      return { eligible: false, code: "ORACLE_UNAVAILABLE", reason: "No usable execution feed." };

    const buy = await buySnapshot.quote((100n * 10n ** BigInt(usdgDecimals)).toString());
    const sellInput = (100n * WAD * 10n ** BigInt(stock.decimals)) / BigInt(stock.wholeValueWad);
    const sell = await sellSnapshot.quote(sellInput.toString());
    if (buy.status !== "quoted") return { eligible: false, code: buy.code, reason: buy.message };
    if (sell.status !== "quoted") return { eligible: false, code: sell.code, reason: sell.message };

    const adapterRoute = adapterConfiguration();
    const binding = await ensureExecutionBinding();
    const adapter = binding.manifest.adapters.find(
      (entry) => entry.routeHash?.toLowerCase() === adapterRoute.routeHash.toLowerCase(),
    );
    if (!adapter)
      return {
        eligible: false,
        code: "NO_SUPPORTED_ROUTE",
        reason: "The verified candidate route is not installed in an immutable execution adapter.",
      };
    await sellSnapshot.validateSnapshot();
    return {
      eligible: true,
      tokenAddress: stock.address,
      feed: stock.feed,
      measuredExitCapacityUsdWad: (
        (BigInt(sell.quote.expectedOutRaw) * WAD) /
        10n ** BigInt(usdgDecimals)
      ).toString(),
      checkedAt: new Date().toISOString(),
      blockNumber: sell.quote.blockNumber,
      blockHash: sell.quote.blockHash,
      adapter: getAddress(adapter.address),
      adapterRuntimeHash: adapter.runtimeHash,
      routeHash: adapterRoute.routeHash,
      buy: buy.quote,
      sell: sell.quote,
    };
  } catch (error) {
    return failure(error);
  }
}
