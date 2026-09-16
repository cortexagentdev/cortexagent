import { Worker } from "bullmq";

import { closeDb } from "./db/client.ts";
import { withRpcScope } from "./chain/rpc-metrics.ts";
import { env } from "./env.ts";
import { logger } from "./lib/logger.ts";
import { closeRedis } from "./lib/redis.ts";
import { installShutdownHandlers } from "./lib/shutdown.ts";
import { closeQueueConnection, queueConnection } from "./queue/connection.ts";
import { CORTEX_QUEUE, type JobName, type JobPayloads } from "./queue/jobs.ts";
import { findProcessor, registeredJobNames } from "./queue/processors.ts";
import { closeQueues, trimScheduledBacklog } from "./queue/queues.ts";
import { installSchedules } from "./queue/schedules.ts";
import { ensureExecutionBinding, seedVerifiedVenues } from "./execution/registry.ts";
import { syncPresetRecords } from "./execution/preset-registry-store.ts";

/**
 * The worker entrypoint.
 *
 * This is a separate process from the HTTP server on purpose: in production they
 * are separate containers off the same image (OPS-2), so a signal computation
 * that pins a core cannot make the terminal stop answering.
 */
const worker = new Worker<JobPayloads[JobName], void, JobName>(
  CORTEX_QUEUE,
  async (job) => {
    const processor = findProcessor(job.name);
    if (!processor) {
      // An unknown name means a producer was deployed ahead of the worker. Fail
      // the job so it retries, rather than acking work that was never done.
      throw new Error(`No processor registered for job "${job.name}"`);
    }

    const startedAt = Date.now();
    const trimmed = await trimScheduledBacklog();
    if (trimmed) logger.warn("coalesced stale scheduled jobs", { trimmed });
    const executionJob =
      job.name.startsWith("execution-") || job.name === "nav-poll" || job.name === "vault-index";
    await withRpcScope(
      {
        operation: `job:${job.name}`,
        context: executionJob ? "execution" : "research",
        priority: job.name.includes("index") ? "recovery" : "background",
        requestId: `job-${job.id ?? "unknown"}`,
      },
      () => processor(job),
    );
    logger.debug("job complete", { name: job.name, jobId: job.id, ms: Date.now() - startedAt });
  },
  {
    connection: queueConnection,
    concurrency: env.WORKER_CONCURRENCY,
  },
);

worker.on("failed", (job, err) => {
  logger.error("job failed", {
    name: job?.name,
    jobId: job?.id,
    attempt: job?.attemptsMade,
    err,
  });
});

// Emitted for queue-level problems (a dropped Redis connection, a bad script),
// not for a job throwing. Unhandled, ioredis would take the process down.
worker.on("error", (err) => {
  logger.error("worker error", { err });
});

logger.info("cortex-worker started", {
  queue: CORTEX_QUEUE,
  concurrency: env.WORKER_CONCURRENCY,
  processors: registeredJobNames,
});

// The repeatable schedule is owned by the worker, which is the process that has
// to run it. This is the one place the worker acts as a producer, and it is why
// the queue producer is closed on shutdown below.
// Research-only installations remain usable without an execution context. A
// configured execution worker must bind and seed before it can schedule work
// that writes execution-owned rows.
let executionDeploymentId: string | undefined;
if (env.EXECUTION_MODE) {
  const execution = await ensureExecutionBinding();
  await seedVerifiedVenues();
  await syncPresetRecords(execution);
  executionDeploymentId = execution.manifest.deploymentId;
}
await installSchedules(executionDeploymentId);

installShutdownHandlers([
  // close() stops the worker taking new jobs and waits for in-flight ones.
  { name: "worker", run: () => worker.close() },
  { name: "queues", run: closeQueues },
  { name: "queue-connection", run: closeQueueConnection },
  { name: "redis", run: closeRedis },
  { name: "db", run: closeDb },
]);
