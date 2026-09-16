import type { Job } from "bullmq";

import { logger } from "../lib/logger.ts";
import { redis } from "../lib/redis.ts";
import { aggregateLenses } from "../workers/lens-aggregator.ts";
import { evaluateAlerts } from "../workers/alert-evaluator.ts";
import { pollNav } from "../workers/nav-poller.ts";
import { computeSignals } from "../workers/signal-computer.ts";
import { indexTransfers } from "../workers/transfer-indexer.ts";
import { indexVault } from "../workers/vault-indexer.ts";
import { pollPrices } from "../workers/price-poller.ts";
import { refreshUniverse } from "../workers/universe-refresher.ts";
import { runDiscoveryCycle } from "../execution/discovery.ts";
import { sampleCurrentExecutionPoolState } from "../execution/pool-state.ts";
import { getExecutionContext } from "../execution/context.ts";
import { executionRedisPrefix } from "../lib/redis.ts";
import type { JobName, JobPayloads } from "./jobs.ts";

export type JobProcessor<N extends JobName> = (job: Job<JobPayloads[N], void, N>) => Promise<void>;

/**
 * The registry the worker dispatches on.
 */
/**
 * A refresh cycle is not reentrant. Worker concurrency is 4, so without a lock
 * a cycle that overruns its 60s schedule would be joined by the next one, and
 * two cycles writing the same rows from two different blocks is how a row ends
 * up half from each. The TTL is long enough to cover a slow cycle and short
 * enough that a killed worker does not wedge the schedule.
 */
const UNIVERSE_LOCK_KEY = "universe:refresh:lock";
const UNIVERSE_LOCK_TTL_SEC = 300;

/** The price poll is not reentrant either, and for a sharper reason: two cycles
 *  in flight would write two samples a few seconds apart into a series whose
 *  whole shape assumes one sample per minute. */
const PRICE_POLL_LOCK_KEY = "price:poll:lock";
const PRICE_POLL_LOCK_TTL_SEC = 300;

/** The signal compute is not reentrant: two cycles on the same window would
 *  race each other's upserts and supersededBy passes. The TTL covers a slow
 *  cycle (every processor over 96 assets) and expires well before the 15m
 *  schedule so a killed worker does not wedge it. */
const SIGNAL_COMPUTE_LOCK_KEY = "signal:compute:lock";
const SIGNAL_COMPUTE_LOCK_TTL_SEC = 600;

/** The transfer index is not reentrant: two cycles resuming from the same
 *  cursor would replay the same block range and add every delta twice, since
 *  the upsert accumulates (`balance + EXCLUDED.balance`). The per-chunk
 *  transaction is crash safety, not concurrency safety, so this lock is what
 *  keeps a single applier. TTL covers a catch-up run of MAX_CHUNKS_PER_RUN
 *  chunks and expires well before the 60s schedule. */
const TRANSFER_INDEX_LOCK_KEY = "transfer:index:lock";
const TRANSFER_INDEX_LOCK_TTL_SEC = 300;

/** The lens aggregation is not reentrant: two cycles on the same floored
 *  instant would race each other's upserts on the same `(theme, ts)` rows. The
 *  cycle is cheap (a handful of lenses over stored series), so the TTL only has
 *  to cover a slow DB and expires well before the 5m schedule. */
const LENS_AGGREGATE_LOCK_KEY = "lens:aggregate:lock";
const LENS_AGGREGATE_LOCK_TTL_SEC = 240;

/** The alert evaluation is not reentrant: two cycles over the same trailing
 *  window would build the same (rule, signal) rows and race each other's
 *  inserts. `ON CONFLICT DO NOTHING` already makes that harmless, so this lock
 *  is only to avoid the wasted duplicate scan. The cycle is cheap (a bounded
 *  trailing window against the active rule set), so the TTL only has to cover a
 *  slow DB and expires well before the 2m schedule. */
const ALERT_EVALUATE_LOCK_KEY = "alert:evaluate:lock";
const ALERT_EVALUATE_LOCK_TTL_SEC = 90;

/** The NAV poll is not reentrant: two cycles a few seconds apart would stamp
 *  two observations into a minute whose series assumes one, the same reason the
 *  price poll holds a lock. The TTL covers a slow multicall and expires well
 *  before the 60s schedule. */
const NAV_POLL_LOCK_KEY = "nav:poll:lock";
const NAV_POLL_LOCK_TTL_SEC = 300;

/** The vault index is not reentrant: two cycles resuming from the same cursor
 *  would replay a block range. `flows` / `rebalances` insert `ON CONFLICT DO
 *  NOTHING` and the cursor bump is transactional, so a replay is harmless, but
 *  this lock avoids the wasted duplicate scan. TTL covers a catch-up run of
 *  MAX_CHUNKS_PER_RUN chunks and expires before the 60s schedule. */
const VAULT_INDEX_LOCK_KEY = "vault:index:lock";
const VAULT_INDEX_LOCK_TTL_SEC = 300;
const EXECUTION_DISCOVERY_LOCK_TTL_SEC = 540;
const EXECUTION_POOL_STATE_LOCK_TTL_SEC = 50;

async function withExecutionLock(job: Job, suffix: string, ttl: number, run: () => Promise<void>) {
  const context = await getExecutionContext();
  if (!context) throw new Error("execution context is not ready");
  const key = `${executionRedisPrefix(context.manifest.deploymentId)}${suffix}:lock`;
  const token = `${process.pid}:${job.id}`;
  const acquired = await redis.set(key, token, "EX", ttl, "NX");
  if (acquired !== "OK") {
    logger.warn("execution job already running, skipping this tick", { jobId: job.id, suffix });
    return;
  }
  try {
    await run();
  } finally {
    if ((await redis.get(key)) === token) await redis.del(key);
  }
}

export const processors: { [N in JobName]: JobProcessor<N> } = {
  ping: async (job) => {
    logger.info("ping", { jobId: job.id, enqueuedAt: job.data.at });
  },

  "universe-refresh": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(UNIVERSE_LOCK_KEY, token, "EX", UNIVERSE_LOCK_TTL_SEC, "NX");
    if (acquired !== "OK") {
      logger.warn("universe refresh already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await refreshUniverse();
    } finally {
      // Release only our own lock. A cycle that overran its TTL has already had
      // the lock handed to someone else, and deleting theirs would be worse
      // than leaving ours to expire.
      const held = await redis.get(UNIVERSE_LOCK_KEY);
      if (held === token) await redis.del(UNIVERSE_LOCK_KEY);
    }
  },

  "price-poll": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(
      PRICE_POLL_LOCK_KEY,
      token,
      "EX",
      PRICE_POLL_LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      logger.warn("price poll already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await pollPrices();
    } finally {
      const held = await redis.get(PRICE_POLL_LOCK_KEY);
      if (held === token) await redis.del(PRICE_POLL_LOCK_KEY);
    }
  },

  "signal-compute": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(
      SIGNAL_COMPUTE_LOCK_KEY,
      token,
      "EX",
      SIGNAL_COMPUTE_LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      logger.warn("signal compute already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await computeSignals();
    } finally {
      const held = await redis.get(SIGNAL_COMPUTE_LOCK_KEY);
      if (held === token) await redis.del(SIGNAL_COMPUTE_LOCK_KEY);
    }
  },

  "transfer-index": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(
      TRANSFER_INDEX_LOCK_KEY,
      token,
      "EX",
      TRANSFER_INDEX_LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      logger.warn("transfer index already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await indexTransfers();
    } finally {
      const held = await redis.get(TRANSFER_INDEX_LOCK_KEY);
      if (held === token) await redis.del(TRANSFER_INDEX_LOCK_KEY);
    }
  },

  "lens-aggregate": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(
      LENS_AGGREGATE_LOCK_KEY,
      token,
      "EX",
      LENS_AGGREGATE_LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      logger.warn("lens aggregate already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await aggregateLenses();
    } finally {
      const held = await redis.get(LENS_AGGREGATE_LOCK_KEY);
      if (held === token) await redis.del(LENS_AGGREGATE_LOCK_KEY);
    }
  },

  "alert-evaluate": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(
      ALERT_EVALUATE_LOCK_KEY,
      token,
      "EX",
      ALERT_EVALUATE_LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      logger.warn("alert evaluate already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await evaluateAlerts();
    } finally {
      const held = await redis.get(ALERT_EVALUATE_LOCK_KEY);
      if (held === token) await redis.del(ALERT_EVALUATE_LOCK_KEY);
    }
  },

  "nav-poll": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(NAV_POLL_LOCK_KEY, token, "EX", NAV_POLL_LOCK_TTL_SEC, "NX");
    if (acquired !== "OK") {
      logger.warn("nav poll already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await pollNav();
    } finally {
      const held = await redis.get(NAV_POLL_LOCK_KEY);
      if (held === token) await redis.del(NAV_POLL_LOCK_KEY);
    }
  },

  "vault-index": async (job) => {
    const token = `${process.pid}:${job.id}`;
    const acquired = await redis.set(
      VAULT_INDEX_LOCK_KEY,
      token,
      "EX",
      VAULT_INDEX_LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      logger.warn("vault index already running, skipping this tick", { jobId: job.id });
      return;
    }

    try {
      await indexVault();
    } finally {
      const held = await redis.get(VAULT_INDEX_LOCK_KEY);
      if (held === token) await redis.del(VAULT_INDEX_LOCK_KEY);
    }
  },

  "execution-discovery": async (job) => {
    await withExecutionLock(job, "discovery", EXECUTION_DISCOVERY_LOCK_TTL_SEC, async () => {
      await runDiscoveryCycle();
    });
  },

  "execution-pool-state": async (job) => {
    await withExecutionLock(job, "pool-state", EXECUTION_POOL_STATE_LOCK_TTL_SEC, async () => {
      await sampleCurrentExecutionPoolState();
    });
  },
};

/** Dispatch by name. Returns undefined for a name this build does not know. */
export function findProcessor(name: string): JobProcessor<JobName> | undefined {
  return (processors as Record<string, JobProcessor<JobName> | undefined>)[name];
}

export const registeredJobNames = Object.keys(processors) as JobName[];
