import type { ContractFunctionParameters, MulticallReturnType, PublicClient } from "viem";

import { MULTICALL3_ADDRESS } from "./addresses.ts";

/**
 * Multicall3 batching.
 *
 * EVERY POLLING PATH IN THIS CODEBASE MUST GO THROUGH THIS HELPER.
 *
 * A naive per-asset loop over ~500 reads is ~500 RPC requests per cycle, which
 * gets the service throttled off a public endpoint within minutes. The same
 * cycle batched through Multicall3 is ~4 requests. That difference is what
 * keeps Cortex inside locked decision 7, free-tier data only, so a direct
 * `readContract` inside a loop is a defect and not a style preference.
 *
 * Failures are per call, never per batch. `allowFailure` is fixed at true: one
 * reverting asset (a ghost token, a pool that answers `getReserves` but not
 * `slot0`) must not cost the other 499 results.
 */

/**
 * Max bytes of inner calldata per batch. viem sizes a chunk by the calls it
 * carries, not by the encoded `aggregate3` body, so a no-argument read counts
 * as 4 bytes and a one-address read as 36.
 *
 * Measured over a 500-asset cycle: at viem's own default of 1024 an
 * address-argument read chunks into 18 requests. At 8192 the same cycle is 3,
 * and a no-argument cycle is 1, with the largest request body around 96 KB.
 * That is the ~4-requests-per-cycle budget the free public RPC needs.
 */
export const DEFAULT_BATCH_SIZE = 8192;

export interface MulticallOptions {
  /** Required: callers must choose research or verified execution explicitly. */
  client: PublicClient;
  /** Pin every call in the batch to one block, so the results are consistent. */
  blockNumber?: bigint;
  /** Max calldata bytes per request. 0 disables chunking, forcing a single request. */
  batchSize?: number;
}

/**
 * Batch N contract reads into one Multicall3 request.
 *
 * Returns one entry per input call, in order, each either
 * `{ status: "success", result }` or `{ status: "failure", error }`.
 */
export async function multicallRead<const contracts extends readonly ContractFunctionParameters[]>(
  contracts: contracts,
  options: MulticallOptions,
): Promise<MulticallReturnType<contracts, true>> {
  const { client, blockNumber, batchSize = DEFAULT_BATCH_SIZE } = options;

  // viem's own generic wants a narrowed literal tuple, which a caller-supplied
  // generic cannot satisfy. The cast is confined to this one call; the return
  // type stays fully inferred for every caller.
  return client.multicall({
    contracts: contracts as unknown as ContractFunctionParameters[],
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS,
    batchSize,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  }) as Promise<MulticallReturnType<contracts, true>>;
}

/** One entry of a batch: the shape viem returns under `allowFailure: true`. */
export type MulticallItem<T> =
  | { status: "success"; result: T; error?: undefined }
  | { status: "failure"; result?: undefined; error: Error };

/** Narrows a batch entry to its successful form. */
export function isSuccess<T>(
  item: MulticallItem<T>,
): item is { status: "success"; result: T; error?: undefined } {
  return item.status === "success";
}

/**
 * The result, or `undefined` when the call reverted.
 *
 * `undefined` is the right shape for a missing read. Do not substitute a zero:
 * an unpriceable asset renders as `-`, never as a price of 0 (global do-not 2).
 */
export function resultOrUndefined<T>(item: MulticallItem<T>): T | undefined {
  return isSuccess(item) ? item.result : undefined;
}

/**
 * Zips a batch back onto the keys it was built from, dropping the failures.
 *
 * The caller keeps the dropped keys where they matter: an asset excluded by a
 * failed read still needs an entry in `ineligibleReasons`, because nothing is
 * excluded silently (global do-not 5).
 */
export function zipSuccesses<K, T>(
  keys: readonly K[],
  items: readonly MulticallItem<T>[],
): Map<K, T> {
  const out = new Map<K, T>();
  for (const [i, key] of keys.entries()) {
    const item = items[i];
    if (item && isSuccess(item)) out.set(key, item.result);
  }
  return out;
}

/** Failure count for a batch. Worth logging: a rising rate means a sick RPC. */
export function countFailures(items: readonly MulticallItem<unknown>[]): number {
  return items.reduce((n, item) => (item.status === "failure" ? n + 1 : n), 0);
}
