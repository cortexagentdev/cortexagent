/**
 * The signal framework types (BE-10).
 *
 * `spec/CortexBackend.md` PART 3 is the root of truth. This file has **no**
 * kind-specific logic: the six processors (BE-11 through BE-16) each implement
 * `SignalProcessor`, register themselves in `registry.ts`, and the signal
 * computer in `api/src/workers/signal-computer.ts` drives all of them on a
 * schedule.
 *
 * Design Law 1: intelligence is the product, and a signal must be explainable,
 * sourced and timestamped, never a black box. The framework enforces that in
 * `validate.ts`: a processor that cannot populate every mandatory field must
 * drop the signal rather than emit a hollow one.
 */

import type { Confidence, Signal, SignalEvidence, SignalKind } from "@shared/contracts.ts";

import type { Db } from "../db/client.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * The window a processor computes over.
 *
 * `end` is the window end and the instant the signal is stamped with. It is
 * also what the deterministic id hashes, so two ticks that land in the same
 * window produce the same id and upsert over each other. The computer aligns
 * `end` to a fixed boundary for exactly this reason (see `SIGNAL_WINDOW_SEC`).
 */
export interface TimeWindow {
  start: Date;
  end: Date;
  /** ISO-8601 duration, e.g. "PT4H". Copied onto `Signal.window`. */
  iso: string;
}

/**
 * One `signalEligible` asset, as the computer hands it to a processor.
 *
 * Signals run over the whole active universe (all 96 names), not just the 35
 * vault-eligible ones: a contract cannot read a REST quote, but a signal can.
 * See BE-10 scope section 6.
 */
export interface SignalAsset {
  tokenAddress: `0x${string}`;
  symbol: string;
  /** The freshness test (Design Law 3a). When false, `deriveConfidence`
   *  degrades every signal on this asset by one notch. */
  feedAgreesWithQuote: boolean;
  /** AggregatorV3 proxy, or null for the feedless names. Processors that need a
   *  reference price (PEG_DRIFT) key off this. */
  chainlinkFeed: `0x${string}` | null;
}

/**
 * What a processor is given for one run.
 */
export interface ProcessorContext {
  db: Db;
  logger: Logger;
  /** The `signalEligible` set, loaded once per computer tick. */
  assets: readonly SignalAsset[];
}

/**
 * The interface every kind processor implements.
 *
 * `compute` returns candidate signals. The computer normalizes each one (fills
 * the deterministic id, `rank`, `afterHours`), validates it against the zod
 * schema in `validate.ts`, and upserts the survivors. A processor may return
 * fewer signals than it has assets, or none. It must not throw for an ordinary
 * "nothing fired this window": throwing is reserved for a genuine defect and
 * the computer isolates it so one bad processor cannot stop the others.
 */
export interface SignalProcessor {
  kind: SignalKind;
  compute(ctx: ProcessorContext, window: TimeWindow): Promise<SignalCandidate[]>;
}

/**
 * What a processor returns, before the framework fills the derived fields.
 *
 * The framework owns five fields and ignores anything a processor puts there:
 * - `id` is the deterministic hash of `kind | ticker | window.end`.
 * - `ts` is set to `window.end`. Pinning it to the window end is what keeps the
 *   `(id, ts)` primary key stable across a recompute, so the upsert is truly
 *   idempotent (BE-10 scope section 2).
 * - `rank` comes from the shared `computeRank`.
 * - `afterHours` comes from BE-7's `isAfterHours(window.end)`.
 * - `supersededBy` is null on a fresh row; the computer sets it on the *older*
 *   row of the same kind and ticker when a newer window lands.
 *
 * A processor fills the rest: `ticker`, `tokenAddress`, `kind`, `magnitude`,
 * `zScore`, `confidence`, `explanation`, `evidence`, `sources`, `window`.
 */
export type SignalCandidate = Omit<Signal, "id" | "ts" | "rank" | "afterHours" | "supersededBy">;

/** Re-exported so processors import their types from one place. */
export type { Confidence, Signal, SignalEvidence, SignalKind };
