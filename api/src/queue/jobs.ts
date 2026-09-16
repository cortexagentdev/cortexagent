import type { JobsOptions } from "bullmq";

/**
 * One queue, many named jobs.
 *
 * A queue per worker would multiply Redis connections and blocking clients on a
 * box that runs everything (locked decision 12), and buys nothing: BullMQ
 * schedules per job name inside a single queue just as well.
 */
export const CORTEX_QUEUE = "cortex";

/**
 * Every job the system can enqueue, and its payload.
 *
 * Later tasks append entries here and a matching processor in `processors.ts`.
 * The processor map is typed against this, so adding a job without a processor
 * is a typecheck failure rather than a job that sits in the queue forever.
 */
export interface JobPayloads {
  /** Liveness probe. Proves the api can enqueue and the worker can consume. */
  ping: { at: string };
  /** One cycle of the universe eligibility gate (BE-5). Repeatable, every 60s.
   *  Carries no payload: the cycle reads the whole live set every time, so
   *  there is nothing for a producer to narrow it to. */
  "universe-refresh": Record<string, never>;
  /** One price sample per priceable asset, plus the derived display fields
   *  (BE-6). Repeatable, every 60s. Payload-free for the same reason: the
   *  cycle prices the whole table every time. */
  "price-poll": Record<string, never>;
  /** One signal compute cycle across every registered processor (BE-10).
   *  Repeatable, every 15 minutes. Payload-free: the cycle builds one window
   *  from the clock and runs every processor over the whole eligible set. */
  "signal-compute": Record<string, never>;
  /** One forward-only `Transfer` index cycle (BE-15). Repeatable, every 60s.
   *  Payload-free: the cycle resumes from the persisted block cursor and reads
   *  logs up to a few confirmations behind head. */
  "transfer-index": Record<string, never>;
  /** One theme-lens aggregation cycle (BE-19). Repeatable, every 5 minutes.
   *  Payload-free: the cycle recomputes every lens from stored price history,
   *  signals and the FLOW cache. */
  "lens-aggregate": Record<string, never>;
  /** One alert evaluation cycle (BE-24). Repeatable, every 2 minutes.
   *  Payload-free: the cycle re-scans a trailing window of recent signals and
   *  matches them against every active rule, writing one `alert_fires` row per
   *  match with `ON CONFLICT DO NOTHING`. */
  "alert-evaluate": Record<string, never>;
  /** One NAV poll cycle for every deployed theme token (BE-26). Repeatable,
   *  every 60s. Payload-free: the cycle reads navPerShare / navIndicative / AUM
   *  off each testnet vault and writes one `nav_history` row each. */
  "nav-poll": Record<string, never>;
  /** One vault index cycle (BE-26). Repeatable, every 60s. Payload-free: the
   *  cycle resumes from the persisted block cursor, indexes `ThemeDeployed`
   *  into `theme_tokens` and vault mint / redeem / rebalance events into
   *  `flows` and `rebalances`, a few confirmations behind testnet head. */
  "vault-index": Record<string, never>;
  /** Bounded targeted factory reconciliation for the verified execution venue. */
  "execution-discovery": Record<string, never>;
  /** Block-pinned V3 slot0/liquidity observations for authenticated execution pools. */
  "execution-pool-state": Record<string, never>;
}

export type JobName = keyof JobPayloads;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  // Keep a short tail of finished jobs for debugging, and let Redis reclaim the
  // rest. An unbounded completed set is the usual way a BullMQ Redis fills up.
  removeOnComplete: { count: 1_000, age: 60 * 60 },
  removeOnFail: { count: 5_000, age: 24 * 60 * 60 },
};
