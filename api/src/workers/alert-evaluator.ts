/**
 * The alert evaluator (BE-24).
 *
 * `alertRouter` (BE-23) lets a wallet declare rules; nothing acts on them until
 * this worker runs. Per newly persisted signal it finds the active rules that
 * match and writes one `alert_fires` row per match. Delivery is implicit: the
 * terminal (W-8) reads the fire log. There is no transport here (locked
 * decision 2).
 *
 * ## Matching (BE-24 scope)
 *
 * A rule matches a signal when all three hold:
 *
 *   (rule.kind === signal.kind    || rule.kind === "ANY")   &&
 *   (rule.ticker === signal.ticker || rule.ticker === "ANY") &&
 *    signal.zScore >= rule.threshold
 *
 * `rule.ticker` is stored upper-cased by the router; `signal.ticker` comes from
 * `universe.symbol`. Both are folded to upper case before the compare so a
 * casing drift between the two tables cannot silently stop a rule from firing.
 *
 * ## Trigger: a short schedule, not a call from the signal computer
 *
 * This runs as its own repeatable job (`alert-evaluate`, every
 * `ALERT_EVALUATE_INTERVAL_MS`), scanning `signals` for a trailing window of
 * recent rows, rather than being invoked by `signal-computer` after its upsert.
 * Reasons:
 *
 *   - Decoupling. A slow or failing evaluation never stalls a signal compute
 *     cycle, and the reverse. Each job has its own retry and its own Redis lock
 *     (see `queue/processors.ts`), matching every other worker in this repo.
 *   - It catches a signal persisted by *any* path, not only the live compute
 *     cycle: a future backfill or a manual replay is picked up the same way.
 *
 * ## The watermark is a fixed trailing lookback, deliberately
 *
 * Signal ids are deterministic (`hash(kind | ticker | windowEnd)`) and a window
 * is recomputed **in place** with the *same* `ts` on a worker restart or a
 * retry (BE-10). A persisted high-watermark on `signals.ts` would therefore
 * skip a recompute whose `zScore` moved across a rule threshold. Instead each
 * tick re-scans every signal with `ts >= now() - ALERT_RESCAN_SEC` and
 * re-evaluates it. The repeat is free: see idempotency below. The lookback
 * comfortably spans the 15-minute signal cadence plus restart and retry lag. A
 * window older than the lookback that is re-persisted late is not re-evaluated,
 * which is consistent with C1 being forward-only (locked decision 9).
 *
 * ## Idempotency (the sharp edge, BE-24)
 *
 * The same (rule, signal) match is presented on every tick and on every window
 * recompute. Protection is entirely in the database:
 *
 *   1. `alert_fires` has a unique key on `(alertId, signalId, ts)` (BE-23),
 *      effectively unique on `(alertId, signalId)` since `signalId` determines
 *      `ts`.
 *   2. The insert is `ON CONFLICT DO NOTHING` against that key, so a repeat is a
 *      silent no-op and never fails the batch.
 *
 * There is no "have I seen this?" read before the write. That would race a
 * concurrent worker; the constraint is what settles it.
 *
 * ## Paused rules
 *
 * Only rules with `active = true` at scan time are loaded. A paused rule never
 * fires, and because nothing is queued against it, re-enabling it delivers no
 * backlog: it simply starts matching signals whose `ts` is still inside the
 * trailing lookback from that point on.
 */

import { eq, gte } from "drizzle-orm";

import type { SignalKind } from "@shared/contracts.ts";

import { db } from "../db/client.ts";
import { alertFires, alerts, signals } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";

const log = logger.child({ module: "alert-evaluator" });

/** BullMQ repeatable interval. Well under the 15m signal cadence so a fired
 *  rule surfaces in the terminal within a couple of minutes. Cheap: a re-scan
 *  of an unchanged trailing window is a batch of `ON CONFLICT DO NOTHING`. */
export const ALERT_EVALUATE_INTERVAL_MS = 2 * 60_000;

/** How far back each tick re-scans `signals.ts`. Spans several signal windows
 *  plus restart and retry lag, so a recomputed window is always re-evaluated
 *  while the deterministic id keeps the re-evaluation a no-op. */
export const ALERT_RESCAN_SEC = 45 * 60;

/** Rows per insert statement. Keeps each write bounded; no transaction spans the
 *  whole scan (BE-24: "process in batches, no long transaction"). */
const INSERT_CHUNK = 500;

export interface AlertEvaluateSummary {
  startedAt: string;
  durationMs: number;
  /** Signals inside the trailing lookback. */
  signals: number;
  /** Active rules loaded. */
  rules: number;
  /** (rule, signal) matches found this tick. */
  matches: number;
  /** Rows the insert actually added. `matches - inserted` were already on file
   *  (a prior tick or a window recompute) and hit `ON CONFLICT DO NOTHING`. */
  inserted: number;
}

interface CandidateSignal {
  id: string;
  kind: SignalKind;
  ticker: string;
  zScore: number;
  ts: Date;
}

interface ActiveRule {
  id: string;
  kind: SignalKind | "ANY";
  ticker: string;
  threshold: number;
}

function matches(rule: ActiveRule, signal: CandidateSignal): boolean {
  if (rule.kind !== "ANY" && rule.kind !== signal.kind) return false;
  if (rule.ticker !== "ANY" && rule.ticker !== signal.ticker.toUpperCase()) return false;
  return signal.zScore >= rule.threshold;
}

/**
 * One evaluation cycle. Returns a summary; throws only on a genuine defect (the
 * DB read or write failing), never on there being nothing to do.
 */
export async function evaluateAlerts(now = new Date()): Promise<AlertEvaluateSummary> {
  const startedMs = Date.now();
  const cutoff = new Date(now.getTime() - ALERT_RESCAN_SEC * 1000);

  const summary: AlertEvaluateSummary = {
    startedAt: new Date(startedMs).toISOString(),
    durationMs: 0,
    signals: 0,
    rules: 0,
    matches: 0,
    inserted: 0,
  };

  const candidateSignals: CandidateSignal[] = await db
    .select({
      id: signals.id,
      kind: signals.kind,
      ticker: signals.ticker,
      zScore: signals.zScore,
      ts: signals.ts,
    })
    .from(signals)
    .where(gte(signals.ts, cutoff));

  summary.signals = candidateSignals.length;
  if (candidateSignals.length === 0) {
    summary.durationMs = Date.now() - startedMs;
    log.debug("no recent signals, nothing to evaluate", { ...summary });
    return summary;
  }

  // Only rules active right now. A paused rule is absent from this set, so it
  // cannot fire and cannot accumulate a backlog (BE-24).
  const activeRules: ActiveRule[] = await db
    .select({
      id: alerts.id,
      kind: alerts.kind,
      ticker: alerts.ticker,
      threshold: alerts.threshold,
    })
    .from(alerts)
    .where(eq(alerts.active, true));

  summary.rules = activeRules.length;
  if (activeRules.length === 0) {
    summary.durationMs = Date.now() - startedMs;
    log.debug("no active rules, nothing to evaluate", { ...summary });
    return summary;
  }

  const fires: { id: string; alertId: string; signalId: string; ts: Date }[] = [];
  for (const rule of activeRules) {
    for (const signal of candidateSignals) {
      if (!matches(rule, signal)) continue;
      fires.push({
        // Deterministic id, matching BE-23's `alert_fires.id` rule. Two ticks
        // that see the same match build the same id and collide on insert.
        id: `${rule.id}:${signal.id}`,
        alertId: rule.id,
        signalId: signal.id,
        // The matched signal's window end, not wall-clock time (BE-23): a
        // window recompute then yields a byte-identical row and a clean conflict.
        ts: signal.ts,
      });
    }
  }

  summary.matches = fires.length;
  if (fires.length === 0) {
    summary.durationMs = Date.now() - startedMs;
    log.debug("no rule matched a recent signal", { ...summary });
    return summary;
  }

  for (let i = 0; i < fires.length; i += INSERT_CHUNK) {
    const chunk = fires.slice(i, i + INSERT_CHUNK);
    const inserted = await db
      .insert(alertFires)
      .values(chunk)
      .onConflictDoNothing({
        // The idempotency key from BE-23. A repeat (next tick, or a recomputed
        // signal window) is a silent no-op, not an error that fails the chunk.
        target: [alertFires.alertId, alertFires.signalId, alertFires.ts],
      })
      .returning({ id: alertFires.id });
    summary.inserted += inserted.length;
  }

  summary.durationMs = Date.now() - startedMs;
  log.info("alerts evaluated", { ...summary });
  return summary;
}
