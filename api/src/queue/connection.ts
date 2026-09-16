import { Redis } from "ioredis";

import { env } from "../env.ts";

/**
 * The Redis connection BullMQ uses. Separate from the cache client in
 * `src/lib/redis.ts` because BullMQ requires options the cache must not have.
 *
 * `maxRetriesPerRequest: null` is a requirement, not a tuning knob. BullMQ waits
 * for work with a blocking command that has no timeout; with a retry ceiling
 * ioredis eventually aborts that command and the worker stops picking jobs up
 * without ever logging an error.
 */
export const queueConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  // The blocking client is idle by definition, so the readiness probe only adds
  // a round trip on every reconnect.
  enableReadyCheck: false,
});

export async function closeQueueConnection(): Promise<void> {
  await queueConnection.quit();
}
