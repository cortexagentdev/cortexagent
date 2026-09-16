/**
 * The processor registry and the deterministic id (BE-10 scope sections 2, 3).
 *
 * The six kind processors (BE-11 through BE-16) call `registerProcessor` at
 * import time. The signal computer imports this module, reads `allProcessors()`
 * and runs each one. This file has no kind-specific knowledge; it only holds
 * the map and the id function.
 */

import { createHash } from "node:crypto";

import type { SignalKind } from "@shared/contracts.ts";

import { logger } from "../lib/logger.ts";
import type { SignalProcessor } from "./types.ts";

const log = logger.child({ module: "signals/registry" });

const processors = new Map<SignalKind, SignalProcessor>();

/**
 * Registers a processor for its kind.
 *
 * One processor per kind. A second registration for the same kind is a wiring
 * bug (two modules both claiming FLOW), so it throws rather than silently
 * winning.
 */
export function registerProcessor(processor: SignalProcessor): void {
  if (processors.has(processor.kind)) {
    throw new Error(`A processor is already registered for kind "${processor.kind}"`);
  }
  processors.set(processor.kind, processor);
  log.debug("processor registered", { kind: processor.kind });
}

export function allProcessors(): SignalProcessor[] {
  return [...processors.values()];
}

export function getProcessor(kind: SignalKind): SignalProcessor | undefined {
  return processors.get(kind);
}

/** Test and worker-restart aid: empties the registry. */
export function clearProcessors(): void {
  processors.clear();
}

/**
 * `id = sha256(kind | ticker | windowEnd)`, hex.
 *
 * Deterministic on purpose (BE-10 scope section 2): re-running a window
 * produces the same id, so the computer upserts instead of duplicating, and
 * BE-24's alert evaluator can dedupe fires on it. The window end is the
 * discriminator, so a signal that fires again in the *next* window gets a new
 * id and supersedes the old row.
 *
 * `windowEnd` is normalised to millisecond-free ISO (`...Z`, no fractional
 * seconds) so a Date carrying sub-second noise from `Date.now()` cannot split
 * one logical window into two ids.
 */
export function signalId(kind: SignalKind, ticker: string, windowEnd: Date): string {
  const stamp = new Date(Math.floor(windowEnd.getTime() / 1000) * 1000).toISOString();
  return createHash("sha256").update(`${kind}|${ticker.toUpperCase()}|${stamp}`).digest("hex");
}
