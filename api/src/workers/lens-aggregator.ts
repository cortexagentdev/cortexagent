/**
 * The lens aggregator (BE-19).
 *
 * `spec/CortexBackend.md` PART 3 defines lens *grouping* only: names are grouped
 * by `sector` / `factors` and the surface should "expose per-constituent signals
 * plus aggregate theme behavior". `spec/CortexFrontend.md` §5 says that aggregate
 * behaviour is a plain read that answers "is my thesis playing out on-chain right
 * now?". None of the maths behind that read is specified anywhere. This worker
 * defines and computes it, once every 5 minutes, one `lens_metrics` row per lens.
 *
 * Per lens it produces:
 *
 * - `indexValue` / `series` — a curated-weight basket index (see the rebase rule
 *   below), plus the 9 downsampled points the sparkline renders.
 * - `movePct` — the 7-day index change, i.e. `indexValue - 100`.
 * - `netFlowUsd` — the signed 7-day sum of member authorized-participant
 *   mint/burn USD, aggregated from the same FLOW input BE-11 records.
 * - `signalCount24h` — signals on member tickers in the last 24 hours.
 * - the W-5 components: `memberCount`, `greenMemberCount`, `pricedMemberCount`,
 *   `flowMemberCount`, and the signed `netFlowUsd`. The plain-language sentence
 *   ("AI infra names net-accumulating, 4 of 5 green, flow +$1.9M over 7d") is
 *   phrased by the UI, never composed here (BE-19 scope §4).
 *
 * ## The rebase rule
 *
 * The basket is **rebased to 100 at the start of the 7-day reporting window**.
 * Let `t0 = cycleTs - 7d` be the window start and `t8 = cycleTs` the window end.
 * The series is sampled at 9 evenly spaced instants `t0 = τ0 < τ1 < … < τ8 = t8`.
 * For member `i`, `p_i(τ)` is its newest `price_history` sample at or before `τ`
 * within one step's lookbehind, and `b_i = p_i(τ0)` is its base price.
 *
 *     indexValue(τ) = 100 · Σ_i ( w_i' · p_i(τ) / b_i )
 *
 * where `w_i` are the curated `lenses.json` weights and `w_i'` renormalises them
 * across only the members priceable at `τ`:
 *
 *     w_i' = w_i / Σ_{j ∈ priceable(τ)} w_j
 *
 * A member with no base price `b_i` is absent from the whole window's index. A
 * member individually unpriceable at some `τ` is dropped from that observation
 * only, and the weights renormalise across the remainder (BE-19 scope §3). By
 * construction `indexValue(τ0) = 100` whenever at least one member is priceable,
 * which is what "rebased to 100 at window start" means and what makes
 * `movePct = indexValue(τ8) - 100` a true 7-day percentage change.
 *
 * ## null is not zero
 *
 * `indexValue`, `movePct` and `netFlowUsd` are measurements. When no member is
 * priceable across the window, `indexValue` / `movePct` are `null`, never `0`: a
 * lens that is flat and a lens that cannot be read must stay distinguishable,
 * exactly as `universe.change24hPct` in BE-6 (global do-not 2). When FLOW has
 * recorded nothing for any member, `netFlowUsd` is `null` (not `0`, which would
 * read as "measured, no net flow"). `signalCount24h`, `memberCount` and
 * `greenMemberCount` are census figures: `0` is a true value and is stored.
 *
 * ## Determinism
 *
 * Every input is a stored series: `price_history`, `signals`, `universe`, and
 * BE-11's FLOW observation cache. Nothing is read from chain or REST here. The
 * cycle instant is floored to `LENS_AGGREGATE_INTERVAL_MS`, so a re-run of the
 * same cycle recomputes the same numbers and upserts the same `(theme, ts)` row
 * (BE-19 acceptance criterion 1).
 */

import { and, gte, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.ts";
import { conflictUpdateSet } from "../db/upsert.ts";
import { lensMetrics, signals, universe, type NewLensMetricRecord } from "../db/schema.ts";
import { loadLenses, type LensDefinition } from "../lenses/load.ts";
import { logger } from "../lib/logger.ts";
import { trailingNetFlowUsd } from "../signals/flow.ts";

const log = logger.child({ module: "lens-aggregator" });

/** BullMQ repeatable interval. The task says every 5 minutes is ample. */
export const LENS_AGGREGATE_INTERVAL_MS = 5 * 60_000;

/** The reporting window every lens metric describes. */
export const LENS_WINDOW_SEC = 7 * 24 * 60 * 60;
/** Points the UI sparkline renders, matching `sparkSeries` in BE-6. */
export const LENS_SERIES_POINTS = 9;
/** Spacing between the 9 sample instants: 21 hours across the 7-day window. */
export const LENS_STEP_SEC = LENS_WINDOW_SEC / (LENS_SERIES_POINTS - 1);
/**
 * How far behind a sample instant a `price_history` row may sit and still stand
 * in for it: one step. At a 60s poll interval a healthy series has ~1260
 * samples per step, so reaching back further means the poller was down for the
 * better part of a day, and a point carried across that gap would draw a line
 * through prices nobody observed.
 */
export const LENS_SAMPLE_LOOKBEHIND_SEC = LENS_STEP_SEC;

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface LensAggregateSummary {
  startedAt: string;
  durationMs: number;
  cycleTs: string;
  /** Lenses in `lenses.json`. */
  lenses: number;
  /** Rows upserted into `lens_metrics`. */
  persisted: number;
  /** Lenses whose `indexValue` came out null (no member priceable across 7d). */
  nullIndex: number;
  /** Lenses whose `netFlowUsd` came out null (no member has recorded flow). */
  nullFlow: number;
}

/** The 9 instants the index is sampled at, oldest first, ending at `cycleTs`. */
export function sampleInstants(cycleMs: number): Date[] {
  return Array.from(
    { length: LENS_SERIES_POINTS },
    (_, i) => new Date(cycleMs - (LENS_SERIES_POINTS - 1 - i) * LENS_STEP_SEC * 1000),
  );
}

interface UniverseMember {
  tokenAddress: string;
  symbol: string;
  change24hPct: number | null;
}

/**
 * Newest `price_history.price` at or before each of the 9 instants, per address,
 * `null` where no sample fell inside that instant's lookbehind window.
 *
 * One statement, not `addresses × 9`: the addresses are an array, the instants a
 * small VALUES list, and the lateral join takes the newest qualifying row from
 * the `(token_address, ts)` primary key as a backwards scan. Modelled on the
 * price poller's `loadSamplePoints`.
 */
async function loadIndexPoints(
  addresses: readonly string[],
  instants: readonly Date[],
): Promise<Map<string, (number | null)[]>> {
  const points = new Map<string, (number | null)[]>();
  for (const address of addresses) {
    points.set(address, new Array<number | null>(instants.length).fill(null));
  }
  if (addresses.length === 0) return points;

  const addressList = sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  );
  // ISO strings, not Date objects: a raw statement hands parameters straight to
  // postgres-js, which has no drizzle column type to infer a Date from.
  const instantList = sql.join(
    instants.map(
      (instant, index) => sql`(${sql.raw(String(index))}, ${instant.toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );
  // A constant, not input: a bound parameter inside make_interval() has no type
  // for Postgres to infer.
  const lookbehind = sql.raw(`make_interval(secs => ${LENS_SAMPLE_LOOKBEHIND_SEC})`);

  const rows = await db.execute<{ token_address: string; idx: number; price: string | null }>(sql`
    SELECT a.token_address, t.idx, s.price
    FROM unnest(ARRAY[${addressList}]::text[]) AS a(token_address)
    CROSS JOIN (VALUES ${instantList}) AS t(idx, target)
    LEFT JOIN LATERAL (
      SELECT h.price
      FROM price_history h
      WHERE h.token_address = a.token_address
        AND h.ts <= t.target
        AND h.ts > t.target - ${lookbehind}
      ORDER BY h.ts DESC
      LIMIT 1
    ) s ON TRUE
  `);

  for (const row of rows) {
    const series = points.get(row.token_address);
    if (!series) continue;
    const index = Number(row.idx);
    if (!Number.isInteger(index) || index < 0 || index >= instants.length) continue;
    // numeric arrives as a string. Number() here rather than a cast in SQL, so
    // the value that reaches the index is the one Postgres stored.
    series[index] = row.price === null ? null : Number(row.price);
  }

  return points;
}

export interface LensIndex {
  /** 9 index points, oldest first, `null` where unpriceable. */
  series: (number | null)[];
  /** Last point of `series`, or `null`. */
  indexValue: number | null;
  /** `indexValue - 100`, or `null`. */
  movePct: number | null;
  /** Members priceable at the newest instant, after renormalisation. */
  pricedMemberCount: number;
}

/**
 * Pure basket maths: member weights and their 9-point price series in, the lens
 * index out. No IO, so the same inputs always produce the same index (BE-19
 * acceptance criterion 1). See the file header for the rebase rule.
 */
export function computeLensIndex(
  members: readonly { weightPct: number; prices: (number | null)[] }[],
): LensIndex {
  const pointCount = LENS_SERIES_POINTS;
  const series = new Array<number | null>(pointCount).fill(null);

  // A member with no base price is absent from the whole window.
  const withBase = members.filter((member) => {
    const base = member.prices[0];
    return typeof base === "number" && Number.isFinite(base) && base > 0;
  });

  let pricedMemberCount = 0;

  for (let k = 0; k < pointCount; k += 1) {
    const eligible = withBase.filter((member) => {
      const price = member.prices[k];
      return typeof price === "number" && Number.isFinite(price) && price > 0;
    });
    if (eligible.length === 0) continue;

    const totalWeight = eligible.reduce((sum, member) => sum + member.weightPct, 0);
    if (totalWeight <= 0) continue;

    let value = 0;
    for (const member of eligible) {
      const base = member.prices[0] as number;
      const price = member.prices[k] as number;
      value += (member.weightPct / totalWeight) * (price / base);
    }
    series[k] = round6(value * 100);
    if (k === pointCount - 1) pricedMemberCount = eligible.length;
  }

  const indexValue = series[pointCount - 1];
  return {
    series,
    indexValue: indexValue ?? null,
    movePct: indexValue === null || indexValue === undefined ? null : round6(indexValue - 100),
    pricedMemberCount,
  };
}

/** Signed 7-day mint/burn USD summed across a lens's members, plus how many
 *  members actually contributed. `null` total when none did. */
async function lensNetFlow(
  symbols: readonly string[],
  windowStartMs: number,
  cycleMs: number,
): Promise<{ netFlowUsd: number | null; flowMemberCount: number }> {
  let total = 0;
  let flowMemberCount = 0;
  for (const symbol of symbols) {
    const memberFlow = await trailingNetFlowUsd(symbol, windowStartMs, cycleMs);
    if (memberFlow === null) continue;
    total += memberFlow;
    flowMemberCount += 1;
  }
  return {
    netFlowUsd: flowMemberCount === 0 ? null : round2(total),
    flowMemberCount,
  };
}

/**
 * One aggregation cycle. Returns a summary; throws only on a genuine defect (the
 * DB write failing), never on a lens being uncomputable, which is a `null` row.
 */
export async function aggregateLenses(now = new Date()): Promise<LensAggregateSummary> {
  const startedMs = Date.now();
  const cycleMs =
    Math.floor(now.getTime() / LENS_AGGREGATE_INTERVAL_MS) * LENS_AGGREGATE_INTERVAL_MS;
  const cycleTs = new Date(cycleMs);
  const windowStartMs = cycleMs - LENS_WINDOW_SEC * 1000;
  const since24h = new Date(cycleMs - 24 * 60 * 60 * 1000);

  const summary: LensAggregateSummary = {
    startedAt: new Date(startedMs).toISOString(),
    durationMs: 0,
    cycleTs: cycleTs.toISOString(),
    lenses: 0,
    persisted: 0,
    nullIndex: 0,
    nullFlow: 0,
  };

  const lenses: LensDefinition[] = loadLenses();
  summary.lenses = lenses.length;
  if (lenses.length === 0) {
    summary.durationMs = Date.now() - startedMs;
    log.info("no lenses defined, nothing to aggregate");
    return summary;
  }

  // Every member symbol across every lens, uppercased for matching.
  const allSymbolKeys = new Set<string>();
  for (const lens of lenses) {
    for (const member of lens.members) allSymbolKeys.add(member.symbol.toUpperCase());
  }

  // Resolve members against the live universe. A member that is classified but
  // not currently an active universe row is simply unpriceable this cycle.
  const universeRows = await db
    .select({
      tokenAddress: universe.tokenAddress,
      symbol: universe.symbol,
      change24hPct: universe.change24hPct,
    })
    .from(universe);

  const memberBySymbol = new Map<string, UniverseMember>();
  for (const row of universeRows) {
    const key = row.symbol.toUpperCase();
    if (!allSymbolKeys.has(key)) continue;
    const existing = memberBySymbol.get(key);
    // Deterministic pick if a symbol somehow appears twice: lowest address.
    if (existing && existing.tokenAddress <= row.tokenAddress) continue;
    memberBySymbol.set(key, {
      tokenAddress: row.tokenAddress,
      symbol: row.symbol,
      change24hPct: row.change24hPct,
    });
  }

  const instants = sampleInstants(cycleMs);
  const addresses = [...new Set([...memberBySymbol.values()].map((member) => member.tokenAddress))];
  const pricePoints = await loadIndexPoints(addresses, instants);

  // Signals on member tickers in the last 24h, counted once for all lenses.
  const universeSymbols = [...new Set([...memberBySymbol.values()].map((member) => member.symbol))];
  const signalCountByTicker = new Map<string, number>();
  if (universeSymbols.length > 0) {
    const counts = await db
      .select({ ticker: signals.ticker, n: sql<number>`count(*)::int` })
      .from(signals)
      .where(and(inArray(signals.ticker, universeSymbols), gte(signals.ts, since24h)))
      .groupBy(signals.ticker);
    for (const row of counts) signalCountByTicker.set(row.ticker, Number(row.n));
  }

  const rows: NewLensMetricRecord[] = [];

  for (const lens of lenses) {
    const resolved = lens.members.map((member) => {
      const universeMember = memberBySymbol.get(member.symbol.toUpperCase()) ?? null;
      const prices = universeMember
        ? (pricePoints.get(universeMember.tokenAddress) ?? new Array(instants.length).fill(null))
        : new Array<number | null>(instants.length).fill(null);
      return { member, universeMember, prices };
    });

    const index = computeLensIndex(
      resolved.map((entry) => ({ weightPct: entry.member.weightPct, prices: entry.prices })),
    );

    const greenMemberCount = resolved.filter(
      (entry) =>
        entry.universeMember?.change24hPct !== null &&
        entry.universeMember?.change24hPct !== undefined &&
        entry.universeMember.change24hPct > 0,
    ).length;

    const memberSymbols = resolved
      .map((entry) => entry.universeMember?.symbol)
      .filter((symbol): symbol is string => typeof symbol === "string");

    const { netFlowUsd, flowMemberCount } = await lensNetFlow(
      memberSymbols,
      windowStartMs,
      cycleMs,
    );

    const signalCount24h = memberSymbols.reduce(
      (sum, symbol) => sum + (signalCountByTicker.get(symbol) ?? 0),
      0,
    );

    if (index.indexValue === null) summary.nullIndex += 1;
    if (netFlowUsd === null) summary.nullFlow += 1;

    rows.push({
      theme: lens.slug,
      ts: cycleTs,
      indexValue: index.indexValue,
      movePct: index.movePct,
      netFlowUsd,
      signalCount24h,
      memberCount: lens.members.length,
      greenMemberCount,
      pricedMemberCount: index.pricedMemberCount,
      flowMemberCount,
      series: index.series,
      computedAt: new Date(),
    });
  }

  if (rows.length > 0) {
    await db
      .insert(lensMetrics)
      .values(rows)
      .onConflictDoUpdate({
        target: [lensMetrics.theme, lensMetrics.ts],
        set: conflictUpdateSet(lensMetrics, [
          "indexValue",
          "movePct",
          "netFlowUsd",
          "signalCount24h",
          "memberCount",
          "greenMemberCount",
          "pricedMemberCount",
          "flowMemberCount",
          "series",
          "computedAt",
        ]),
      });
    summary.persisted = rows.length;
  }

  summary.durationMs = Date.now() - startedMs;
  log.info("lenses aggregated", { ...summary });
  return summary;
}
