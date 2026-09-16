/**
 * Drizzle schema.
 *
 * Domain tables are added by the tasks that own them: universe (BE-5, below),
 * price history (BE-6), signals (BE-10), sessions (BE-21), watchlists and
 * alerts (BE-23), vault indexing (BE-26).
 *
 * ## Hypertable pattern
 *
 * `price_history`, `signals`, `nav_history`, `flows`, `lens_metrics` and
 * `alert_fires` are time series and belong in TimescaleDB hypertables. Drizzle
 * has no hypertable primitive, so the pattern is two steps in one migration:
 *
 * 1. Declare the table here as a normal `pgTable` and run `bun run db:generate`.
 *    The time column must be part of the primary key. Timescale partitions on
 *    it, and a primary key that does not include the partitioning column cannot
 *    be enforced.
 * 2. Append the conversion to the generated SQL file by hand, below the
 *    `CREATE TABLE`, separated by drizzle's `--> statement-breakpoint`:
 *
 *    ```sql
 *    SELECT create_hypertable('price_history', by_range('ts'), if_not_exists => TRUE);
 *    ```
 *
 * Never convert a table in a later migration than the one that creates it:
 * `create_hypertable` on a table that already holds rows rewrites it.
 *
 * One trap when hand-editing a generated file: keep backticks out of the SQL
 * comments. The migration reader mangles them, and Postgres then rejects the
 * whole file with a syntax error pointing at column 1.
 */

import { randomUUID } from "node:crypto";

import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { Confidence, PriceSource, SignalEvidence, SignalKind } from "@shared/contracts.ts";

/**
 * A USD or price amount. `numeric`, never `double precision`: a float column is
 * the usual way a price picks up a rounding artefact between the writer and the
 * reader. `mode: "number"` because the shared contract types every one of these
 * as `number` and the api must not hand the web app a string.
 */
const usd = () => numeric({ precision: 38, scale: 18, mode: "number" });

/**
 * The eligibility gate, one row per active Stock Token.
 *
 * Written only by `universe-refresher` (BE-5), except for four columns:
 * `change24hPct` and `sparkSeries` belong to the price poller (BE-6) and
 * `sector` / `factors` to the classification files (BE-18). The refresher's
 * upsert deliberately leaves all four alone, so a 60s cycle cannot blank work
 * another worker did.
 *
 * `spec/CortexBackend.md` PART 2 and PART 5 are the root of truth for the
 * columns. Three of them are counter-intuitive enough to repeat here:
 *
 * - `feedAgeSec` is recorded and displayed. It is never a rejection rule. Age
 *   tracks volatility, not oracle health, and the stalest feeds in this
 *   universe are its most liquid instruments (global do-not 1).
 * - `feedAgreesWithQuote` is the actual freshness test: the Chainlink answer
 *   against an independent `/rhj/prices` midpoint.
 * - `priceUsd` is null when the asset is unpriceable. Never 0 (global do-not 2).
 */
export const universe = pgTable(
  "universe",
  {
    /** The authenticity key. `StockFactory.tokenAddress(uid)` produced it, and
     *  nothing is matched on symbol anywhere in this product (global do-not 3). */
    tokenAddress: text().primaryKey(),
    symbol: text().notNull(),
    name: text().notNull(),
    /** 18 on every Stock Token, read from the token rather than assumed. */
    decimals: integer().notNull(),
    /** Robinhood asset UID, the `bytes32` the factory lookup takes. */
    onchainUid: text().notNull(),

    // --- Gate 1, authenticity -----------------------------------------------
    /** Factory-canonical address AND active status AND totalSupply > 0. All
     *  three: 203 tokens are factory-deployed against 96 active, so membership
     *  alone would admit 107 zero-supply ghosts (global do-not 4). */
    authentic: boolean().notNull(),
    registrySource: text().$type<"onchain-registry" | "rhj-assets">().notNull(),
    registryCheckedAt: timestamp({ withTimezone: true }).notNull(),
    assetStatus: text().notNull(),

    // --- Pricing ------------------------------------------------------------
    /** AggregatorV3 proxy, or null for the 61 active tokens with no feed. */
    chainlinkFeed: text(),
    feedDecimals: integer(),
    heartbeatSec: integer(),
    /** Cortex's own on-chain liveness bound (heartbeat + grace). Recorded for
     *  the UI and for the vault; it is not applied as an off-chain filter. */
    maxStalenessSec: integer(),
    /** now - updatedAt, clamped at 0. One feed was observed reporting an
     *  `updatedAt` 14s in the future, so clock skew is real. */
    feedAgeSec: integer(),
    quoteBid: usd(),
    quoteAsk: usd(),
    /** The freshness test (Design Law 3a), not a staleness budget. */
    feedAgreesWithQuote: boolean().notNull().default(false),
    /** 18-dp fixed point, kept as text. Exactness matters: BE-13 compares these
     *  against the registry value and a float round-trip loses it. */
    uiMultiplier: text().notNull(),
    newUIMultiplier: text().notNull(),
    multiplierEffectiveAt: bigint({ mode: "number" }),
    registryMultiplier: text().notNull(),
    /** On-chain and registry disagree. A signal, never something to silence. */
    multiplierMismatch: boolean().notNull().default(false),
    /** Raw `latestRoundData().answer`, unscaled, as text. */
    lastAnswer: text(),
    lastUpdatedAt: bigint({ mode: "number" }),

    // Four advisory flags. Each downgrades vault eligibility and each is
    // displayed; none is a pricing gate on its own (Design Law 3c).
    oraclePaused: boolean().notNull().default(false),
    tokenPaused: boolean().notNull().default(false),
    paused: boolean().notNull().default(false),
    isTradingHalt: boolean().notNull().default(false),

    /** Null when unpriceable. Never 0. */
    priceUsd: usd(),
    priceSource: text().$type<PriceSource>(),

    // --- Gate 2, liquidity --------------------------------------------------
    liquidityUsd: usd().notNull().default(0),
    poolDepthUsd: usd().notNull().default(0),
    /** Pool addresses sampled for depth, from direct pool reads. Never an
     *  aggregator API (locked decision 8). */
    venues: jsonb().$type<`0x${string}`[]>().notNull().default([]),

    // --- Gate 3, redeemability ----------------------------------------------
    redeemable: boolean().notNull().default(false),
    /** Largest redeem that holds the NAV band against sampled depth. */
    maxRedeemUsd: usd().notNull().default(0),

    // --- Classification, owned by BE-18 -------------------------------------
    sector: text(),
    factors: jsonb().$type<string[]>().notNull().default([]),

    /** Issuer restrictions on the underlying Stock Token. Disclosure only.
     *  Cortex does not geo-block, so nothing branches on this (decision 4). */
    jurisdictionBlocks: jsonb().$type<string[]>().notNull().default([]),

    // --- The two eligibility flags ------------------------------------------
    /** authentic && priced by any source. Runs over all 96. */
    signalEligible: boolean().notNull().default(false),
    /** signalEligible && a Chainlink feed && depth >= floor && redeemable.
     *  Only the 35 with an on-chain feed can back a vault: a contract cannot
     *  read a REST quote. */
    vaultEligible: boolean().notNull().default(false),
    /** Populated for every exclusion. A silent exclusion is a bug (do-not 5). */
    ineligibleReasons: jsonb().$type<string[]>().notNull().default([]),

    // --- Display columns owned by BE-6 --------------------------------------
    change24hPct: numeric({ precision: 18, scale: 6, mode: "number" }),
    sparkSeries: jsonb().$type<number[]>().notNull().default([]),

    refreshedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    // Not unique. Symbol is a display field here, never a lookup key that a
    // spoof could collide with, and the uniqueness that matters is the primary
    // key on tokenAddress.
    index("universe_symbol_idx").on(table.symbol),
    index("universe_signal_eligible_idx").on(table.signalEligible),
    index("universe_vault_eligible_idx").on(table.vaultEligible),
    index("universe_refreshed_at_idx").on(table.refreshedAt),
  ],
);

export type UniverseRecord = typeof universe.$inferSelect;
export type NewUniverseRecord = typeof universe.$inferInsert;

/**
 * The price series, one row per priceable asset per 60s poll cycle (BE-6).
 *
 * A Timescale hypertable on `ts`, per PART 5. `universe` holds the current
 * price; this holds the shape of the last 24 hours, which is what the 24h
 * change and the sparkline are derived from. Both derived values are computed
 * once per cycle and written back to `universe`, because a per-row history
 * query on every `universeRouter.list()` call would run 96 lookbacks on every
 * dashboard load.
 *
 * Two columns that PART 5 does not spell out, and one it does:
 *
 * - `tokenAddress` is the series identity. PART 5 names the series by `ticker`
 *   and the ticker is kept for display and for the lookback index, but nothing
 *   in this product joins on a symbol (global do-not 3), and a ticker that
 *   Robinhood reassigns would otherwise splice two different assets into one
 *   line on a chart.
 * - `afterHours` is nullable until BE-7 lands the session helper. Null means
 *   "the session was not known", which is a different fact from "regular
 *   hours", and BE-14 must be able to tell them apart. TODO(BE-7).
 * - `stale` records that the Chainlink round behind a price sat outside its own
 *   liveness bound (heartbeat + grace, 90,000s). It is recorded and displayed,
 *   never a rejection rule, and never measured in minutes: these feeds update
 *   on 0.5% movement, so a 14-hour-old feed on a liquid name is a calm market
 *   (global do-not 1).
 */
export const priceHistory = pgTable(
  "price_history",
  {
    /** Series identity. Matches `universe.tokenAddress`. */
    tokenAddress: text().notNull(),
    /** Display label, and the key PART 5 names the series by. */
    ticker: text().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    /** Never 0 and never a placeholder: an unpriceable asset gets no row at all
     *  this cycle rather than a zero one (global do-not 2). */
    price: usd().notNull(),
    source: text().$type<PriceSource>().notNull(),
    /** Null until BE-7. TODO(BE-7): fill from the session helper. */
    afterHours: boolean(),
    stale: boolean().notNull().default(false),
    isTradingHalt: boolean().notNull().default(false),
  },
  (table) => [
    // The time column has to be in the primary key: Timescale partitions on it
    // and cannot enforce a key that does not include the partitioning column.
    primaryKey({ columns: [table.tokenAddress, table.ts] }),
    // The lookback index. Every read of this table is "the newest sample at or
    // before T for one series", which this serves as a backwards scan.
    index("price_history_ticker_ts_idx").on(table.ticker, table.ts.desc()),
  ],
);

export type PriceHistoryRecord = typeof priceHistory.$inferSelect;
export type NewPriceHistoryRecord = typeof priceHistory.$inferInsert;

/**
 * The signal store, one row per (kind, ticker, windowEnd) triple (BE-10).
 *
 * `spec/CortexBackend.md` PART 3 owns the shape and PART 5 names the table. It
 * matches the `Signal` contract in `shared/contracts.ts` field for field, and
 * nothing here is kind-specific: the six processors (BE-11 through BE-16) plug
 * into the framework in `api/src/signals/` and this table is where their output
 * lands.
 *
 * A Timescale hypertable on `ts`, per PART 5.
 *
 * ## The id is deterministic, and that is load-bearing
 *
 * `id = sha256(kind | ticker | windowEnd)`, computed in `signals/registry.ts`.
 * Re-running a window produces the same id, so the signal computer upserts
 * rather than duplicates. Two consumers rely on this: `BE-24`'s alert evaluator
 * dedupes fires on it, and windows genuinely do get recomputed whenever the
 * worker restarts mid-window.
 *
 * The primary key is `(id, ts)`. Timescale partitions on `ts` and cannot
 * enforce a key that omits the partitioning column; `id` already determines
 * `ts` (the window end is baked into the hash), so the pair is still effectively
 * unique on `id` and the upsert conflict target is the whole key.
 *
 * ## Three columns worth repeating
 *
 * - `magnitude`, `zScore` and `rank` are statistics, not money, so they are
 *   `double precision` rather than the 18-dp `numeric` the price columns use.
 * - `explanation`, `sources` and `evidence` are never null and `sources` is
 *   never empty. `signals/validate.ts` enforces this before a row is written:
 *   Design Law 5 and PART 7 acceptance criterion 2 make an unsourced signal
 *   worse than no signal, because the UI renders it as evidence.
 * - `supersededBy` points at the newer row of the same kind and ticker. The
 *   computer sets it on the older row when the newer one is persisted.
 */
export const signals = pgTable(
  "signals",
  {
    /** Deterministic: sha256(kind | ticker | windowEnd). See the file header. */
    id: text().notNull(),
    /** When the signal fired. Equal to the window end, which is what makes the
     *  id stable across a recompute of the same window. */
    ts: timestamp({ withTimezone: true }).notNull(),
    ticker: text().notNull(),
    /** Matches `universe.tokenAddress`. Authenticity is an address match, never
     *  a symbol match (global do-not 3). */
    tokenAddress: text().notNull(),
    kind: text().$type<SignalKind>().notNull(),
    /** Signed, in the kind's native unit. */
    magnitude: doublePrecision().notNull(),
    /** Magnitude against a 30-day trailing baseline, per ticker and kind.
     *  Computed by the shared helper in `signals/baseline.ts`. */
    zScore: doublePrecision().notNull(),
    /** Feed ordering score, f(zScore, confidence, recency). One function, in
     *  `signals/rank.ts`. */
    rank: doublePrecision().notNull(),
    confidence: text().$type<Confidence>().notNull(),
    /** Plain language, why it fired. Mandatory, never empty. */
    explanation: text().notNull(),
    /** What the explanation is computed from: block range, observed, baseline,
     *  sampleSize. */
    evidence: jsonb().$type<SignalEvidence>().notNull(),
    /** Tx hashes, feed round ids, pool addresses. Never empty. */
    sources: jsonb().$type<string[]>().notNull(),
    /** ISO-8601 duration, e.g. "PT4H". */
    window: text().notNull(),
    /** Equity calendar state at `ts`, from BE-7's `isAfterHours`. */
    afterHours: boolean().notNull(),
    /** Id of the newer signal of the same kind and ticker, or null. */
    supersededBy: text(),
  },
  (table) => [
    // ts is in the key because Timescale partitions on it. id determines ts, so
    // this stays unique on id in practice and the upsert targets the pair.
    primaryKey({ columns: [table.id, table.ts] }),
    // The feed reads one kind newest-first; the ticker detail view reads one
    // ticker newest-first. Both are backwards scans on these.
    index("signals_kind_ts_idx").on(table.kind, table.ts.desc()),
    index("signals_ticker_ts_idx").on(table.ticker, table.ts.desc()),
  ],
);

export type SignalRecord = typeof signals.$inferSelect;
export type NewSignalRecord = typeof signals.$inferInsert;

/**
 * Cursor state for the forward-only chain indexers (BE-15).
 *
 * `spec/CortexBackend.md` PART 3 and locked decision 9: holder and liquidity
 * history is indexed forward from the moment the indexer first runs, never
 * backfilled from genesis. One row per indexer.
 *
 * - `startBlock` is the head at first run. Persisted so "how much history do we
 *   have" is answerable, and so a redeploy cannot silently restart the baseline.
 * - `lastBlock` is the newest block whose logs are fully applied. On restart the
 *   indexer resumes from `lastBlock + 1`; the cursor bump and the balance writes
 *   for a chunk commit in one transaction, so a crash leaves no gap and no
 *   double-count.
 * - `startedAt` dates `startBlock` in wall-clock time, which is what
 *   `holder-concentration` reports as the baseline length ("baseline covers 6
 *   days") while less than 30 days of forward data exist.
 */
export const indexerState = pgTable("indexer_state", {
  /** Indexer name, e.g. "transfer". */
  indexer: text().primaryKey(),
  /** Chain head at first run. Never 0: a 0 here would mean a genesis scan. */
  startBlock: bigint({ mode: "number" }).notNull(),
  /** Newest fully-applied block. Resume point is this + 1. */
  lastBlock: bigint({ mode: "number" }).notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});

export type IndexerStateRecord = typeof indexerState.$inferSelect;
export type NewIndexerStateRecord = typeof indexerState.$inferInsert;

/**
 * Per-address token balances, accumulated forward from each `Transfer` event
 * (BE-15).
 *
 * ## What the number is, and is not
 *
 * `balance` is the running sum of transfer deltas this indexer has seen since
 * `indexer_state.startBlock` for the "transfer" indexer. It is **raw token
 * units**, not multiplier-adjusted, and because indexing is forward-only it is
 * the net change since index start, not necessarily the address's absolute
 * holding: a wallet that held tokens before the indexer started and has not
 * moved them since is invisible here.
 *
 * So this table is a candidate list and a cheap ranking proxy, not the holder
 * math. `holder-concentration` takes the largest positive balances as its
 * candidate set, then reads the authoritative `balanceOfUI()` /
 * `totalSupplyUI()` off-chain for the share arithmetic (PART 3: use the
 * multiplier-adjusted views, never raw balance times multiplier, or the numbers
 * drift exactly at a corporate action).
 *
 * The mint and burn address (`0x0`) accumulates like any other and is filtered
 * out when ranking holders.
 */
export const holderBalances = pgTable(
  "holder_balances",
  {
    /** Lowercased. Matches `universe.tokenAddress` case-insensitively. */
    tokenAddress: text().notNull(),
    /** Lowercased holder address. */
    address: text().notNull(),
    /** Raw token units, cumulative since index start. `numeric(78, 0)` covers a
     *  full uint256. */
    balance: numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenAddress, table.address] }),
    // The candidate-set read is "the largest balances for one token".
    index("holder_balances_token_balance_idx").on(table.tokenAddress, table.balance.desc()),
  ],
);

export type HolderBalanceRecord = typeof holderBalances.$inferSelect;
export type NewHolderBalanceRecord = typeof holderBalances.$inferInsert;

/**
 * Per-theme aggregate behaviour, one row per lens per aggregator cycle (BE-19).
 *
 * `spec/CortexBackend.md` PART 3 defines lens *grouping* only; the maths the
 * Theme Lenses UI renders (an aggregate move, a net flow, a signal count, a
 * sparkline) is defined and computed by `workers/lens-aggregator.ts`. This
 * table is where it lands. A Timescale hypertable on `ts`, per PART 5.
 *
 * ## null is not zero
 *
 * `index_value`, `move_pct` and `net_flow_usd` are *measurements* and are null
 * when they cannot be computed (every member unpriceable, no price history yet,
 * no recorded flow). A lens that is flat and a lens that cannot be read must
 * stay distinguishable, exactly as `universe.change24hPct` does in BE-6 (global
 * do-not 2). `signal_count_24h`, `member_count` and `green_member_count` are
 * *census* figures: 0 is a true value there and is stored as 0.
 *
 * ## The series
 *
 * `series` is the 9 downsampled index points the sparkline renders, oldest
 * first, `null` where that observation could not be priced. `index_value` is
 * the newest of those points. See the worker for the rebase rule.
 *
 * ## Determinism
 *
 * `(theme, ts)` is the key. The worker floors `ts` to its cycle interval, so a
 * re-run of the same cycle upserts the same row rather than appending, and the
 * metrics recompute to the same numbers from the same price_history / signals /
 * FLOW-cache inputs (BE-19 acceptance criterion 1).
 */
export const lensMetrics = pgTable(
  "lens_metrics",
  {
    /** Lens slug, matches `data/lenses.json` and `LensSummary.slug`. */
    theme: text().notNull(),
    /** Cycle instant, floored to `LENS_AGGREGATE_INTERVAL_MS`. */
    ts: timestamp({ withTimezone: true }).notNull(),

    // --- Measurements: null when uncomputable, never 0 as a stand-in --------
    /** Weighted basket index, rebased to 100 at the start of the 7-day window.
     *  Equal to the last non-null entry of `series`. Null when no member was
     *  priceable across the window. */
    indexValue: numeric({ precision: 18, scale: 6, mode: "number" }),
    /** 7-day index change in percent, i.e. `indexValue - 100`. Null with
     *  `indexValue`. */
    movePct: numeric({ precision: 18, scale: 6, mode: "number" }),
    /** Signed sum of member authorized-participant mint/burn USD over the
     *  trailing 7 days (positive = net creation). Null when FLOW has recorded
     *  nothing for any member. */
    netFlowUsd: usd(),

    // --- Census figures: 0 is a real value --------------------------------
    /** Signals on member tickers in the last 24h. */
    signalCount24h: integer().notNull().default(0),
    /** Curated members of the lens (from `lenses.json`). */
    memberCount: integer().notNull().default(0),
    /** Members whose `universe.change24hPct` is a positive number. The
     *  "4 of 5 green" numerator W-5 phrases; the sentence is not composed here. */
    greenMemberCount: integer().notNull().default(0),
    /** Members that contributed a price to the latest index observation, after
     *  unpriceable members were dropped and weights renormalised. */
    pricedMemberCount: integer().notNull().default(0),
    /** Members that contributed a recorded FLOW observation to `netFlowUsd`. */
    flowMemberCount: integer().notNull().default(0),

    /** 9 index points, oldest first, `null` where unpriceable. */
    series: jsonb().$type<(number | null)[]>().notNull().default([]),

    /** Wall-clock time the row was computed. */
    computedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    // ts is in the key because Timescale partitions on it and cannot enforce a
    // key that omits the partitioning column. theme determines nothing about
    // ts, so the pair is the natural (theme, cycle) uniqueness.
    primaryKey({ columns: [table.theme, table.ts] }),
    // Every read is "the newest row for one theme" (BE-20). A backwards scan.
    index("lens_metrics_theme_ts_idx").on(table.theme, table.ts.desc()),
  ],
);

export type LensMetricRecord = typeof lensMetrics.$inferSelect;
export type NewLensMetricRecord = typeof lensMetrics.$inferInsert;

/**
 * SIWE sign-in state, one row per wallet address (BE-21).
 *
 * `spec/CortexBackend.md` PART 1: identity is a wallet address proven by a SIWE
 * signature, no passwords and no email. One row carries two things:
 *
 * - The **pending nonce** for an in-flight sign-in. `authRouter.nonce` writes it,
 *   `authRouter.verify` checks it against the signed message and then clears it.
 *   A nonce is single-use: on a successful verify the column is set back to null,
 *   so a replayed message fails the match (task acceptance criterion 2).
 * - The **current session** window. `issuedAt` and `expiresAt` bound the JWT the
 *   verify step puts in the cookie, and `revokedAt` is set by `authRouter.logout`
 *   so a sign-out takes effect server-side even though the JWT itself is
 *   stateless. The session context in `trpc.ts` rejects a token whose row is
 *   revoked, is past `expiresAt`, or whose `issuedAt` no longer matches the
 *   token (a credential left over from a superseded sign-in).
 *
 * `address` is the primary key and is stored lowercased. Authenticity here is
 * the ECDSA signature itself, not an address-registry match, so the checksum
 * form carries no extra meaning and lowercasing keeps the lookup key stable.
 */
export const sessions = pgTable("sessions", {
  address: text().primaryKey(),
  nonce: text(),
  nonceExpiresAt: timestamp({ withTimezone: true }),
  issuedAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }),
  revokedAt: timestamp({ withTimezone: true }),
});

export type SessionRecord = typeof sessions.$inferSelect;
export type NewSessionRecord = typeof sessions.$inferInsert;

/**
 * The per-user watchlist, one row per wallet address (BE-22).
 *
 * `spec/CortexBackend.md` PART 5 names the table and PART 1 fixes the identity:
 * `userId` is a wallet address, the same lowercased `0x…` string
 * `protectedProcedure` proves and puts on `ctx.session.address`. It is the
 * primary key, so a user has exactly one watchlist and `watchlistRouter.set`
 * upserts on it.
 *
 * `tickers` and `themes` are stored as jsonb string arrays. `tickers` holds
 * `universe.symbol` values (validated against the live universe before a write)
 * and `themes` holds lens slugs from `data/lenses.json`. `themes` is not read by
 * the current dashboard, but it is part of the table and the contract, so the
 * router persists it unchanged (task requirement 6).
 *
 * The address is the only scope key. No router route takes a `userId` from the
 * client: that would let any caller read or overwrite another user's row.
 */
export const watchlists = pgTable("watchlists", {
  /** Lowercased wallet address, from `ctx.session.address`. Never a client input. */
  userId: text().primaryKey(),
  /** `universe.symbol` values. Validated against the live universe on write. */
  tickers: jsonb().$type<string[]>().notNull().default([]),
  /** Lens slugs from `data/lenses.json`. Persisted even though the current UI
   *  does not read them. */
  themes: jsonb().$type<string[]>().notNull().default([]),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type WatchlistRecord = typeof watchlists.$inferSelect;
export type NewWatchlistRecord = typeof watchlists.$inferInsert;

/**
 * Alert rules, one row per rule (BE-23).
 *
 * `spec/CortexBackend.md` PART 5 names the table; **locked decision 2** fixes
 * its shape: alerts are in-app only, so there is no transport or delivery column
 * here, in `alertRouter`, or in the `AlertRule` contract. Delivery is implicit,
 * a fired rule writes an `alert_fires` row and the terminal reads it.
 *
 * `userId` is a wallet address, the same lowercased `0x…` string
 * `protectedProcedure` proves and puts on `ctx.session.address`. Every route in
 * `alertRouter` scopes on it and none accepts it from the client: taking one
 * would let any caller read, toggle or delete another user's rules.
 *
 * `fires` and `lastFiredAt` from the `AlertRule` contract are **not stored
 * here**. They are derived on read from `alert_fires` (a rolling 30-day count
 * and a max timestamp). Denormalising them onto this row would let them drift
 * from the fire log they summarise.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Lowercased wallet address, from `ctx.session.address`. Never a client input. */
    userId: text().notNull(),
    /** A `SignalKind`, or "ANY" to match every kind. Validated in the router. */
    kind: text().$type<SignalKind | "ANY">().notNull(),
    /** A `universe.symbol` (upper-cased), or "ANY". Validated against the live
     *  universe on write; nothing is matched on symbol elsewhere (global do-not 3). */
    ticker: text().notNull(),
    /** z-score trigger. A statistic, not money, so `double precision` like
     *  `signals.zScore`. The router bounds it to 1.5 .. 5.0. */
    threshold: doublePrecision().notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("alerts_user_id_idx").on(table.userId)],
);

export type AlertRecord = typeof alerts.$inferSelect;
export type NewAlertRecord = typeof alerts.$inferInsert;

/**
 * The alert fire log, one row per (rule, signal) match (BE-23), written by the
 * evaluator worker (BE-24) and read by the terminal (W-8).
 *
 * A Timescale hypertable on `ts`, per PART 5.
 *
 * ## Idempotency, the load-bearing part
 *
 * `id` is deterministic: `${alertId}:${signalId}`. Signal ids are themselves
 * deterministic (BE-10, `hash(kind | ticker | windowEnd)`) and signal windows
 * genuinely get recomputed on a worker restart or a retry, so the same
 * (rule, signal) match is presented to the evaluator more than once. The unique
 * key on `(alertId, signalId)` turns the repeat into an `ON CONFLICT DO NOTHING`
 * no-op instead of a duplicate fire. This belongs in the schema, not in worker
 * logic: it also closes the race between two concurrent workers (BE-24).
 *
 * `ts` is the **matched signal's `ts`** (its window end), not wall-clock fire
 * time. Two reasons: a recompute of the same window then produces the same `ts`,
 * so the row is byte-identical and the conflict is clean; and Timescale
 * partitions on `ts` and cannot enforce a unique key that omits the partitioning
 * column, so `(alertId, signalId, ts)` is the constraint drizzle emits. Because
 * `signalId` already determines `ts`, that stays unique on `(alertId, signalId)`
 * in practice.
 *
 * `seenAt` is null until the terminal marks the fire seen (`alertRouter.markSeen`).
 * It backs the unread badge in W-8.
 */
export const alertFires = pgTable(
  "alert_fires",
  {
    /** Deterministic: `${alertId}:${signalId}`. Stable across a window recompute. */
    id: text().notNull(),
    alertId: text().notNull(),
    /** The signal id that matched. Deterministic (BE-10). */
    signalId: text().notNull(),
    /** The matched signal's window end. See the header: not wall-clock time. */
    ts: timestamp({ withTimezone: true }).notNull(),
    /** Null until `markSeen`. Backs W-8's unread badge. */
    seenAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    // id determines ts, so this stays unique on id in practice; ts is in the key
    // because Timescale partitions on it.
    primaryKey({ columns: [table.id, table.ts] }),
    // The idempotency key BE-24 relies on. ts is included for the same Timescale
    // reason, and signalId determines it, so this is unique on (alertId, signalId).
    unique("alert_fires_alert_id_signal_id_key").on(table.alertId, table.signalId, table.ts),
    // The rolling 30-day count and the max-ts read, per alert, newest first.
    index("alert_fires_alert_id_ts_idx").on(table.alertId, table.ts.desc()),
    // The unread-badge scan.
    index("alert_fires_seen_at_idx").on(table.seenAt),
  ],
);

export type AlertFireRecord = typeof alertFires.$inferSelect;
export type NewAlertFireRecord = typeof alertFires.$inferInsert;

/**
 * The immutable vault policy, as indexed off `ThemeFactory`'s two deploy events
 * (`ThemeDeployed` + `ThemeComposition`, BE-25e) plus one `allowedVenues()` read
 * (the venue allowlist is not carried in either event). Every address is stored
 * lowercased; weights and caps are in bps. This is the `spec` jsonb PART 5 names
 * on `theme_tokens`.
 */
export interface ThemeSpec {
  /** Constituent Stock Token addresses. The 35-name feed-carrying universe. */
  constituents: string[];
  /** Parallel Chainlink AggregatorV3 proxies, one per constituent. */
  feeds: string[];
  /** Parallel target weights, bps, summing to 10000. */
  targetWeightsBps: number[];
  /** Parallel per-constituent weight caps, bps. */
  capsBps: number[];
  /** Historical deployments only; absent from static-v5 policy. */
  driftBandBps?: number;
  /** Mint/redeem spread retained in the vault, bps. */
  mintRedeemBandBps: number;
  /** Swap venue allowlist, from `KeylessVault.allowedVenues()`. */
  venues: string[];
  /** USDG settlement token on 46630. */
  usdg: string;
  /** The `FeeController` streaming the creator fee. */
  feeController: string;
  /** `keccak256(abi.encode(vaultPolicy))`, the integrity anchor and the join
   *  key between the two deploy events. */
  policyHash: string;
  /** ERC-20 metadata of the share, read straight off the event. */
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * The deployed theme tokens, one row per `ThemeDeployed` event (BE-26).
 *
 * `spec/CortexBackend.md` PART 4 and PART 5, and locked decision 5: C2 is
 * testnet only, so every row here has `chainId = 46630` and there is no real
 * value behind any of it.
 *
 * ## Column ownership
 *
 * The vault indexer owns every column except `aumUsd` and `status`. `aumUsd` is
 * the NAV poller's, refreshed each cycle from the latest observation, the same
 * split `universe` uses so one worker cannot blank another's column. `status` is
 * BE-27's: the indexer only ever learns that a theme is `deployed`, so its
 * upsert leaves a `draft` / `proposed` / `deprecated` value set by the router
 * alone.
 *
 * `id` is the theme token (ERC-20 share) address, lowercased. It is the identity
 * that `nav_history`, `flows` and `rebalances` reference as `tokenId`.
 * Authenticity is an address, never a symbol (global do-not 3).
 */
export const themeTokens = pgTable(
  "theme_tokens",
  {
    /** Theme token (share) address, lowercased. Same value as `token`. */
    id: text().primaryKey(),
    /** Theme creator, the fee-split beneficiary. Holds no on-chain power. Lowercased. */
    creator: text().notNull(),
    /** Lens slug, e.g. "ai-infrastructure". The event's `slug`. */
    theme: text().notNull(),
    /** The share address again, per PART 5's column list. Lowercased. */
    token: text().notNull(),
    /** The `KeylessVault` backing the share, lowercased. The event key the
     *  mint / redeem / rebalance indexer joins vault logs back to a token on. */
    vault: text().notNull(),
    /** The immutable policy. See `ThemeSpec`. */
    spec: jsonb().$type<ThemeSpec>().notNull(),
    /** Latest AUM in USD, owned by the NAV poller. Null until the first poll,
     *  and null (never 0) whenever a poll cannot read the vault. A genuinely
     *  empty vault does read a true 0 (global do-not 2). */
    aumUsd: usd(),
    /** Streaming fee, bps of AUM per year. From the event. */
    creatorFeeBps: integer().notNull(),
    /** BE-27's column. The indexer's upsert never writes it; it only ever knows
     *  a theme is deployed. */
    status: text().$type<"draft" | "proposed" | "deployed" | "deprecated">().notNull(),
    /** 46630. Testnet only (locked decision 5). */
    chainId: integer().notNull(),
    /** The `deployTheme()` transaction hash. */
    deployTx: text().notNull(),
    deployedAt: timestamp({ withTimezone: true }).notNull(),
    /** Block the `ThemeDeployed` log sat in. The lower bound for this token's
     *  nav and flow history. */
    deployBlock: bigint({ mode: "number" }).notNull(),
    /** Execution identity that observed the deployment. */
    executionDeploymentId: text().notNull(),
    /** Canonical block identity of the deployment event. */
    deployBlockHash: text(),
    deployLogIndex: integer(),
    factoryAddress: text(),
    factoryVersion: text(),
    /** An orphaned deployment remains auditable but is never a live vault. */
    canonical: boolean().notNull().default(true),
    canonicalReason: text(),
    /** Creation is not enough for execution: policy, feeds, assets and the
     *  immutable adapter must all match the reviewed release. */
    executionCompatibility: text()
      .$type<"verified" | "unverified" | "incompatible">()
      .notNull()
      .default("unverified"),
    executionCompatibilityReason: text(),
  },
  (table) => [
    index("theme_tokens_vault_idx").on(table.vault),
    index("theme_tokens_status_idx").on(table.status),
  ],
);

export type ThemeTokenRecord = typeof themeTokens.$inferSelect;
export type NewThemeTokenRecord = typeof themeTokens.$inferInsert;

/**
 * One constituent of a saved proposal, frozen at the values that enter
 * `deployTheme` calldata. Addresses lowercased, weights and caps in bps.
 */
export interface ThemeProposalConstituent {
  /** Display only. The address is the identity (global do-not 3). */
  symbol: string;
  tokenAddress: string;
  /** The Chainlink AggregatorV3 proxy that prices it on chain. */
  feed: string;
  weightBps: number;
  capBps: number;
}

/**
 * The whole `ThemeFactory.ThemeParams` payload a creator approved, minus the
 * `creator` field itself.
 *
 * `creator` is deliberately absent: it is bound at deploy from the caller's own
 * session, never from a stored document, so a proposal cannot carry an address
 * that pays someone else's fee. Everything else here is byte-for-byte what the
 * calldata would hold, which is what makes `basketHash` checkable against a
 * later recomputation.
 *
 * `maxRedeemUsdWad` is a decimal string: calldata uses uint256; JSON has no bigint.
 */
export interface ThemeProposalBasket {
  /** Server-owned predefined-lens identity; not calldata. Absent on historical
   * or custom proposals, which must never claim a predefined shared slot. */
  predefinedLensKey?: string;
  /** Deployment calldata identity. Older baskets without this are legacy-only. */
  slug: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  constituents: ThemeProposalConstituent[];
  creatorFeeBps: number;
  mintRedeemBandBps: number;
  slippageCapBps: number;
  maxRedeemUsdWad: string;
  /** The three deploy-config values, as they stood when the basket was hashed.
   *  Null / empty when unconfigured, which is itself part of the hash: a theme
   *  approved against no venue list is not the theme that deploys once one is
   *  set. */
  factory: string | null;
  usdg: string | null;
  venues: string[];
}

/**
 * Saved theme proposals, one row per basket a creator kept or approved (BE-29).
 *
 * ## Why this is not a `theme_tokens` row
 *
 * PART 5 types `theme_tokens.status` as `draft | proposed | deployed |
 * deprecated`, but `theme_tokens.id` is the THEME TOKEN ADDRESS, and that
 * address does not exist until the deploy transaction lands. A draft has no
 * primary key under that schema, which is why three of those four states had
 * never been written by anything: the BE-26 indexer is the only writer and it
 * only ever learns that a theme is `deployed`.
 *
 * Splitting the pre-deploy states into their own table keyed by a generated id
 * fixes that without taking `theme_tokens` away from the indexer, which should
 * stay its sole owner. The two are linked by `deployTx` once a proposal is
 * broadcast, and the same four status names are reused deliberately so the state
 * machine reads as the one PART 5 names rather than a second vocabulary:
 *
 * - `draft` — saved, not approved. `themeRouter.save`.
 * - `proposed` — a human approved this exact basket and asked for calldata.
 *   `themeRouter.deploy`, and `deployTx` is attached by `recordBroadcast`.
 * - `deployed` — the indexer wrote a `theme_tokens` row for `deployTx`.
 * - `deprecated` — discarded by its creator. `themeRouter.discard`.
 *
 * ## Proposals are private to their creator
 *
 * Every read is scoped by `creator` against `ctx.session.address`, and there is
 * no public-by-id route. A proposal is an unapproved policy draft that names the
 * address which would collect the fee, and nothing in the product needs to show
 * one to a stranger. Sharing is a decision that can be added later; being able
 * to enumerate other people's drafts cannot be taken back.
 */
export const themeProposals = pgTable(
  "theme_proposals",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Lowercased wallet address, from `ctx.session.address`. Never a client input. */
    creator: text().notNull(),
    /** Lens slug, e.g. "ai-infrastructure". Matches `theme_tokens.theme`. */
    theme: text().notNull(),
    status: text().$type<"draft" | "proposed" | "deployed" | "deprecated">().notNull(),
    /** Content hash over exactly the values that enter `deployTheme` calldata.
     *  `themeRouter.deploy` refuses when a recomputation does not reproduce it. */
    basketHash: text().notNull(),
    /** The frozen payload behind that hash. See `ThemeProposalBasket`. */
    basket: jsonb().$type<ThemeProposalBasket>().notNull(),
    /** 46630. Testnet only (locked decision 5). */
    chainId: integer().notNull(),
    /** Execution generation that created this revision; never adopted across forks. */
    executionDeploymentId: text(),
    /** The broadcast `deployTheme()` transaction, once the creator's wallet has
     *  sent one. The join key to `theme_tokens.deployTx`. */
    deployTx: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every read is "this creator's proposals, newest first".
    index("theme_proposals_creator_idx").on(table.creator, table.updatedAt.desc()),
    // The reconciliation lookup from a broadcast transaction hash.
    index("theme_proposals_deploy_tx_idx").on(table.deployTx),
  ],
);

export type ThemeProposalRecord = typeof themeProposals.$inferSelect;
export type NewThemeProposalRecord = typeof themeProposals.$inferInsert;

/**
 * The NAV series, one row per deployed theme token per poll cycle (BE-26).
 *
 * A Timescale hypertable on `ts`, per PART 5. `theme_tokens.aumUsd` holds the
 * current figure; this holds the shape the vault's NAV chart renders.
 *
 * ## `indicative` is not an error flag
 *
 * `navPerShare()` reverts by design when a constituent feed is outside its
 * liveness bound, and that is the safe failure, not an alarm (BE-25b, global
 * do-not 1). When it reverts, or the equity market is closed, the poller records
 * the observation from `navIndicative()` instead and sets `indicative = true`.
 * `navIndicative()` is read-only and no mint or redeem path consumes it; it is
 * display data only, and it stays on the read path here too.
 *
 * `navPerShare` is null when supply is zero (nothing to divide by) or when no
 * value, firm or indicative, could be read at all. Never 0 as a stand-in.
 */
export const navHistory = pgTable(
  "nav_history",
  {
    /** `theme_tokens.id`, the theme token address. */
    tokenId: text().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    /** `navPerShare()` in USD, or the `navIndicative()` value when that reverted.
     *  Null when supply is zero or nothing could be read. Never 0. */
    navPerShare: usd(),
    /** Vault AUM in USD. A true 0 for an empty vault; null when unreadable. */
    aumUsd: usd(),
    /** Market closed, or a constituent feed stale, or the strict read reverted:
     *  the value is `navIndicative()`, for display only. */
    indicative: boolean().notNull().default(false),
    /** The execution deployment and exact block used for this observation. */
    executionDeploymentId: text().notNull(),
    blockNumber: bigint({ mode: "number" }),
    blockHash: text(),
    /** Strict, indicative, or no valuation was available. */
    valuationStatus: text()
      .$type<"strict" | "indicative" | "unavailable">()
      .notNull()
      .default("unavailable"),
    valuationReason: text(),
    /** NAV is sampled at the end of a block; it is not transaction-exact. */
    navGranularity: text().notNull().default("block_end"),
    canonical: boolean().notNull().default(true),
    canonicalReason: text(),
  },
  (table) => [
    // ts is in the key because Timescale partitions on it and cannot enforce a
    // key that omits the partitioning column.
    primaryKey({ columns: [table.executionDeploymentId, table.tokenId, table.ts] }),
    // Every read is "the newest N points for one token". A backwards scan.
    index("nav_history_token_ts_idx").on(table.tokenId, table.ts.desc()),
  ],
);

export type NavHistoryRecord = typeof navHistory.$inferSelect;
export type NewNavHistoryRecord = typeof navHistory.$inferInsert;

/**
 * The mint / redeem log, one row per vault `Minted` / `Redeemed` /
 * `RedeemedToUsdg` event (BE-26).
 *
 * A Timescale hypertable on `ts`, per PART 5.
 *
 * ## Idempotency
 *
 * `(txHash, logIndex)` identifies an event uniquely, and both are stored. The
 * indexer re-scans a block range whenever it restarts mid-chunk, so the same
 * event is presented more than once; the key on `(txHash, logIndex, ts)` turns
 * the repeat into an `ON CONFLICT DO NOTHING` no-op. `ts` is in the key because
 * Timescale partitions on it, and the block already determines `ts`.
 *
 * ## The numbers
 *
 * `usd`, `shares` and `navPerShare` are human units, not raw wei. `usd` for a
 * mint is the event's own `depositValueUsd`; for a routed USDG redeem it is
 * the event's own `usdgOut` converted through the manifest's USDG decimals;
 * for an in-kind redeem it is `shares × navPerShare` at the block. A full
 * routed exit can leave no supply for a meaningful post-state NAV, so its
 * `navPerShare` is null with `NO_SUPPLY_AFTER_REDEEM` while `usd` remains exact.
 * Otherwise `navPerShare` is `navPerShare()` pinned to the flow's block,
 * falling back to `navIndicative()`, then null.
 */
export const flows = pgTable(
  "flows",
  {
    /** `theme_tokens.id`. */
    tokenId: text().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    kind: text().$type<"mint" | "redeem">().notNull(),
    /** The acting address (event `caller`), lowercased. */
    user: text().notNull(),
    /** USD value of the flow. Null for a redeem whose block NAV was unreadable.
     *  Never 0 as a stand-in (global do-not 2). */
    usd: usd(),
    /** Theme token amount, human units (`raw / 10^decimals`). */
    shares: usd().notNull(),
    /** `navPerShare()` at the flow's block, USD. Null when unreadable. */
    navPerShare: usd(),
    /** Legacy Redeemed.failedLegs count, or the count of new per-leg events. */
    failedLegs: integer(),
    failedLegTokens: jsonb().$type<string[]>(),
    navReason: text(),
    txHash: text().notNull(),
    blockNumber: bigint({ mode: "number" }).notNull(),
    blockHash: text(),
    /** Log index within the block. With `txHash`, the event's identity. */
    logIndex: integer().notNull(),
    executionDeploymentId: text().notNull(),
    /** End-of-block NAV used for a flow is explicitly not transaction-exact. */
    navGranularity: text().notNull().default("block_end"),
    canonical: boolean().notNull().default(true),
    canonicalReason: text(),
  },
  (table) => [
    // ts is in the key because Timescale partitions on it; (txHash, logIndex)
    // is already unique and the block determines ts.
    primaryKey({
      columns: [table.executionDeploymentId, table.txHash, table.logIndex, table.ts],
    }),
    // The vault surface reads "the newest flows for one token", newest first.
    index("flows_token_ts_idx").on(table.tokenId, table.ts.desc()),
  ],
);

export type FlowRecord = typeof flows.$inferSelect;
export type NewFlowRecord = typeof flows.$inferInsert;

/**
 * The keeper rebalance log, one row per vault `Rebalanced` event (BE-26, table
 * from `spec/CortexConvergencePlan.md` §2).
 *
 * A plain table, not a hypertable: the vault surface reads a rolling count
 * (`rebalances30d`), not a dense series, so `id` alone is the key.
 *
 * `driftBeforePct` / `driftAfterPct` are the event's bps figures divided by 100.
 * They are statistics, so `double precision` like `signals.zScore`, not the
 * 18-dp `numeric` the money columns use.
 *
 * `gasReimbursedWei` is the native-token amount from the `KeeperReimbursed` log
 * in the same transaction (0 when none was paid). `gasReimbursedUsd` is null:
 * RHC testnet has no native-token price feed, so the reimbursement cannot be
 * valued, and an unknown is null, never 0 (global do-not 2).
 */
export const rebalances = pgTable(
  "rebalances",
  {
    /** Deterministic: `${txHash}:${logIndex}` of the `Rebalanced` log. */
    id: text().notNull(),
    /** `theme_tokens.id`. */
    tokenId: text().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    txHash: text().notNull(),
    /** Keeper address (event `keeper`), lowercased. A permissionless caller. */
    keeper: text().notNull(),
    /** Max constituent drift before the run, percent. */
    driftBeforePct: doublePrecision().notNull(),
    /** Max constituent drift after the run, percent. */
    driftAfterPct: doublePrecision().notNull(),
    /** Native-token gas reimbursed to the keeper, wei. `numeric(78, 0)` covers a
     *  full uint256. 0 when no reimbursement was paid. */
    gasReimbursedWei: numeric({ precision: 78, scale: 0, mode: "bigint" }).notNull(),
    /** USD value of that reimbursement. Null: no native-token feed on testnet. */
    gasReimbursedUsd: usd(),
    blockNumber: bigint({ mode: "number" }).notNull(),
    blockHash: text(),
    logIndex: integer(),
    executionDeploymentId: text().notNull(),
    /** Non-null only when the receipt emitted KeeperReimbursementSkipped. */
    reimbursementSkippedWei: numeric({ precision: 78, scale: 0, mode: "bigint" }),
    reimbursementSkipReason: integer(),
    canonical: boolean().notNull().default(true),
    canonicalReason: text(),
  },
  (table) => [
    primaryKey({ columns: [table.executionDeploymentId, table.id] }),
    index("rebalances_token_ts_idx").on(table.tokenId, table.ts.desc()),
  ],
);

export type RebalanceRecord = typeof rebalances.$inferSelect;
export type NewRebalanceRecord = typeof rebalances.$inferInsert;

// --- Execution registry ----------------------------------------------------
//
// These tables deliberately describe the single verified execution generation
// attached to this database. Research rows remain chain-mainnet data and are
// not copied into this namespace.

export const executionBindings = pgTable(
  "execution_bindings",
  {
    /** A checked singleton: one database is one execution generation. */
    id: integer().primaryKey().default(1),
    deploymentId: text().notNull().unique(),
    mode: text().$type<"local-fork" | "robinhood-testnet" | "robinhood-mainnet">().notNull(),
    chainId: integer().notNull(),
    manifestDigest: text().notNull(),
    /** Local marker generation, or the manifest identity for public networks. */
    generationFingerprint: text().notNull(),
    adoptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // `id = 1` makes a second active binding structurally impossible.
    check("execution_binding_singleton", sql`${table.id} = 1`),
  ],
);

export const executionVenues = pgTable(
  "execution_venues",
  {
    deploymentId: text().notNull(),
    name: text().notNull(),
    seedVersion: integer().notNull(),
    seedDigest: text().notNull(),
    protocolVariant: text().notNull(),
    factory: text().notNull(),
    router: text().notNull(),
    quoter: text(),
    deployBlock: bigint({ mode: "number" }).notNull(),
    deployBlockHash: text().notNull(),
    supportedFees: jsonb().$type<number[]>().notNull(),
    supportedIntermediates: jsonb().$type<string[]>().notNull(),
    verificationStatus: text().$type<"verified" | "rejected">().notNull(),
    verifiedSource: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.name] }),
    index("execution_venues_deployment_idx").on(table.deploymentId),
  ],
);

export const executionPools = pgTable(
  "execution_pools",
  {
    deploymentId: text().notNull(),
    poolAddress: text().notNull(),
    venueName: text().notNull(),
    factory: text().notNull(),
    token0: text().notNull(),
    token1: text().notNull(),
    feePips: integer().notNull(),
    createdBlock: bigint({ mode: "number" }),
    createdBlockHash: text(),
    firstSeenBlock: bigint({ mode: "number" }).notNull(),
    firstSeenBlockHash: text().notNull(),
    provenance: text().notNull(),
    authenticated: boolean().notNull().default(false),
    authenticatedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.poolAddress] }),
    index("execution_pools_deployment_authenticated_idx").on(
      table.deploymentId,
      table.authenticated,
    ),
    index("execution_pools_venue_idx").on(table.deploymentId, table.venueName),
  ],
);

export const executionPoolObservations = pgTable(
  "execution_pool_observations",
  {
    deploymentId: text().notNull(),
    poolAddress: text().notNull(),
    blockNumber: bigint({ mode: "number" }).notNull(),
    blockHash: text().notNull(),
    blockTimestamp: bigint({ mode: "number" }).notNull(),
    status: text()
      .$type<"ok" | "empty" | "uninitialized" | "read_failed" | "unsupported" | "stale">()
      .notNull(),
    reserve0Raw: numeric({ precision: 78, scale: 0, mode: "bigint" }),
    reserve1Raw: numeric({ precision: 78, scale: 0, mode: "bigint" }),
    sqrtPriceX96: numeric({ precision: 78, scale: 0, mode: "bigint" }),
    tick: integer(),
    liquidityRaw: numeric({ precision: 78, scale: 0, mode: "bigint" }),
    tvlUsd: usd(),
    lastSuccessAt: timestamp({ withTimezone: true }),
    lastError: text(),
    observedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.poolAddress] }),
    index("execution_pool_observations_status_idx").on(table.deploymentId, table.status),
  ],
);

export const executionDiscoveryProgress = pgTable(
  "execution_discovery_progress",
  {
    deploymentId: text().notNull(),
    venueName: text().notNull(),
    queryScope: text().notNull(),
    coverageStatus: text()
      .$type<"complete_for_supported_candidates" | "partial" | "unknown">()
      .notNull(),
    reconciliationPosition: text(),
    lastSuccessfulBlock: bigint({ mode: "number" }),
    lastSuccessfulBlockHash: text(),
    lastSuccessfulAt: timestamp({ withTimezone: true }),
    /** Last rejected variant or retryable discovery failure; coverage remains explicit. */
    lastError: text(),
  },
  (table) => [primaryKey({ columns: [table.deploymentId, table.venueName, table.queryScope] })],
);

/**
 * Durable execution index cursors. Factory rows are kept per immutable factory
 * version; the vault row is a separate all-vault scope that scans every
 * factory version in the same block window so a deployment and its first mint
 * can commit together.
 */
export const executionIndexerState = pgTable(
  "execution_indexer_state",
  {
    deploymentId: text().notNull(),
    scope: text().$type<"factory" | "vault">().notNull(),
    factoryAddress: text().notNull(),
    factoryVersion: text().notNull(),
    startBlock: bigint({ mode: "number" }).notNull(),
    /** startBlock - 1 is valid, including -1 for a genesis start. */
    lastBlock: bigint({ mode: "number" }).notNull(),
    lastBlockHash: text(),
    status: text().$type<"healthy" | "degraded">().notNull().default("healthy"),
    degradedReason: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.deploymentId, table.scope, table.factoryAddress, table.factoryVersion],
    }),
    index("execution_indexer_state_deployment_idx").on(table.deploymentId, table.scope),
  ],
);

/** Retained canonical block boundaries used to find a bounded common ancestor. */
export const executionIndexerCheckpoints = pgTable(
  "execution_indexer_checkpoints",
  {
    deploymentId: text().notNull(),
    scope: text().$type<"factory" | "vault">().notNull(),
    factoryAddress: text().notNull(),
    factoryVersion: text().notNull(),
    blockNumber: bigint({ mode: "number" }).notNull(),
    blockHash: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.deploymentId,
        table.scope,
        table.factoryAddress,
        table.factoryVersion,
        table.blockNumber,
      ],
    }),
    index("execution_indexer_checkpoints_lookup_idx").on(
      table.deploymentId,
      table.scope,
      table.blockNumber,
    ),
  ],
);

/**
 * Canonical event ledger. Projections may be Timescale tables, but event
 * identity is not: (deployment, transaction, log index) is the replay key and
 * survives timestamp changes in a projection.
 */
export const executionEvents = pgTable(
  "execution_events",
  {
    deploymentId: text().notNull(),
    transactionHash: text().notNull(),
    logIndex: integer().notNull(),
    blockNumber: bigint({ mode: "number" }).notNull(),
    blockHash: text().notNull(),
    address: text().notNull(),
    eventName: text().notNull(),
    scope: text().$type<"factory" | "vault">().notNull(),
    canonical: boolean().notNull().default(true),
    canonicalReason: text(),
    payload: jsonb().$type<Record<string, unknown>>(),
    observedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.transactionHash, table.logIndex] }),
    index("execution_events_canonical_block_idx").on(
      table.deploymentId,
      table.canonical,
      table.blockNumber,
    ),
  ],
);
