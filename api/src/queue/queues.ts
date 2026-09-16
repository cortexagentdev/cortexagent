import { Queue, type Job, type JobsOptions } from "bullmq";

import { queueConnection } from "./connection.ts";
import { CORTEX_QUEUE, DEFAULT_JOB_OPTIONS, type JobName, type JobPayloads } from "./jobs.ts";
import { env } from "../env.ts";

/**
 * The producer side. Imported by the api, by workers that fan work out, and by
 * `schedules.ts`, which the worker entrypoint runs at start to upsert the
 * repeatable jobs. Producing is the only reason a worker touches this file, and
 * it closes the producer on shutdown for the same reason.
 */
export const cortexQueue = new Queue<JobPayloads[JobName], void, JobName>(CORTEX_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/** Typed `add`. The payload has to match the job name. */
export function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloads[N],
  options?: JobsOptions,
): Promise<Job<JobPayloads[JobName], void, JobName>> {
  return cortexQueue.add(name, payload, options);
}

export async function closeQueues(): Promise<void> {
  await cortexQueue.close();
}

/**
 * Repeatable jobs are intentionally coalesced at the worker boundary. BullMQ
 * scheduler templates do not support deduplication options, and allowing a
 * slow RPC outage to create one waiting job per tick would eventually starve
 * the worker. Keep the newest waiting/delayed instance for each scheduled
 * name; active jobs are never removed.
 */
export async function trimScheduledBacklog(): Promise<number> {
  const jobs = await cortexQueue.getJobs(["waiting", "delayed"], 0, env.WORKER_BACKLOG_CAP * 2);
  const scheduled = jobs
    .filter((job) => job.name !== "ping")
    .sort((left, right) => right.timestamp - left.timestamp);
  const seen = new Set<string>();
  let removed = 0;
  for (const job of scheduled) {
    if (!seen.has(job.name)) {
      seen.add(job.name);
      continue;
    }
    await job.remove();
    removed += 1;
  }
  return removed;
}
