/**
 * Shared decoding for the testnet vault reads (BE-26).
 *
 * The NAV poller and the vault indexer both batch `navPerShare()` /
 * `navIndicative()` through `Multicall3` across a heterogeneous set of ABIs, so
 * viem cannot infer one result tuple for the batch. Both decode each entry the
 * same defensive way the price poller decodes its feed batch, so the logic lives
 * here once.
 */

import type { MulticallItem } from "./multicall.ts";

/** 1e18 fixed point, the scale every USD figure the vault returns uses. */
export const WAD = 10 ** 18;

/** A WAD-scaled on-chain integer to a display number, matching how the schema's
 *  `numeric` money columns (`mode: "number"`) are used. */
export function fromWad(value: bigint): number {
  return Number(value) / WAD;
}

/** A successful `uint256` multicall entry, or null on revert / wrong shape. */
export function decodeUint(item: MulticallItem<unknown> | undefined): bigint | null {
  if (!item || item.status !== "success") return null;
  return typeof item.result === "bigint" ? item.result : null;
}

/**
 * A `uint8` / small-int multicall entry (`decimals()`), as a number.
 *
 * viem decodes integers up to `uint48` as a JS `number`, not a `bigint`, so
 * `decodeUint` reads `null` for every `decimals()` call. Routing a feed's
 * `decimals()` through `decodeUint` therefore falls silently back to a default
 * and can ship a price scaled by the wrong power of ten. Use this instead.
 */
export function decodeSmallUint(item: MulticallItem<unknown> | undefined): number | null {
  if (!item || item.status !== "success") return null;
  const result = item.result;
  if (typeof result === "number") return result;
  return typeof result === "bigint" ? Number(result) : null;
}

/** A successful `uint256[]` multicall entry, or null on revert / wrong shape.
 *  `vaultRouter` (BE-27) reads `currentWeightsBps()` / `targetWeightsBps()`. */
export function decodeUintArray(item: MulticallItem<unknown> | undefined): bigint[] | null {
  if (!item || item.status !== "success") return null;
  if (!Array.isArray(item.result)) return null;
  return item.result.every((entry) => typeof entry === "bigint") ? (item.result as bigint[]) : null;
}

/** `answer` and `updatedAt` from a Chainlink `latestRoundData()` multicall entry,
 *  or null on revert / wrong shape. viem hands a multi-output view back as a
 *  positional tuple or as an object keyed by output name. */
export function decodeLatestRoundData(
  item: MulticallItem<unknown> | undefined,
): { answer: bigint; updatedAt: bigint } | null {
  if (!item || item.status !== "success") return null;
  const result = item.result;
  if (Array.isArray(result) && typeof result[1] === "bigint" && typeof result[3] === "bigint") {
    return { answer: result[1], updatedAt: result[3] };
  }
  if (
    result !== null &&
    typeof result === "object" &&
    "answer" in result &&
    "updatedAt" in result &&
    typeof (result as { answer: unknown }).answer === "bigint" &&
    typeof (result as { updatedAt: unknown }).updatedAt === "bigint"
  ) {
    const shaped = result as { answer: bigint; updatedAt: bigint };
    return { answer: shaped.answer, updatedAt: shaped.updatedAt };
  }
  return null;
}

/** A successful `FeeController.accrual()` entry, or null on failure. */
export function decodeAccrual(
  item: MulticallItem<unknown> | undefined,
): { accrued: bigint; unclaimed: bigint; creatorClaimed: bigint; protocolClaimed: bigint } | null {
  if (!item || item.status !== "success") return null;
  const r = item.result;
  if (
    Array.isArray(r) &&
    typeof r[0] === "bigint" &&
    typeof r[1] === "bigint" &&
    typeof r[2] === "bigint" &&
    typeof r[3] === "bigint"
  ) {
    return { accrued: r[0], unclaimed: r[1], creatorClaimed: r[2], protocolClaimed: r[3] };
  }
  if (
    r !== null &&
    typeof r === "object" &&
    "accrued" in r &&
    "unclaimed" in r &&
    "creatorClaimed" in r &&
    "protocolClaimed" in r
  ) {
    const s = r as Record<string, unknown>;
    if (
      typeof s.accrued === "bigint" &&
      typeof s.unclaimed === "bigint" &&
      typeof s.creatorClaimed === "bigint" &&
      typeof s.protocolClaimed === "bigint"
    ) {
      return {
        accrued: s.accrued,
        unclaimed: s.unclaimed,
        creatorClaimed: s.creatorClaimed,
        protocolClaimed: s.protocolClaimed,
      };
    }
  }
  return null;
}

/** A successful `navIndicative()` entry `(value, stale)`, or null on failure.
 *  viem may hand a two-output function back as a tuple or as an object. */
export function decodeNavIndicative(
  item: MulticallItem<unknown> | undefined,
): { value: bigint; stale: boolean } | null {
  if (!item || item.status !== "success") return null;
  const result = item.result;
  if (Array.isArray(result) && typeof result[0] === "bigint" && typeof result[1] === "boolean") {
    return { value: result[0], stale: result[1] };
  }
  if (
    result !== null &&
    typeof result === "object" &&
    "value" in result &&
    "stale" in result &&
    typeof (result as { value: unknown }).value === "bigint" &&
    typeof (result as { stale: unknown }).stale === "boolean"
  ) {
    const shaped = result as { value: bigint; stale: boolean };
    return { value: shaped.value, stale: shaped.stale };
  }
  return null;
}
