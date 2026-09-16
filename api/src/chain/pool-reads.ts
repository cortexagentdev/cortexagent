/**
 * Block-pinned pool authentication reads shared by research and execution.
 *
 * The callers deliberately choose the client: this module has no knowledge of
 * research fallbacks or executable provider configuration. A failed outer
 * Multicall request is represented as a failure for every associated item, so
 * callers can retain partial coverage without ever treating a seeded address
 * as authenticated.
 */

import { getAddress, isAddress, zeroAddress, type Address, type PublicClient } from "viem";

import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from "./abis/index.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "./multicall.ts";

export interface FactoryPoolCandidate {
  factory: Address;
  token0: Address;
  token1: Address;
  feePips: number;
}

export type FactoryPoolResult =
  { status: "success"; pool: Address } | { status: "empty" } | { status: "failure" };

export interface PoolReadOptions {
  /** Explicitly selected research or independently verified execution client. */
  client: PublicClient;
  /** Every inner read in this operation is pinned to this block. */
  blockNumber: bigint;
  /** Passed through to Multicall3; the helper defaults to bounded chunking. */
  batchSize?: number;
}

/**
 * Resolves factory `getPool` calls in input order through bounded Multicall3.
 * A zero address is an authenticated negative result (`empty`); a reverted,
 * malformed, or unavailable result is `failure` and remains retryable to the
 * caller. Whole-request transport failure never falls back to seed addresses.
 */
export async function readFactoryPools(
  candidates: readonly FactoryPoolCandidate[],
  options: PoolReadOptions,
): Promise<FactoryPoolResult[]> {
  if (candidates.length === 0) return [];

  const calls = candidates.map(
    (candidate) =>
      ({
        address: candidate.factory,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [candidate.token0, candidate.token1, candidate.feePips],
      }) as const,
  );

  let results: MulticallItem<unknown>[];
  try {
    results = (await multicallRead(calls, options)) as unknown as MulticallItem<unknown>[];
  } catch {
    return candidates.map(() => ({ status: "failure" }));
  }

  return candidates.map((_, index) => {
    const item = results[index];
    if (!item || item.status !== "success") return { status: "failure" };
    const value = resultOrUndefined(item);
    if (typeof value !== "string" || !isAddress(value)) return { status: "failure" };
    if (value.toLowerCase() === zeroAddress) return { status: "empty" };
    try {
      return { status: "success", pool: getAddress(value) };
    } catch {
      return { status: "failure" };
    }
  });
}

export interface PoolMetadataCandidate {
  pool: Address;
}

export type PoolMetadataResult =
  | {
      status: "success";
      factory: Address;
      token0: Address;
      token1: Address;
      feePips: number;
    }
  | { status: "failure" };

function addressResult(item: MulticallItem<unknown> | undefined): Address | undefined {
  if (!item || item.status !== "success") return undefined;
  const value = resultOrUndefined(item);
  if (typeof value !== "string" || !isAddress(value)) return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

function feeResult(item: MulticallItem<unknown> | undefined): number | undefined {
  if (!item || item.status !== "success") return undefined;
  const value = resultOrUndefined(item);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
    ? value
    : undefined;
}

/**
 * Reads the four immutable V3 pool identity getters in one bounded batch per
 * supplied client/block. Results remain associated with their input pool; one
 * failed getter marks only that pool's metadata as unavailable.
 */
export async function readPoolMetadata(
  candidates: readonly PoolMetadataCandidate[],
  options: PoolReadOptions,
): Promise<PoolMetadataResult[]> {
  if (candidates.length === 0) return [];

  const calls = candidates.flatMap((candidate) => [
    { address: candidate.pool, abi: uniswapV3PoolAbi, functionName: "factory" } as const,
    { address: candidate.pool, abi: uniswapV3PoolAbi, functionName: "token0" } as const,
    { address: candidate.pool, abi: uniswapV3PoolAbi, functionName: "token1" } as const,
    { address: candidate.pool, abi: uniswapV3PoolAbi, functionName: "fee" } as const,
  ]);

  let results: MulticallItem<unknown>[];
  try {
    results = (await multicallRead(calls, options)) as unknown as MulticallItem<unknown>[];
  } catch {
    return candidates.map(() => ({ status: "failure" }));
  }

  return candidates.map((_, index) => {
    const offset = index * 4;
    const factory = addressResult(results[offset]);
    const token0 = addressResult(results[offset + 1]);
    const token1 = addressResult(results[offset + 2]);
    const feePips = feeResult(results[offset + 3]);
    if (!factory || !token0 || !token1 || feePips === undefined) return { status: "failure" };
    return { status: "success", factory, token0, token1, feePips };
  });
}
