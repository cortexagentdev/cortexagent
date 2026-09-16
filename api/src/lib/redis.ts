import { Redis } from "ioredis";

import { env } from "../env.ts";

/**
 * The cache connection: rate-limit buckets, memoised reads, anything short-lived.
 *
 * BullMQ does not use this client. Its queues need `maxRetriesPerRequest: null`,
 * which is wrong for cache reads (they should fail fast, not hang), so the queue
 * keeps its own connection in `src/queue/connection.ts`.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: true,
});

export type RedisClient = typeof redis;

/** Namespace keys that belong to one verified execution generation. */
export function executionRedisPrefix(deploymentId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(deploymentId)) {
    throw new Error("execution deployment ID is unsafe for a Redis key prefix");
  }
  return `execution:${deploymentId}:`;
}

export async function closeRedis(): Promise<void> {
  // Lazy connect means the client may never have opened a socket, and quit()
  // rejects in that state.
  if (redis.status === "end" || redis.status === "wait") {
    redis.disconnect();
    return;
  }
  await redis.quit();
}
