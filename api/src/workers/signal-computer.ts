/**
 * The signal computer (BE-10 scope section 3).
 *
 * `spec/CortexBackend.md` PART 3 is the root of truth. This worker owns none of
 * the signal logic: it loads the eligible universe, builds one time window,
 * hands both to every registered processor, normalises and validates what comes
 * back, and upserts the survivors. The six processors (BE-11 through BE-16)
 * register themselves in `signals/registry.ts`; until they do, this runs and
 * writes nothing, which is the correct behaviour for BE-10 on its own.
 *
 * ## The window
 *
 * One window per tick, shared by every processor. `end` is aligned to
 * `SIGNAL_WINDOW_ALIGN_SEC` and `start` is `SIGNAL_WINDOW_SEC` before it. Two
 * ticks that land in the same aligned slot produce the same `end`, so the
 * deterministic id is identical and the upsert overwrites rather than
 * duplicates (BE-10 scope section 2, acceptance criterion 2). A worker restart
 * that recomputes a slot is therefore a no-op on the row count.
 *
 * ## supersededBy
 *
 * After this tick's rows are written, every older non-superseded row of the
 * same kind and ticker has its `supersededBy` set to the new id. A recompute of
 * the same window does not trip this: the new `ts` equals the existing one, so
 * `ts < newTs` is false and nothing is touched.
 *
 * ## Eligibility
 *
 * The processor input is the `signalEligible` set, which is all 96 active names,
 * not the 35 vault-eligible ones (BE-10 scope section 6). A contract cannot read
 * a REST quote; a signal can.
 */

import { and, eq, isNull, lt, ne } from "drizzle-orm";

import { db } from "../db/client.ts";
import { conflictUpdateSet } from "../db/upsert.ts";
import { signals, universe, type NewSignalRecord } from "../db/schema.ts";
import { isAfterHours } from "../lib/session.ts";
import { logger } from "../lib/logger.ts";
import { computeRank } from "../signals/rank.ts";
import { allProcessors, signalId } from "../signals/registry.ts";
// Side-effect imports: each kind processor self-registers at load. BE-15 and
// BE-16 add a line here.
import "../signals/flow.ts";
import "../signals/peg-drift.ts";
import "../signals/corporate-action.ts";
import "../signals/after-hours.ts";
import "../signals/holder-concentration.ts";
import "../signals/liquidity-shift.ts";
import type {
  ProcessorContext,
  SignalAsset,
  SignalCandidate,
  TimeWindow,
} from "../signals/types.ts";
import { validateSignal } from "../signals/validate.ts";

const log = logger.child({ module: "signal-computer" });

/** BullMQ repeatable interval. Frequent enough to refresh the current window,
 *  cheap because a recompute of an unchanged window is an upsert no-op. */
export const SIGNAL_COMPUTE_INTERVAL_MS = 15 * 60_000;

/** The lookback every processor computes over. PART 3's example is "PT4H". */
export const SIGNAL_WINDOW_SEC = 4 * 60 * 60;
/** `window.end` is floored to this. Ticks inside one slot share an id. */
export const SIGNAL_WINDOW_ALIGN_SEC = 15 * 60;
/** ISO-8601 duration for `SIGNAL_WINDOW_SEC`, copied onto every `Signal.window`. */
export const SIGNAL_WINDOW_ISO = "PT4H";

export interface SignalComputeSummary {
  startedAt: string;
  durationMs: number;
  window: { start: string; end: string; iso: string };
  /** Registered processors this build knows about. */
  processors: number;
  /** `signalEligible` assets handed to each processor. */
  assets: number;
  /** Candidates returned across all processors. */
  emitted: number;
  /** Candidates dropped by the validator. A dropped signal is a bug in a
   *  processor, never something to persist anyway (Design Law 5). */
  rejected: number;
  /** Rows upserted. */
  persisted: number;
  /** Older rows marked superseded this tick. */
  superseded: number;
  /** Processors that threw. Isolated so one cannot stop the others. */
  failed: number;
}

/** The aligned window for an instant. Exported for the router and for reasoning
 *  about which slot a given time falls in. */
export function windowFor(now: Date): TimeWindow {
  const alignMs = SIGNAL_WINDOW_ALIGN_SEC * 1000;
  const end = new Date(Math.floor(now.getTime() / alignMs) * alignMs);
  const start = new Date(end.getTime() - SIGNAL_WINDOW_SEC * 1000);
  return { start, end, iso: SIGNAL_WINDOW_ISO };
}

const TOKEN_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

async function loadEligibleAssets(): Promise<SignalAsset[]> {
  const rows = await db
    .select({
      tokenAddress: universe.tokenAddress,
      symbol: universe.symbol,
      feedAgreesWithQuote: universe.feedAgreesWithQuote,
      chainlinkFeed: universe.chainlinkFeed,
    })
    .from(universe)
    .where(eq(universe.signalEligible, true));

  const assets: SignalAsset[] = [];
  for (const row of rows) {
    if (!TOKEN_ADDRESS.test(row.tokenAddress)) {
      log.warn("skipping eligible asset with malformed token address", { symbol: row.symbol });
      continue;
    }
    assets.push({
      tokenAddress: row.tokenAddress as `0x${string}`,
      symbol: row.symbol,
      feedAgreesWithQuote: row.feedAgreesWithQuote,
      chainlinkFeed:
        row.chainlinkFeed !== null && TOKEN_ADDRESS.test(row.chainlinkFeed)
          ? (row.chainlinkFeed as `0x${string}`)
          : null,
    });
  }
  return assets;
}

/**
 * Normalises one candidate into a full row, then validates it.
 *
 * Returns the row on success, or null after logging the reasons. The five
 * framework-owned fields (`id`, `ts`, `rank`, `afterHours`, `supersededBy`) are
 * filled here regardless of anything the processor set.
 */
function normalise(
  candidate: SignalCandidate,
  window: TimeWindow,
  now: Date,
): NewSignalRecord | null {
  const ts = window.end;
  const id = signalId(candidate.kind, candidate.ticker, window.end);
  const afterHours = isAfterHours(ts);
  const rank = computeRank({ zScore: candidate.zScore, confidence: candidate.confidence, ts, now });

  const full = {
    id,
    ts: ts.toISOString(),
    ticker: candidate.ticker,
    tokenAddress: candidate.tokenAddress,
    kind: candidate.kind,
    magnitude: candidate.magnitude,
    zScore: candidate.zScore,
    rank,
    confidence: candidate.confidence,
    explanation: candidate.explanation,
    evidence: candidate.evidence,
    sources: candidate.sources,
    window: candidate.window,
    afterHours,
    supersededBy: null,
  };

  const result = validateSignal(full);
  if (!result.ok) {
    log.warn("signal rejected by validator, not persisted", {
      kind: candidate.kind,
      ticker: candidate.ticker,
      errors: result.errors,
    });
    return null;
  }

  return {
    ...full,
    ts,
    tokenAddress: result.signal.tokenAddress,
  };
}

/** Columns the upsert refreshes on a recompute. Not `id` or `ts` (the key), and
 *  not `supersededBy`: a later window may already have set it and a recompute of
 *  the earlier window must not blank it. */
const RECOMPUTE_COLUMNS = [
  "tokenAddress",
  "magnitude",
  "zScore",
  "rank",
  "confidence",
  "explanation",
  "evidence",
  "sources",
  "window",
  "afterHours",
] as const;

/**
 * One compute cycle. Returns a summary; throws only on a genuine defect (the DB
 * write failing), never on a processor finding nothing or a candidate failing
 * validation.
 */
export async function computeSignals(now = new Date()): Promise<SignalComputeSummary> {
  const startedMs = Date.now();
  const window = windowFor(now);
  const processors = allProcessors();

  const summary: SignalComputeSummary = {
    startedAt: new Date(startedMs).toISOString(),
    durationMs: 0,
    window: { start: window.start.toISOString(), end: window.end.toISOString(), iso: window.iso },
    processors: processors.length,
    assets: 0,
    emitted: 0,
    rejected: 0,
    persisted: 0,
    superseded: 0,
    failed: 0,
  };

  if (processors.length === 0) {
    // BE-10 on its own: the framework runs, no kind processor is registered yet.
    log.info("no signal processors registered, nothing to compute");
    summary.durationMs = Date.now() - startedMs;
    return summary;
  }

  const assets = await loadEligibleAssets();
  summary.assets = assets.length;
  if (assets.length === 0) {
    log.warn("no signalEligible assets, nothing to compute");
    summary.durationMs = Date.now() - startedMs;
    return summary;
  }

  const ctx: ProcessorContext = { db, logger, assets };
  const rows: NewSignalRecord[] = [];

  for (const processor of processors) {
    let candidates: SignalCandidate[];
    try {
      candidates = await processor.compute(ctx, window);
    } catch (err) {
      summary.failed += 1;
      log.error("processor threw, skipping its output this tick", { kind: processor.kind, err });
      continue;
    }

    summary.emitted += candidates.length;
    for (const candidate of candidates) {
      // A processor must emit its own kind. A mismatch is a wiring bug, not data.
      if (candidate.kind !== processor.kind) {
        summary.rejected += 1;
        log.warn("processor emitted a foreign kind, dropped", {
          processor: processor.kind,
          emitted: candidate.kind,
        });
        continue;
      }
      const row = normalise(candidate, window, now);
      if (row === null) summary.rejected += 1;
      else rows.push(row);
    }
  }

  if (rows.length === 0) {
    summary.durationMs = Date.now() - startedMs;
    log.info("signals computed", { ...summary });
    return summary;
  }

  // Deterministic ids collapse two candidates for the same (kind, ticker,
  // window) to one row. Keep the last, matching the on-conflict behaviour.
  const deduped = new Map<string, NewSignalRecord>();
  for (const row of rows) deduped.set(row.id, row);
  const finalRows = [...deduped.values()];

  await db
    .insert(signals)
    .values(finalRows)
    .onConflictDoUpdate({
      target: [signals.id, signals.ts],
      set: conflictUpdateSet(signals, RECOMPUTE_COLUMNS),
    });
  summary.persisted = finalRows.length;

  // supersededBy: point every older live row of the same kind and ticker at the
  // row just written. `lt(ts)` makes a same-window recompute a no-op.
  for (const row of finalRows) {
    const updated = await db
      .update(signals)
      .set({ supersededBy: row.id })
      .where(
        and(
          eq(signals.kind, row.kind),
          eq(signals.ticker, row.ticker),
          lt(signals.ts, row.ts as Date),
          isNull(signals.supersededBy),
          ne(signals.id, row.id),
        ),
      )
      .returning({ id: signals.id });
    summary.superseded += updated.length;
  }

  summary.durationMs = Date.now() - startedMs;
  log.info("signals computed", { ...summary });
  return summary;
}
