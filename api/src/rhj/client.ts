import { createHash } from "node:crypto";
import type { z } from "zod";

import { env } from "../env.ts";
import { logger } from "../lib/logger.ts";
import { redis } from "../lib/redis.ts";
import { upstreamErrorWire } from "./types.ts";

/**
 * Shared transport for the free `/rhj` REST API: rate limiter, Redis cache,
 * retry with backoff, and zod validation at the boundary.
 *
 * The endpoint modules (`assets.ts`, `prices.ts`, `corporateActions.ts`,
 * `priceDeviations.ts`) hold the shape and the URL. Everything about how a
 * request is made lives here, so there is one limiter for the whole process and
 * no path can accidentally bypass it.
 */

const log = logger.child({ module: "rhj" });

// --- Errors -----------------------------------------------------------------

export type RhjErrorKind =
  /** DNS, connection reset, TLS. The request never got an answer. */
  | "network"
  /** The request was aborted by our own deadline. */
  | "timeout"
  /** Upstream answered with a non-2xx status. */
  | "http"
  /** Upstream answered 404. Usually an unknown symbol, which is not retryable. */
  | "not_found"
  /** Upstream answered, but the body is not the shape we depend on. */
  | "validation";

/**
 * Every failure out of this module is an `RhjError`.
 *
 * This is requirement 5 of BE-4 and it matters more than it looks: `BE-5` must be
 * able to tell "the registry is unreachable" from "the universe is empty". An
 * unreachable registry makes assets non-eligible, it never makes them
 * assumed-authentic, so a fetch that failed must never come back as `[]`.
 */
export class RhjError extends Error {
  readonly kind: RhjErrorKind;
  readonly endpoint: string;
  readonly status: number | null;
  readonly attempts: number;

  constructor(
    kind: RhjErrorKind,
    endpoint: string,
    message: string,
    options: { status?: number | null; attempts?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RhjError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = options.status ?? null;
    this.attempts = options.attempts ?? 1;
  }
}

export function isRhjError(value: unknown): value is RhjError {
  return value instanceof RhjError;
}

// --- Tuning -----------------------------------------------------------------

/**
 * Documented upstream limit is 60 rps. We run at a third of it. A 96-symbol
 * sweep at 20 rps takes about 5s, which is nothing against a 60s poll interval,
 * and it leaves headroom for the worker and the api to sweep at the same time
 * without either of them noticing the other.
 */
export const RHJ_MAX_RPS = 20;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4_000;
/** Redis is an optimization; a stalled command must not stall the request. */
const CACHE_IO_TIMEOUT_MS = 250;
/** Bound bookkeeping under distinct-key pressure; no completed-promise cache. */
const MAX_PENDING_REQUESTS = 128;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_ATTEMPTS = 10;
const MAX_CACHE_TTL_SEC = 86_400;

/** The documented upstream cache window for `/prices`. */
export const RHJ_PRICE_CACHE_TTL_SEC = 15;

// --- Rate limiter -----------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process-wide pacer. Hands out one slot every `1000 / RHJ_MAX_RPS` ms, so no
 * window of any length ever exceeds the cap.
 *
 * Deliberately not a token bucket. A bucket that starts full lets the first N
 * requests leave at once, and a 96-symbol sweep then averages above the cap even
 * though the bucket is behaving exactly as designed. Strict pacing costs one
 * bucket-sized burst of latency at the start of a sweep and buys an assertion
 * that actually holds: requests / elapsed is never above the limit.
 *
 * Cache hits do not draw a slot. Only calls that reach the network do, which is
 * what the 60 rps upstream limit counts.
 */
class RateLimiter {
  private nextSlotAt = 0;
  /** Serializes waiters so a 96-way sweep drains in order instead of thundering. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  async acquire(): Promise<void> {
    const wait = this.queue.then(() => this.take());
    // Swallow here only: the caller still awaits `wait` and sees any rejection.
    this.queue = wait.catch(() => undefined);
    return wait;
  }

  private async take(): Promise<void> {
    const now = Date.now();
    // An idle period earns no credit. That is the point: unused budget must not
    // pile up into a burst that lands on upstream all at once.
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await sleep(slot - now);
  }
}

const limiter = new RateLimiter(1000 / RHJ_MAX_RPS);

// --- Metrics ----------------------------------------------------------------

export interface RhjMetrics {
  /** Requests that went to the network. Cache hits are not counted. */
  requests: number;
  /**
   * Logical Redis lookups made by the leader of a pending request. Coalesced
   * waiters do not add another hit/miss or physical request.
   */
  cacheHits: number;
  cacheMisses: number;
  /** Physical retry attempts after the first network attempt. */
  retries: number;
  failures: number;
}

const metrics: RhjMetrics = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  retries: 0,
  failures: 0,
};

export function getRhjMetrics(): Readonly<RhjMetrics> {
  return { ...metrics };
}

export function resetRhjMetrics(): void {
  metrics.requests = 0;
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.retries = 0;
  metrics.failures = 0;
}

// --- Cache ------------------------------------------------------------------

/**
 * The cache stores the raw response body, not the parsed object. A cached body
 * is validated on the way out exactly like a fresh one, so a schema change can
 * never be bypassed by a warm cache.
 *
 * Redis being down degrades to "no cache". It must not degrade to "no data":
 * the request still goes to the network and still raises on failure.
 */
interface CacheEnvelope {
  version: 1;
  /** Opaque digest of the fully resolved URL; keys alone are not provenance. */
  urlDigest: string;
  body: string;
  /** The caller's cache policy, preserved as part of cache provenance. */
  ttlSec: number;
  /** Absolute freshness deadline captured before the Redis write begins. */
  observedAt: number;
  expiresAt: number;
}

/**
 * ioredis is configured with its offline queue enabled. Race cache commands
 * against a short local deadline so an unavailable cache never delays the
 * network path. Promise.race observes a late rejection, while the operation
 * itself is intentionally not allowed to extend the response deadline.
 */
async function boundedCacheOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const command = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      command,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RHJ cache operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isCacheEnvelope(value: unknown): value is CacheEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<CacheEnvelope>;
  return (
    envelope.version === 1 &&
    typeof envelope.urlDigest === "string" &&
    typeof envelope.body === "string" &&
    typeof envelope.ttlSec === "number" &&
    Number.isFinite(envelope.ttlSec) &&
    envelope.ttlSec > 0 &&
    Number.isSafeInteger(envelope.ttlSec) &&
    envelope.ttlSec <= MAX_CACHE_TTL_SEC &&
    typeof envelope.observedAt === "number" &&
    Number.isFinite(envelope.observedAt) &&
    typeof envelope.expiresAt === "number" &&
    Number.isFinite(envelope.expiresAt) &&
    envelope.expiresAt === envelope.observedAt + envelope.ttlSec * 1_000
  );
}

function urlDigest(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function parseJson(body: string): { valid: true; value: unknown } | { valid: false } {
  try {
    return { valid: true, value: JSON.parse(body) };
  } catch {
    return { valid: false };
  }
}

async function readCache(
  key: string,
  url: string,
  ttlSec: number,
  timeoutMs: number,
): Promise<string | null> {
  let encoded: string | null;
  try {
    encoded = await boundedCacheOperation(() => redis.get(key), timeoutMs);
  } catch (err) {
    log.warn("rhj cache read failed, falling through to the network");
    return null;
  }
  if (encoded === null) return null;
  const parsed = parseJson(encoded);
  if (!parsed.valid || !isCacheEnvelope(parsed.value)) return null;
  if (
    parsed.value.urlDigest !== urlDigest(url) ||
    parsed.value.ttlSec !== ttlSec ||
    parsed.value.expiresAt <= Date.now()
  )
    return null;
  return parsed.value.body;
}

async function writeCache(
  key: string,
  url: string,
  body: string,
  ttlSec: number,
  timeoutMs: number,
): Promise<void> {
  // Capture this before the Redis command. A delayed/offline SET must not
  // renew freshness from the time Redis eventually executes it.
  const observedAt = Date.now();
  const expiresAt = observedAt + ttlSec * 1_000;
  const encoded = JSON.stringify({
    version: 1,
    urlDigest: urlDigest(url),
    body,
    ttlSec,
    observedAt,
    expiresAt,
  } satisfies CacheEnvelope);
  try {
    await boundedCacheOperation(
      () => redis.set(key, encoded, "EX", Math.max(1, Math.ceil(ttlSec))),
      timeoutMs,
    );
  } catch (err) {
    log.warn("rhj cache write failed");
  }
}

// --- Fetch ------------------------------------------------------------------

export interface FetchJsonOptions<T extends z.ZodType> {
  /** Path under the `/rhj` base, e.g. `/prices/CRM`. */
  path: string;
  /** Stable label for logs, metrics and errors, e.g. `prices`. */
  endpoint: string;
  schema: T;
  cache?: { key: string; ttlSec: number };
  timeoutMs?: number;
  maxAttempts?: number;
  /** Overrides `RHJ_BASE_URL`. Exists so the dev script can point a call at a
   *  local server that returns 500 on demand. Endpoint modules never set it. */
  baseUrl?: string;
}

function backoffMs(attempt: number): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  // Full jitter. Sweeps fail in lockstep otherwise and retry in lockstep too.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function isRetryable(error: RhjError): boolean {
  if (error.kind === "network" || error.kind === "timeout") return true;
  if (error.kind !== "http") return false;
  // 429 is upstream telling us to slow down. 5xx is upstream being upstream.
  return error.status === 429 || (error.status !== null && error.status >= 500);
}

function describeUpstreamError(status: number, body: string): string {
  const parsed = upstreamErrorWire.safeParse(safeJsonParse(body));
  const message = parsed.success ? parsed.data.message : undefined;
  return message ? `${status}: ${message}` : `${status}`;
}

function safeJsonParse(body: string): unknown {
  const parsed = parseJson(body);
  return parsed.valid ? parsed.value : null;
}

/** One network attempt. Returns the body text or throws a typed error. */
async function attemptFetch(
  url: string,
  endpoint: string,
  timeoutMs: number,
  attempt: number,
): Promise<string> {
  await limiter.acquire();
  metrics.requests += 1;

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Keep body consumption inside the same deadline/error boundary as the
    // headers. A provider can answer 200 and then stall its response stream.
    const body = await response.text();
    if (!response.ok) {
      const kind = response.status === 404 ? "not_found" : "http";
      throw new RhjError(
        kind,
        endpoint,
        `${endpoint} responded ${describeUpstreamError(response.status, body)}`,
        {
          status: response.status,
          attempts: attempt,
        },
      );
    }
    return body;
  } catch (err) {
    if (isRhjError(err)) throw err;
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new RhjError(
      timedOut ? "timeout" : "network",
      endpoint,
      timedOut ? `${endpoint} timed out after ${timeoutMs}ms` : `${endpoint} request failed`,
      { attempts: attempt, cause: err },
    );
  }
}

interface RawFetchResult {
  body: string;
  servedFromCache: boolean;
}

interface RequestSnapshot<T extends z.ZodType> {
  endpoint: string;
  schema: T;
  cache?: { key: string; ttlSec: number };
  url: string;
  timeoutMs: number;
  maxAttempts: number;
}

interface PendingRequest {
  key: string;
  evicted: boolean;
  promise: Promise<RawFetchResult>;
}

const schemaIds = new WeakMap<object, number>();
let nextSchemaId = 1;

function schemaId(schema: z.ZodType): number {
  const object = schema as object;
  const existing = schemaIds.get(object);
  if (existing !== undefined) return existing;
  const id = nextSchemaId;
  nextSchemaId += 1;
  schemaIds.set(object, id);
  return id;
}

function parseBody<T extends z.ZodType>(
  body: string,
  endpoint: string,
  schema: T,
  attempts = 1,
): z.infer<T> {
  const decoded = parseJson(body);
  if (!decoded.valid) {
    throw new RhjError("validation", endpoint, `${endpoint} returned malformed JSON.`, {
      attempts,
    });
  }
  const parsed = schema.safeParse(decoded.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RhjError(
      "validation",
      endpoint,
      `${endpoint} returned an unexpected shape. ${issues}`,
      { attempts, cause: parsed.error },
    );
  }
  return parsed.data;
}

function effectiveCacheTimeout(timeoutMs: number): number {
  return Math.max(1, Math.min(CACHE_IO_TIMEOUT_MS, timeoutMs));
}

function effectiveRequestTimeout(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_REQUEST_TIMEOUT_MS
    ? value
    : DEFAULT_TIMEOUT_MS;
}

function effectiveMaxAttempts(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_REQUEST_ATTEMPTS
    ? value
    : DEFAULT_MAX_ATTEMPTS;
}

function effectiveCache(
  cache: FetchJsonOptions<z.ZodType>["cache"],
): { key: string; ttlSec: number } | undefined {
  if (!cache) return undefined;
  if (!Number.isSafeInteger(cache.ttlSec) || cache.ttlSec < 1 || cache.ttlSec > MAX_CACHE_TTL_SEC)
    return undefined;
  return { key: cache.key, ttlSec: cache.ttlSec };
}

async function runRawFetch<T extends z.ZodType>(
  request: RequestSnapshot<T>,
  stillCurrent: () => boolean,
): Promise<RawFetchResult> {
  const { endpoint, schema, cache, url, timeoutMs, maxAttempts } = request;
  let body: string | null = null;
  let servedFromCache = false;
  let successfulAttempt = 0;

  if (cache) {
    body = await readCache(cache.key, url, cache.ttlSec, effectiveCacheTimeout(timeoutMs));
    if (body !== null) {
      servedFromCache = true;
      metrics.cacheHits += 1;
      // A body can be structurally stale or invalid even when its Redis
      // provenance is correct. Do not keep a poisoned cache entry from a
      // corrected upstream response.
      try {
        parseBody(body, endpoint, schema);
      } catch {
        body = null;
        servedFromCache = false;
        metrics.cacheMisses += 1;
      }
    } else {
      metrics.cacheMisses += 1;
    }
  }

  if (body === null) {
    let lastError: RhjError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        body = await attemptFetch(url, endpoint, timeoutMs, attempt);
        successfulAttempt = attempt;
        break;
      } catch (err) {
        const error = isRhjError(err)
          ? err
          : new RhjError("network", endpoint, `${endpoint} request failed`, {
              attempts: attempt,
              cause: err,
            });
        lastError = error;

        if (!isRetryable(error) || attempt === maxAttempts) break;

        const delay = backoffMs(attempt);
        metrics.retries += 1;
        log.warn("rhj request failed, retrying", {
          endpoint,
          attempt,
          maxAttempts,
          delayMs: delay,
          status: error.status,
          kind: error.kind,
        });
        await sleep(delay);
      }
    }

    if (body === null) {
      const error = lastError ?? new RhjError("network", endpoint, `${endpoint} request failed`);
      metrics.failures += 1;
      log.error("rhj request failed", {
        endpoint,
        kind: error.kind,
        status: error.status,
        attempts: error.attempts,
      });
      throw new RhjError(error.kind, endpoint, error.message, {
        status: error.status,
        attempts: error.attempts,
        cause: error.cause ?? error,
      });
    }

    try {
      parseBody(body, endpoint, schema, successfulAttempt);
    } catch (error) {
      metrics.failures += 1;
      log.error("rhj response failed validation", {
        endpoint,
        servedFromCache: false,
        kind: "validation",
      });
      throw error;
    }

    if (cache && stillCurrent()) {
      await writeCache(cache.key, url, body, cache.ttlSec, effectiveCacheTimeout(timeoutMs));
    }
  }

  return { body, servedFromCache };
}

const pendingRequests = new Map<string, PendingRequest>();

async function coalescedRawFetch<T extends z.ZodType>(
  request: RequestSnapshot<T>,
  key: string,
): Promise<RawFetchResult> {
  const existing = pendingRequests.get(key);
  if (existing) return existing.promise;

  if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
    const oldest = pendingRequests.entries().next().value as [string, PendingRequest] | undefined;
    if (oldest) {
      const [oldestKey, oldestEntry] = oldest;
      oldestEntry.evicted = true;
      pendingRequests.delete(oldestKey);
    }
  }

  const entry: PendingRequest = {
    key,
    evicted: false,
    promise: Promise.resolve({ body: "", servedFromCache: false }),
  };
  pendingRequests.set(key, entry);
  entry.promise = Promise.resolve()
    .then(() => runRawFetch(request, () => pendingRequests.get(key) === entry))
    .finally(() => {
      // An evicted/late request must not remove a newer entry for this key.
      if (pendingRequests.get(key) === entry) pendingRequests.delete(key);
    });
  return entry.promise;
}

/**
 * Fetch, cache, retry and validate. Returns parsed data or throws `RhjError`.
 * There is no third outcome, and in particular no empty-result-on-failure.
 */
export async function fetchJson<T extends z.ZodType>(
  options: FetchJsonOptions<T>,
): Promise<z.infer<T>> {
  const { path, endpoint, schema } = options;
  // Resolve and copy every input before the work can enter the pending map.
  // Callers are free to reuse/mutate their options object after this function
  // returns; deferred leaders must not observe a later policy or URL.
  const timeoutMs = effectiveRequestTimeout(options.timeoutMs);
  const maxAttempts = effectiveMaxAttempts(options.maxAttempts);
  const url = `${(options.baseUrl ?? env.RHJ_BASE_URL).replace(/\/+$/, "")}${path}`;
  const cache = effectiveCache(options.cache);
  const request: RequestSnapshot<T> = {
    endpoint,
    schema,
    cache,
    url,
    timeoutMs,
    maxAttempts,
  };
  const key = JSON.stringify({
    url,
    endpoint,
    schema: schemaId(schema),
    cache: cache ?? null,
    timeoutMs,
    maxAttempts,
  });
  const result = await coalescedRawFetch(request, key);
  try {
    // Parse independently for every caller. This preserves schema transforms
    // and ensures mutable/nested results (including Date instances) are never
    // shared through the pending registry or Redis.
    return parseBody(result.body, endpoint, schema);
  } catch (error) {
    metrics.failures += 1;
    log.error("rhj response failed validation", {
      endpoint,
      servedFromCache: result.servedFromCache,
      kind: "validation",
    });
    throw error;
  }
}

// --- Sweeps -----------------------------------------------------------------

/**
 * Runs `worker` over `items` with a bounded number in flight. The limiter, not
 * this number, is what keeps us under the rps ceiling; concurrency only decides
 * how much of the budget is spent waiting on latency rather than idling.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  concurrency: number,
  worker: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
