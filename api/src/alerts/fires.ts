import { and, desc, eq, isNull, type SQL } from "drizzle-orm";

import type { AlertFire } from "@shared/contracts.ts";

import { alertFires, alerts, signals } from "../db/schema.ts";
import type { Context } from "../trpc.ts";

/**
 * Recent fires for one wallet, newest first, each joined to the rule that
 * matched and the signal that triggered it. Shared by `alertRouter.fires` (the
 * delivery surface, W-8) and the Market Radar's unread strip.
 *
 * The signal join is a left join, so a fire whose signal has aged out still
 * appears with `signal: null` rather than vanishing. The address is always the
 * session's, never a client input.
 */
export async function loadFires(
  ctx: Pick<Context, "db">,
  address: string,
  opts: { limit: number; unseenOnly?: boolean },
): Promise<AlertFire[]> {
  const conditions: SQL[] = [eq(alerts.userId, address)];
  if (opts.unseenOnly) conditions.push(isNull(alertFires.seenAt));

  const rows = await ctx.db
    .select({
      id: alertFires.id,
      alertId: alertFires.alertId,
      signalId: alertFires.signalId,
      ts: alertFires.ts,
      seenAt: alertFires.seenAt,
      ruleKind: alerts.kind,
      ruleTicker: alerts.ticker,
      ruleThreshold: alerts.threshold,
      signalTicker: signals.ticker,
      signalKind: signals.kind,
      signalZScore: signals.zScore,
      signalExplanation: signals.explanation,
      signalConfidence: signals.confidence,
    })
    .from(alertFires)
    .innerJoin(alerts, eq(alerts.id, alertFires.alertId))
    .leftJoin(signals, eq(signals.id, alertFires.signalId))
    .where(and(...conditions))
    .orderBy(desc(alertFires.ts))
    .limit(opts.limit);

  return rows.map((row) => ({
    id: row.id,
    alertId: row.alertId,
    signalId: row.signalId,
    ts: row.ts.toISOString(),
    seenAt: row.seenAt ? row.seenAt.toISOString() : null,
    rule: {
      kind: row.ruleKind,
      ticker: row.ruleTicker,
      threshold: row.ruleThreshold,
    },
    signal:
      row.signalTicker !== null &&
      row.signalKind !== null &&
      row.signalZScore !== null &&
      row.signalExplanation !== null &&
      row.signalConfidence !== null
        ? {
            ticker: row.signalTicker,
            kind: row.signalKind,
            zScore: row.signalZScore,
            explanation: row.signalExplanation,
            confidence: row.signalConfidence,
          }
        : null,
  }));
}
