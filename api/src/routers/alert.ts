import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { AlertFire, AlertRule, SignalKind } from "@shared/contracts.ts";

import { alertFires, alerts, signals, universe } from "../db/schema.ts";
import { protectedProcedure, router, type Context } from "../trpc.ts";

/**
 * Alert rules (BE-23). `spec/CortexBackend.md` PART 5 owns the table, PART 1
 * fixes the identity: a rule belongs to a proven wallet address.
 *
 * **Locked decision 2: alerts are in-app only.** No push, no email, no digest,
 * so there is no transport or delivery parameter anywhere in this file, the
 * schema or the `AlertRule` contract. `create` takes only kind, ticker and
 * threshold. Delivery is implicit: the evaluator (BE-24) writes an `alert_fires`
 * row and the terminal (W-8) reads it.
 *
 * Every route is a `protectedProcedure` scoped to `ctx.session.address`, the
 * lowercased `0x…` address BE-21 verified. No route accepts a `userId`: taking
 * one would let any caller read, toggle or delete another user's rules.
 * `toggle` and `delete` re-check ownership in the same statement, so a rule id
 * from another wallet is a 404, not an action.
 *
 * `AlertRule.fires` and `AlertRule.lastFiredAt` are derived on read from
 * `alert_fires` (a rolling 30-day count and the max `ts`). They are never
 * written back to `alerts`: a denormalised copy would drift from the fire log.
 */

/** One rule per line item in the UI. A wallet cannot hold more than this. */
const MAX_RULES_PER_USER = 50;

const SIGNAL_KINDS = [
  "FLOW",
  "LIQUIDITY_SHIFT",
  "HOLDER_CONCENTRATION",
  "PEG_DRIFT",
  "AFTER_HOURS_DISLOCATION",
  "CORPORATE_ACTION",
] as const satisfies readonly SignalKind[];

/** A `SignalKind`, or "ANY" to match every kind. */
const kindSchema = z.enum([...SIGNAL_KINDS, "ANY"]);

/** A ticker symbol or "ANY". Normalised to upper case to match `universe.symbol`. */
const tickerSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .transform((value) => value.toUpperCase());

/** z-score trigger. The contract fixes the band at 1.5 .. 5.0. */
const thresholdSchema = z.number().gte(1.5).lte(5.0);

const createInput = z
  .object({ kind: kindSchema, ticker: tickerSchema, threshold: thresholdSchema })
  .strict();

const toggleInput = z.object({ id: z.string().min(1), active: z.boolean() }).strict();

const deleteInput = z.object({ id: z.string().min(1) }).strict();

const markSeenInput = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).strict();

const firesInput = z
  .object({ limit: z.number().int().positive().max(100).optional() })
  .strict()
  .optional();

/** How many recent fires the delivery surface shows by default. */
const DEFAULT_FIRES_LIMIT = 30;

/**
 * Reject a ticker that is not a live `universe.symbol`. "ANY" is a wildcard, not
 * a symbol, so it is allowed through without a lookup. Cross-checked against the
 * table rather than a static list so the set tracks the refresher (BE-5).
 */
async function assertKnownTicker(ctx: Context, ticker: string): Promise<void> {
  if (ticker === "ANY") return;
  const [row] = await ctx.db
    .select({ symbol: universe.symbol })
    .from(universe)
    .where(eq(sql`upper(${universe.symbol})`, ticker))
    .limit(1);

  if (!row) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown ticker: ${ticker}` });
  }
}

/** The derived `fires` (rolling 30 days) and `lastFiredAt` (max `ts`) columns. */
const firesCount = sql<number>`count(${alertFires.ts}) filter (where ${alertFires.ts} >= now() - interval '30 days')`;
const lastFiredAt = sql<Date | null>`max(${alertFires.ts})`.mapWith(alertFires.ts);

function toAlertRule(row: {
  id: string;
  kind: SignalKind | "ANY";
  ticker: string;
  threshold: number;
  active: boolean;
  createdAt: Date;
  fires: number;
  lastFiredAt: Date | null;
}): AlertRule {
  return {
    id: row.id,
    kind: row.kind,
    ticker: row.ticker,
    threshold: row.threshold,
    active: row.active,
    fires: Number(row.fires),
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One rule with its derived counts, or null when the id is not the caller's. */
async function loadRule(ctx: Context, address: string, id: string): Promise<AlertRule | null> {
  const [row] = await ctx.db
    .select({
      id: alerts.id,
      kind: alerts.kind,
      ticker: alerts.ticker,
      threshold: alerts.threshold,
      active: alerts.active,
      createdAt: alerts.createdAt,
      fires: firesCount,
      lastFiredAt,
    })
    .from(alerts)
    .leftJoin(alertFires, eq(alertFires.alertId, alerts.id))
    .where(and(eq(alerts.id, id), eq(alerts.userId, address)))
    .groupBy(alerts.id)
    .limit(1);

  return row ? toAlertRule(row) : null;
}

export const alertRouter = router({
  /** The caller's rules, newest first, each with derived `fires` and `lastFiredAt`. */
  list: protectedProcedure.query(async ({ ctx }): Promise<AlertRule[]> => {
    const rows = await ctx.db
      .select({
        id: alerts.id,
        kind: alerts.kind,
        ticker: alerts.ticker,
        threshold: alerts.threshold,
        active: alerts.active,
        createdAt: alerts.createdAt,
        fires: firesCount,
        lastFiredAt,
      })
      .from(alerts)
      .leftJoin(alertFires, eq(alertFires.alertId, alerts.id))
      .where(eq(alerts.userId, ctx.session.address))
      .groupBy(alerts.id)
      .orderBy(desc(alerts.createdAt));

    return rows.map(toAlertRule);
  }),

  /** Create a rule for the caller. Validates the kind, ticker and threshold. */
  create: protectedProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }): Promise<AlertRule> => {
      await assertKnownTicker(ctx, input.ticker);

      const [{ total } = { total: 0 }] = await ctx.db
        .select({ total: sql<number>`count(*)` })
        .from(alerts)
        .where(eq(alerts.userId, ctx.session.address));

      if (Number(total) >= MAX_RULES_PER_USER) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `An address can hold at most ${MAX_RULES_PER_USER} alert rules`,
        });
      }

      const [created] = await ctx.db
        .insert(alerts)
        .values({
          userId: ctx.session.address,
          kind: input.kind,
          ticker: input.ticker,
          threshold: input.threshold,
        })
        .returning({
          id: alerts.id,
          kind: alerts.kind,
          ticker: alerts.ticker,
          threshold: alerts.threshold,
          active: alerts.active,
          createdAt: alerts.createdAt,
        });

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not create the rule",
        });
      }

      return toAlertRule({ ...created, fires: 0, lastFiredAt: null });
    }),

  /** Pause or resume a rule. A rule id that is not the caller's is a 404. */
  toggle: protectedProcedure
    .input(toggleInput)
    .mutation(async ({ ctx, input }): Promise<AlertRule> => {
      const [updated] = await ctx.db
        .update(alerts)
        .set({ active: input.active, updatedAt: new Date() })
        .where(and(eq(alerts.id, input.id), eq(alerts.userId, ctx.session.address)))
        .returning({ id: alerts.id });

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Alert rule not found" });
      }

      const rule = await loadRule(ctx, ctx.session.address, input.id);
      if (!rule) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Alert rule not found" });
      }
      return rule;
    }),

  /** Delete a rule. A rule id that is not the caller's is a 404. */
  delete: protectedProcedure
    .input(deleteInput)
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      const [deleted] = await ctx.db
        .delete(alerts)
        .where(and(eq(alerts.id, input.id), eq(alerts.userId, ctx.session.address)))
        .returning({ id: alerts.id });

      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Alert rule not found" });
      }
      return { ok: true };
    }),

  /**
   * Mark fires seen, clearing the unread badge (W-8). `ids` are `alert_fires`
   * ids; only fires whose rule belongs to the caller are touched, so an id from
   * another wallet is silently ignored rather than acted on.
   */
  markSeen: protectedProcedure
    .input(markSeenInput)
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      const ownRules = ctx.db
        .select({ id: alerts.id })
        .from(alerts)
        .where(eq(alerts.userId, ctx.session.address));

      await ctx.db
        .update(alertFires)
        .set({ seenAt: new Date() })
        .where(
          and(
            inArray(alertFires.id, input.ids),
            isNull(alertFires.seenAt),
            inArray(alertFires.alertId, ownRules),
          ),
        );

      return { ok: true };
    }),

  /**
   * The count of the caller's unseen fires. Backs the sidebar unread badge
   * (W-8), which polls it on the live interval. Kept deliberately narrow: a
   * `count(*)` over `alert_fires` joined to the caller's rules, no signal join.
   */
  unreadCount: protectedProcedure.query(async ({ ctx }): Promise<number> => {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(alertFires)
      .innerJoin(alerts, eq(alerts.id, alertFires.alertId))
      .where(and(eq(alerts.userId, ctx.session.address), isNull(alertFires.seenAt)));

    return Number(row?.n ?? 0);
  }),

  /**
   * The delivery surface (W-8): recent fires for the caller, newest first, each
   * joined to the rule that matched and the signal that triggered it. The
   * signal join is a left join, so a fire whose signal has aged out still
   * appears with `signal: null` rather than vanishing.
   *
   * `activeRules` and `firesLast30d` ride along so the view's header stats read
   * straight from the API rather than reducing the rule list client-side.
   */
  fires: protectedProcedure.input(firesInput).query(
    async ({
      ctx,
      input,
    }): Promise<{
      fires: AlertFire[];
      activeRules: number;
      firesLast30d: number;
      unseen: number;
    }> => {
      const address = ctx.session.address;
      const limit = input?.limit ?? DEFAULT_FIRES_LIMIT;

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
        .where(eq(alerts.userId, address))
        .orderBy(desc(alertFires.ts))
        .limit(limit);

      const [ruleTally] = await ctx.db
        .select({ activeRules: sql<number>`count(*) filter (where ${alerts.active})` })
        .from(alerts)
        .where(eq(alerts.userId, address));

      const [fireTally] = await ctx.db
        .select({
          firesLast30d: sql<number>`count(*) filter (where ${alertFires.ts} >= now() - interval '30 days')`,
          unseen: sql<number>`count(*) filter (where ${alertFires.seenAt} is null)`,
        })
        .from(alertFires)
        .innerJoin(alerts, eq(alerts.id, alertFires.alertId))
        .where(eq(alerts.userId, address));

      const fires: AlertFire[] = rows.map((row) => ({
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

      return {
        fires,
        activeRules: Number(ruleTally?.activeRules ?? 0),
        firesLast30d: Number(fireTally?.firesLast30d ?? 0),
        unseen: Number(fireTally?.unseen ?? 0),
      };
    },
  ),
});
