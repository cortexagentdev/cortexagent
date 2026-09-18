import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type {
  AlertFire,
  DataQualityFlag,
  MarketRadar,
  RadarAsset,
  RadarLens,
  RadarSignal,
} from "@shared/contracts.ts";

import { loadFires } from "../alerts/fires.ts";
import { alertFires, alerts, signals, universe, watchlists } from "../db/schema.ts";
import { loadLenses } from "../lenses/load.ts";
import { latestMetricsByTheme, toSeries } from "../lenses/metrics.ts";
import type { Context } from "../trpc.ts";

/**
 * The Market Radar (priority 2): one wallet's research screen, composed from
 * rows the workers already wrote. Nothing here touches an RPC or RHJ: every
 * section is a Postgres read on an existing index, so the Radar adds no load to
 * the free upstreams and nothing to the worker schedule.
 *
 * After the watchlist row (which everything depends on), the sections run in
 * parallel, so one reading holds at most four pool connections at once.
 */

/** Signals older than this are not "latest". Matches the Signal Feed window. */
const SIGNAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Newest signals kept per watched ticker, so one noisy name cannot crowd the list. */
const SIGNALS_PER_TICKER = 3;
/** The Radar's signal list. The full feed is one click away. */
const MAX_SIGNALS = 20;
/** Unread fires shown inline. The Alerts view has the rest. */
const MAX_UNREAD_FIRES = 10;

type Deps = Pick<Context, "db">;

type UniverseSlice = Pick<
  typeof universe.$inferSelect,
  | "symbol"
  | "name"
  | "tokenAddress"
  | "priceUsd"
  | "change24hPct"
  | "feedAgeSec"
  | "maxStalenessSec"
  | "chainlinkFeed"
  | "feedAgreesWithQuote"
  | "multiplierMismatch"
  | "paused"
  | "oraclePaused"
  | "tokenPaused"
  | "isTradingHalt"
  | "signalEligible"
  | "ineligibleReasons"
  | "sparkSeries"
  | "refreshedAt"
>;

/** Derived here, not in the UI, so every surface names a problem the same way. */
function dataQualityFlags(row: UniverseSlice): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  if (row.priceUsd === null) flags.push("UNPRICED");
  if (row.chainlinkFeed === null) {
    flags.push("NO_FEED");
  } else {
    if (
      row.feedAgeSec !== null &&
      row.maxStalenessSec !== null &&
      row.feedAgeSec > row.maxStalenessSec
    ) {
      flags.push("STALE_FEED");
    }
    if (!row.feedAgreesWithQuote) flags.push("FEED_QUOTE_DISAGREE");
  }
  if (row.multiplierMismatch) flags.push("MULTIPLIER_MISMATCH");
  if (row.paused || row.oraclePaused || row.tokenPaused) flags.push("PAUSED");
  if (row.isTradingHalt) flags.push("HALTED");
  if (!row.signalEligible) flags.push("NOT_SIGNAL_ELIGIBLE");
  return flags;
}

/** Watched tickers are stored upper-cased; `universe.symbol` is canonical. */
async function watchedUniverse(ctx: Deps, tickers: string[]): Promise<UniverseSlice[]> {
  if (tickers.length === 0) return [];
  return ctx.db
    .select({
      symbol: universe.symbol,
      name: universe.name,
      tokenAddress: universe.tokenAddress,
      priceUsd: universe.priceUsd,
      change24hPct: universe.change24hPct,
      feedAgeSec: universe.feedAgeSec,
      maxStalenessSec: universe.maxStalenessSec,
      chainlinkFeed: universe.chainlinkFeed,
      feedAgreesWithQuote: universe.feedAgreesWithQuote,
      multiplierMismatch: universe.multiplierMismatch,
      paused: universe.paused,
      oraclePaused: universe.oraclePaused,
      tokenPaused: universe.tokenPaused,
      isTradingHalt: universe.isTradingHalt,
      signalEligible: universe.signalEligible,
      ineligibleReasons: universe.ineligibleReasons,
      sparkSeries: universe.sparkSeries,
      refreshedAt: universe.refreshedAt,
    })
    .from(universe)
    .where(inArray(sql`upper(${universe.symbol})`, tickers));
}

interface WatchedSignals {
  /** Up to `SIGNALS_PER_TICKER` per ticker, newest first within a ticker. */
  byTicker: Map<string, RadarSignal[]>;
  countByTicker: Map<string, number>;
}

/**
 * Current signals on the watched names. Matched on the exact stored ticker,
 * not `upper(ticker)`, so the plan is a backwards scan of
 * `signals_ticker_ts_idx (ticker, ts DESC)`, and the 24h bound lets Timescale
 * skip every older chunk. The window functions cap rows per ticker in SQL and
 * carry the per-ticker 24h count, so this is one round trip.
 */
async function watchedSignals(ctx: Deps, symbols: string[]): Promise<WatchedSignals> {
  const byTicker = new Map<string, RadarSignal[]>();
  const countByTicker = new Map<string, number>();
  if (symbols.length === 0) return { byTicker, countByTicker };

  const cutoff = new Date(Date.now() - SIGNAL_LOOKBACK_MS);
  const ranked = ctx.db
    .select({
      id: signals.id,
      ts: signals.ts,
      ticker: signals.ticker,
      kind: signals.kind,
      zScore: signals.zScore,
      confidence: signals.confidence,
      explanation: signals.explanation,
      rn: sql<number>`row_number() over (partition by ${signals.ticker} order by ${signals.ts} desc)`.as(
        "rn",
      ),
      n: sql<number>`count(*) over (partition by ${signals.ticker})`.as("n"),
    })
    .from(signals)
    .where(
      and(inArray(signals.ticker, symbols), gte(signals.ts, cutoff), isNull(signals.supersededBy)),
    )
    .as("ranked");

  const rows = await ctx.db
    .select()
    .from(ranked)
    .where(lte(ranked.rn, SIGNALS_PER_TICKER))
    .orderBy(ranked.ticker, ranked.rn);

  for (const row of rows) {
    countByTicker.set(row.ticker, Number(row.n));
    const list = byTicker.get(row.ticker) ?? [];
    list.push({
      id: row.id,
      ts: new Date(row.ts).toISOString(),
      ticker: row.ticker,
      kind: row.kind,
      zScore: row.zScore,
      confidence: row.confidence,
      explanation: row.explanation,
    });
    byTicker.set(row.ticker, list);
  }
  return { byTicker, countByTicker };
}

async function watchedLenses(ctx: Deps, themes: string[]): Promise<RadarLens[]> {
  if (themes.length === 0) return [];
  const catalog = new Map(loadLenses().map((lens) => [lens.slug, lens]));
  const known = themes.filter((slug) => catalog.has(slug));
  const metrics = await latestMetricsByTheme(ctx, known);

  return known.map((slug) => {
    const lens = catalog.get(slug)!;
    const metric = metrics.get(slug);
    return {
      slug,
      name: lens.name,
      color: lens.color,
      movePct: metric?.movePct ?? null,
      netFlowUsd: metric?.netFlowUsd ?? null,
      memberCount: lens.members.length,
      signalCount24h: metric?.signalCount24h ?? 0,
      series: toSeries(metric?.series),
      computedAt: metric?.computedAt.toISOString() ?? null,
    };
  });
}

/** The unseen count and the newest unseen fires, from one pair of reads. */
async function unreadFires(
  ctx: Deps,
  address: string,
): Promise<{ unseen: number; fires: AlertFire[] }> {
  const [fires, [tally]] = await Promise.all([
    loadFires(ctx, address, { limit: MAX_UNREAD_FIRES, unseenOnly: true }),
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(alertFires)
      .innerJoin(alerts, eq(alerts.id, alertFires.alertId))
      .where(and(eq(alerts.userId, address), isNull(alertFires.seenAt))),
  ]);
  return { unseen: Number(tally?.n ?? 0), fires };
}

function maxIso(values: (Date | string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

export async function composeRadar(ctx: Deps, address: string): Promise<MarketRadar> {
  const [row] = await ctx.db
    .select({ tickers: watchlists.tickers, themes: watchlists.themes })
    .from(watchlists)
    .where(eq(watchlists.userId, address))
    .limit(1);

  const tickers = row?.tickers ?? [];
  const themes = row?.themes ?? [];

  // Signals are keyed on the canonical symbol, so they wait on the universe
  // read; lenses and alerts do not depend on either and run alongside.
  const [assetsAndSignals, lenses, alertsSection] = await Promise.all([
    watchedUniverse(ctx, tickers).then(async (universeRows) => ({
      universeRows,
      signals: await watchedSignals(
        ctx,
        universeRows.map((u) => u.symbol),
      ),
    })),
    watchedLenses(ctx, themes),
    unreadFires(ctx, address),
  ]);

  const { universeRows, signals: watched } = assetsAndSignals;
  const bySymbol = new Map(universeRows.map((u) => [u.symbol.toUpperCase(), u]));

  const assets: RadarAsset[] = [];
  const missingTickers: string[] = [];
  for (const ticker of tickers) {
    const u = bySymbol.get(ticker);
    if (!u) {
      missingTickers.push(ticker);
      continue;
    }
    const recent = watched.byTicker.get(u.symbol) ?? [];
    assets.push({
      symbol: u.symbol,
      name: u.name,
      tokenAddress: u.tokenAddress as `0x${string}`,
      priceUsd: u.priceUsd,
      change24hPct: u.change24hPct,
      feedAgeSec: u.feedAgeSec,
      spark: u.sparkSeries,
      flags: dataQualityFlags(u),
      ineligibleReasons: u.ineligibleReasons,
      signalCount24h: watched.countByTicker.get(u.symbol) ?? 0,
      latestSignal: recent[0] ?? null,
    });
  }

  const radarSignals = [...watched.byTicker.values()]
    .flat()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, MAX_SIGNALS);

  return {
    asOf: {
      generatedAt: new Date().toISOString(),
      universeRefreshedAt: maxIso(universeRows.map((u) => u.refreshedAt)),
      latestSignalTs: radarSignals[0]?.ts ?? null,
      lensComputedAt: maxIso(lenses.map((l) => l.computedAt)),
    },
    assets,
    missingTickers,
    signals: radarSignals,
    lenses,
    alerts: alertsSection,
  };
}
