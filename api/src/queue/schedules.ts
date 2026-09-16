import { ALERT_EVALUATE_INTERVAL_MS } from "../workers/alert-evaluator.ts";
import { LENS_AGGREGATE_INTERVAL_MS } from "../workers/lens-aggregator.ts";
import { NAV_POLL_INTERVAL_MS } from "../workers/nav-poller.ts";
import { PRICE_POLL_INTERVAL_MS } from "../workers/price-poller.ts";
import { SIGNAL_COMPUTE_INTERVAL_MS } from "../workers/signal-computer.ts";
import { TRANSFER_INDEX_INTERVAL_MS } from "../workers/transfer-indexer.ts";
import { VAULT_INDEX_INTERVAL_MS } from "../workers/vault-indexer.ts";
import { UNIVERSE_REFRESH_INTERVAL_MS } from "../workers/universe-refresher.ts";
import { DISCOVERY_INTERVAL_MS, POOL_STATE_INTERVAL_MS } from "../execution/discovery.ts";
import { logger } from "../lib/logger.ts";
import { cortexQueue } from "./queues.ts";
import type { JobName } from "./jobs.ts";

/**
 * The repeatable schedule, declared in code and upserted at worker start.
 *
 * `upsertJobScheduler` is idempotent on the scheduler id, so restarting the
 * worker updates the interval in place rather than leaving a second scheduler
 * behind. Declaring the schedule anywhere but here (a cron container, a manual
 * `add` from a shell) would let the running interval drift away from the one in
 * the repo, which is exactly the kind of state nobody can review.
 */
export async function installSchedules(executionDeploymentId?: string): Promise<void> {
  await cortexQueue.upsertJobScheduler(
    "universe-refresh",
    { every: UNIVERSE_REFRESH_INTERVAL_MS },
    {
      name: "universe-refresh",
      data: {},
      opts: {
        // No retry. The next tick is 60s away and reads the whole live set
        // again, so a retry would only race the schedule into a bad upstream.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  if (executionDeploymentId) {
    const executionScheduler = (name: "execution-discovery" | "execution-pool-state") =>
      `execution:${executionDeploymentId}:${name}` as JobName;
    for (const [name, every] of [
      ["execution-discovery", DISCOVERY_INTERVAL_MS],
      ["execution-pool-state", POOL_STATE_INTERVAL_MS],
    ] as const) {
      await cortexQueue.upsertJobScheduler(
        executionScheduler(name),
        { every },
        {
          name,
          data: {},
          opts: {
            attempts: 3,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: { count: 60 },
            removeOnFail: { count: 100 },
          },
        },
      );
    }
  }

  await cortexQueue.upsertJobScheduler(
    "price-poll",
    { every: PRICE_POLL_INTERVAL_MS },
    {
      name: "price-poll",
      data: {},
      opts: {
        // No retry, for the same reason as the refresh: the next tick is 60s
        // away and prices the whole table again. A retried cycle would also
        // stamp a second sample into a minute that already has one.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  await cortexQueue.upsertJobScheduler(
    "signal-compute",
    { every: SIGNAL_COMPUTE_INTERVAL_MS },
    {
      name: "signal-compute",
      data: {},
      opts: {
        // No retry. The next tick is 15m away and recomputes the same window as
        // an upsert, so a retry would only race the schedule.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  await cortexQueue.upsertJobScheduler(
    "transfer-index",
    { every: TRANSFER_INDEX_INTERVAL_MS },
    {
      name: "transfer-index",
      data: {},
      opts: {
        // No retry. The next tick is 60s away and resumes from the same
        // persisted cursor, so a retry would only race the schedule.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  await cortexQueue.upsertJobScheduler(
    "lens-aggregate",
    { every: LENS_AGGREGATE_INTERVAL_MS },
    {
      name: "lens-aggregate",
      data: {},
      opts: {
        // No retry. The next tick is 5m away and recomputes every lens from the
        // same stored series as an upsert, so a retry would only race the
        // schedule.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  await cortexQueue.upsertJobScheduler(
    "alert-evaluate",
    { every: ALERT_EVALUATE_INTERVAL_MS },
    {
      name: "alert-evaluate",
      data: {},
      opts: {
        // No retry. The next tick is 2m away and re-scans the same trailing
        // window as an `ON CONFLICT DO NOTHING` batch, so a retry would only
        // race the schedule.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  const executionScheduler = (name: "nav-poll" | "vault-index") =>
    // BullMQ types scheduler IDs as job names even though its API accepts an
    // independent string namespace. The runtime value is intentionally scoped.
    (executionDeploymentId ? `execution:${executionDeploymentId}:${name}` : name) as JobName;
  // Prior versions had no deployment namespace. Retire only those two known
  // execution schedulers; research schedules and arbitrary Redis keys remain.
  if (executionDeploymentId) {
    await cortexQueue.removeJobScheduler("nav-poll");
    await cortexQueue.removeJobScheduler("vault-index");

    // A fresh local fork generation has a new execution namespace. Retire
    // schedulers from the replaced generation before the worker can consume
    // their already-enqueued jobs; otherwise the backlog still targets the
    // destroyed vault addresses and BullMQ cannot trim scheduler-owned jobs.
    const activePrefix = `execution:${executionDeploymentId}:`;
    for (const scheduler of await cortexQueue.getJobSchedulers(0, -1, true)) {
      const id = scheduler.id ?? scheduler.key;
      if (id.startsWith("execution:") && !id.startsWith(activePrefix)) {
        await cortexQueue.removeJobScheduler(id);
      }
    }
  }

  await cortexQueue.upsertJobScheduler(
    executionScheduler("nav-poll"),
    { every: NAV_POLL_INTERVAL_MS },
    {
      name: "nav-poll",
      data: {},
      opts: {
        // No retry. The next tick is 60s away and re-reads every vault, and a
        // retried cycle would stamp a second observation into a minute that
        // already has one.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  await cortexQueue.upsertJobScheduler(
    executionScheduler("vault-index"),
    { every: VAULT_INDEX_INTERVAL_MS },
    {
      name: "vault-index",
      data: {},
      opts: {
        // No retry. The next tick is 60s away and resumes from the same
        // persisted cursor, so a retry would only race the schedule.
        attempts: 1,
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 100 },
      },
    },
  );

  logger.info("schedules installed", {
    universeRefreshMs: UNIVERSE_REFRESH_INTERVAL_MS,
    pricePollMs: PRICE_POLL_INTERVAL_MS,
    signalComputeMs: SIGNAL_COMPUTE_INTERVAL_MS,
    transferIndexMs: TRANSFER_INDEX_INTERVAL_MS,
    lensAggregateMs: LENS_AGGREGATE_INTERVAL_MS,
    alertEvaluateMs: ALERT_EVALUATE_INTERVAL_MS,
    navPollMs: NAV_POLL_INTERVAL_MS,
    vaultIndexMs: VAULT_INDEX_INTERVAL_MS,
  });
}
