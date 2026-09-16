import { logger } from "./logger.ts";
import { redis, type RedisClient } from "./redis.ts";

/**
 * A token bucket held in Redis so every api container shares one budget.
 *
 * Read-modify-write of a bucket is three round trips, and two requests
 * interleaving between them both see tokens available. The whole thing runs as
 * one Lua script instead, which Redis executes atomically.
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = nowMs
end

local elapsedSec = math.max(0, nowMs - ts) / 1000
tokens = math.min(capacity, tokens + elapsedSec * refillPerSec)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', nowMs)
-- Expire once a full refill has elapsed: at that point a fresh bucket and the
-- stored one are identical, so keeping it only costs memory.
redis.call('PEXPIRE', key, math.ceil(capacity / refillPerSec * 1000) + 1000)

return allowed
`;

export interface RateLimitOptions {
  /** Burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerSec: number;
  /** Key prefix, so separate limits cannot collide. */
  prefix: string;
}

export function createRateLimiter(options: RateLimitOptions, client: RedisClient = redis) {
  const { capacity, refillPerSec, prefix } = options;

  return async function take(identifier: string): Promise<boolean> {
    try {
      const allowed = await client.eval(
        BUCKET_SCRIPT,
        1,
        `${prefix}:${identifier}`,
        String(capacity),
        String(refillPerSec),
        String(Date.now()),
      );
      return allowed === 1;
    } catch (err) {
      // Fail open. A Redis blip should slow nothing down; refusing every request
      // would turn a cache outage into a full outage.
      logger.error("rate limiter unavailable, allowing request", { err });
      return true;
    }
  };
}
