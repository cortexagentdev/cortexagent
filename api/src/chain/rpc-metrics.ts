import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { env } from "../env.ts";
import { logger } from "../lib/logger.ts";
import { redis } from "../lib/redis.ts";

/** The current provider method-cost table used only for labeled estimates. */
export const RPC_UNIT_TABLE_VERSION = "alchemy-evm-2026-09-11";
export const RPC_UNIT_ESTIMATES: Record<string, number> = {
  eth_chainId: 0,
  eth_blockNumber: 10,
  eth_call: 26,
  eth_estimateGas: 20,
  eth_feeHistory: 10,
  eth_gasPrice: 20,
  eth_getBalance: 20,
  eth_getBlockByHash: 20,
  eth_getBlockByNumber: 20,
  eth_getCode: 20,
  eth_getLogs: 60,
  eth_getStorageAt: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionReceipt: 20,
  web3_clientVersion: 20,
};

export type RpcContext = "research" | "execution" | "unknown";
export type RpcPriority = "interactive" | "background" | "recovery";

export interface RpcScopeOptions {
  operation: string;
  context?: RpcContext;
  priority?: RpcPriority;
  requestId?: string;
}

export interface RpcScopeDetails {
  requestId: string;
  operation: string;
  context: RpcContext;
  priority: RpcPriority;
  providerHosts: string[];
  httpRequests: number;
  methods: Record<string, number>;
  retries: number;
  http429: number;
  failures: number;
  estimatedUnits: number;
  durationMs: number;
}

interface MethodMetric {
  calls: number;
  retries: number;
  http429: number;
  failures: number;
  latenciesMs: number[];
}

interface HostMetric {
  requests: number;
  retries: number;
  http429: number;
  failures: number;
  latenciesMs: number[];
}

interface ScopeState {
  requestId: string;
  operation: string;
  context: RpcContext;
  priority: RpcPriority;
  startedAt: number;
  providerHosts: Set<string>;
  httpRequests: number;
  methods: Map<string, number>;
  retries: number;
  http429: number;
  failures: number;
  estimatedUnits: number;
  previousFailures: Map<string, boolean>;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

const log = logger.child({ module: "rpc-boundary" });
const startedAt = new Date();
const storage = new AsyncLocalStorage<ScopeState>();
const methodMetrics = new Map<string, MethodMetric>();
const hostMetrics = new Map<string, HostMetric>();
const endpointMetrics = new Map<
  string,
  { host: string; requests: number; http429: number; failures: number; estimatedUnits: number }
>();
const contextMetrics = new Map<
  RpcContext,
  { requests: number; methods: number; estimatedUnits: number }
>();
const operationMetrics = new Map<
  string,
  { count: number; requests: number; failures: number; http429: number; latenciesMs: number[] }
>();
const outcomes = new Map<string, number>();
const circuits = new Map<string, CircuitState>();
let totalHttpRequests = 0;
let totalMethods = 0;
let totalRetries = 0;
let totalHttp429 = 0;
let totalFailures = 0;
let totalEstimatedUnits = 0;
let sequence = 0;
let lastPersistAt = 0;

const recentSamples = (values: number[], value: number, max = 4096) => {
  values.push(Math.round(value * 100) / 100);
  if (values.length > max) values.splice(0, values.length - max);
};

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
}

function methodMetric(method: string): MethodMetric {
  let metric = methodMetrics.get(method);
  if (!metric) {
    metric = { calls: 0, retries: 0, http429: 0, failures: 0, latenciesMs: [] };
    methodMetrics.set(method, metric);
  }
  return metric;
}

function hostMetric(host: string): HostMetric {
  let metric = hostMetrics.get(host);
  if (!metric) {
    metric = { requests: 0, retries: 0, http429: 0, failures: 0, latenciesMs: [] };
    hostMetrics.set(host, metric);
  }
  return metric;
}

function contextMetric(context: RpcContext) {
  let metric = contextMetrics.get(context);
  if (!metric) {
    metric = { requests: 0, methods: 0, estimatedUnits: 0 };
    contextMetrics.set(context, metric);
  }
  return metric;
}

function configuredHosts(values: readonly (string | undefined)[]): Set<string> {
  return new Set(
    values.flatMap((url) => {
      if (!url) return [];
      try {
        return [new URL(url).host];
      } catch {
        return [];
      }
    }),
  );
}

const researchHosts = configuredHosts([
  env.RHC_RPC_URL,
  ...(env.RHC_RPC_URLS ?? []),
  ...(env.RHC_LOGS_RPC_URLS ?? []),
]);
const executionHosts = configuredHosts([
  ...(env.EXECUTION_RPC_URLS ?? []),
  ...(env.EXECUTION_LOGS_RPC_URLS ?? []),
  env.EXECUTION_WALLET_RPC_URL,
]);

type RpcRateKind = "general" | "logs";

/**
 * A strict pacer, rather than a bursty token bucket. Free RPC quotas are
 * shared with other callers and a full bucket would turn an idle period into
 * the exact burst that provokes a 429. Each configured host gets its own
 * queue, so adding a provider actually spreads demand instead of moving one
 * global queue between providers.
 */
class StrictRpcPacer {
  private nextSlotAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  async acquire(): Promise<void> {
    const wait = this.queue.then(() => this.take());
    this.queue = wait.catch(() => undefined);
    return wait;
  }

  private async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

interface ConfiguredRpcRate {
  rps: number;
  pacer: StrictRpcPacer;
}

function endpointUrls(urls: readonly string[] | undefined): readonly string[] {
  return urls && urls.length > 0 ? urls : [env.RHC_RPC_URL];
}

function configuredRateMap(
  urls: readonly string[],
  overrides: readonly number[] | undefined,
  defaultRps: number,
): Map<string, ConfiguredRpcRate> {
  const rates = new Map<string, ConfiguredRpcRate>();
  urls.forEach((url, index) => {
    const host = rpcHost(url);
    const rps = Math.min(overrides?.[index] ?? defaultRps, rates.get(host)?.rps ?? Infinity);
    rates.set(host, { rps, pacer: new StrictRpcPacer(1_000 / rps) });
  });
  return rates;
}

const researchGeneralRates = configuredRateMap(
  endpointUrls(env.RHC_RPC_URLS),
  env.RHC_RPC_RATE_LIMITS_RPS,
  env.RPC_DEFAULT_RPS,
);
const researchLogRates = configuredRateMap(
  endpointUrls(env.RHC_LOGS_RPC_URLS),
  env.RHC_LOGS_RPC_RATE_LIMITS_RPS,
  env.RPC_LOGS_DEFAULT_RPS,
);

function urlFor(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Host only; keyed URL paths and calldata never enter metrics or logs. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function configuredRate(host: string, kind: RpcRateKind): ConfiguredRpcRate | undefined {
  const preferred = kind === "logs" ? researchLogRates : researchGeneralRates;
  const fallback = kind === "logs" ? researchGeneralRates : researchLogRates;
  return preferred.get(host) ?? fallback.get(host);
}

function requestRateKind(requests: readonly { method: string }[]): RpcRateKind {
  return requests.some(({ method }) => method === "eth_getLogs") ? "logs" : "general";
}

export function inferRpcContext(host: string): RpcContext {
  if (executionHosts.has(host)) return "execution";
  if (researchHosts.has(host)) return "research";
  return "unknown";
}

function currentScope(host: string): ScopeState {
  return (
    storage.getStore() ?? {
      requestId: `unscoped-${++sequence}`,
      operation: "unscoped",
      context: inferRpcContext(host),
      priority: "background",
      startedAt: performance.now(),
      providerHosts: new Set(),
      httpRequests: 0,
      methods: new Map(),
      retries: 0,
      http429: 0,
      failures: 0,
      estimatedUnits: 0,
      previousFailures: new Map(),
    }
  );
}

function parseRpcRequests(body: unknown): Array<{ method: string; id: string }> {
  if (typeof body !== "string" || !body.length) return [{ method: "unknown", id: "" }];
  try {
    const parsed: unknown = JSON.parse(body);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.map((entry) => {
      const value = entry as { method?: unknown; id?: unknown };
      return {
        method: typeof value.method === "string" ? value.method : "unknown",
        id: typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : "",
      };
    });
  } catch {
    return [{ method: "unknown", id: "" }];
  }
}

async function requestBody(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

class RpcCircuitOpenError extends Error {
  constructor(public readonly host: string) {
    super(`RPC circuit open for ${host}`);
    this.name = "RpcCircuitOpenError";
  }
}

function checkCircuit(endpointId: string, host: string): void {
  const state = circuits.get(endpointId);
  if (!state || state.openUntil <= Date.now()) return;
  throw new RpcCircuitOpenError(host);
}

function updateCircuit(endpointId: string, failed: boolean): void {
  const state = circuits.get(endpointId) ?? { failures: 0, openUntil: 0 };
  if (!failed) {
    state.failures = 0;
    state.openUntil = 0;
    circuits.set(endpointId, state);
    return;
  }
  state.failures += 1;
  if (state.failures >= env.RPC_CIRCUIT_FAILURE_THRESHOLD)
    state.openUntil = Date.now() + env.RPC_CIRCUIT_OPEN_MS;
  circuits.set(endpointId, state);
}

interface PermitWaiter {
  priority: RpcPriority;
  resolve: (release: () => void) => void;
}

class RpcPermitPool {
  private active = 0;
  private readonly waiting: PermitWaiter[] = [];

  async acquire(priority: RpcPriority): Promise<() => void> {
    const backgroundLimit = Math.max(1, env.RPC_CONCURRENCY_CAP - env.RPC_INTERACTIVE_RESERVED);
    if (
      this.active < env.RPC_CONCURRENCY_CAP &&
      (priority !== "background" || this.active < backgroundLimit)
    ) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiting.push({ priority, resolve });
      this.drain();
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain() {
    while (this.active < env.RPC_CONCURRENCY_CAP && this.waiting.length) {
      const interactive = this.waiting.findIndex((item) => item.priority === "interactive");
      const recovery = this.waiting.findIndex((item) => item.priority === "recovery");
      const index = interactive >= 0 ? interactive : recovery >= 0 ? recovery : 0;
      const [next] = this.waiting.splice(index, 1);
      if (!next) return;
      const backgroundLimit = Math.max(1, env.RPC_CONCURRENCY_CAP - env.RPC_INTERACTIVE_RESERVED);
      if (next.priority === "background" && this.active >= backgroundLimit) {
        this.waiting.unshift(next);
        return;
      }
      this.active += 1;
      next.resolve(() => this.release());
    }
  }
}

const permits = new RpcPermitPool();

function recordRequest(
  host: string,
  endpointId: string,
  requests: Array<{ method: string; id: string }>,
  latencyMs: number,
  status: number | null,
  failed: boolean,
  scope: ScopeState,
) {
  scope.providerHosts.add(host);
  const retryKeys = requests.map(({ method, id }) => `${host}|${method}|${id}`);
  const retry = retryKeys.some(
    (key) => key !== `${host}|unknown|` && scope.previousFailures.get(key) === true,
  );
  for (const key of retryKeys) scope.previousFailures.set(key, failed);
  const retryCount = retry ? 1 : 0;
  const tooMany = status === 429;
  const endpointStat = endpointMetrics.get(endpointId) ?? {
    host,
    requests: 0,
    http429: 0,
    failures: 0,
    estimatedUnits: 0,
  };
  endpointStat.requests += 1;
  endpointStat.http429 += tooMany ? 1 : 0;
  endpointStat.failures += failed ? 1 : 0;
  endpointMetrics.set(endpointId, endpointStat);

  totalHttpRequests += 1;
  totalMethods += requests.length;
  totalRetries += retryCount;
  totalHttp429 += tooMany ? 1 : 0;
  totalFailures += failed ? 1 : 0;
  const hostStat = hostMetric(host);
  hostStat.requests += 1;
  hostStat.retries += retryCount;
  hostStat.http429 += tooMany ? 1 : 0;
  hostStat.failures += failed ? 1 : 0;
  recentSamples(hostStat.latenciesMs, latencyMs);
  const contextStat = contextMetric(scope.context);
  contextStat.requests += 1;
  contextStat.methods += requests.length;

  scope.httpRequests += 1;
  scope.retries += retryCount;
  scope.http429 += tooMany ? 1 : 0;
  scope.failures += failed ? 1 : 0;
  for (const { method } of requests) {
    const methodStat = methodMetric(method);
    methodStat.calls += 1;
    methodStat.retries += retryCount;
    methodStat.http429 += tooMany ? 1 : 0;
    methodStat.failures += failed ? 1 : 0;
    recentSamples(methodStat.latenciesMs, latencyMs);
    scope.methods.set(method, (scope.methods.get(method) ?? 0) + 1);
    const units = RPC_UNIT_ESTIMATES[method] ?? 0;
    scope.estimatedUnits += units;
    contextStat.estimatedUnits += units;
    totalEstimatedUnits += units;
    endpointStat.estimatedUnits += units;
  }
  if (tooMany || failed) updateCircuit(endpointId, true);
  else updateCircuit(endpointId, false);
}

const realFetch = globalThis.fetch.bind(globalThis);

/**
 * Install once at module load. It observes the transport's actual HTTP
 * boundary rather than a worker's guessed batch count. A JSON-RPC batch is one
 * HTTP request but contributes one method count per item.
 */
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const url = urlFor(input);
  const host = rpcHost(url);
  if (!researchHosts.has(host) && !executionHosts.has(host)) return realFetch(input, init);
  // A bad/exhausted key must not open the circuit for another key at the same
  // provider. Hash the full endpoint; credentials never enter metrics/logs.
  const endpointId = createHash("sha256").update(url).digest("hex");
  const scope = currentScope(host);
  const body = await requestBody(input, init);
  const requests = parseRpcRequests(body);
  const started = performance.now();
  const release = await permits.acquire(scope.priority);
  try {
    checkCircuit(endpointId, host);
    const rate = researchHosts.has(host)
      ? configuredRate(host, requestRateKind(requests))
      : undefined;
    if (rate) await rate.pacer.acquire();
    // A different in-flight request may have opened the circuit while this
    // request was waiting for its provider-specific slot.
    checkCircuit(endpointId, host);
    const response = await realFetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(env.RPC_TIMEOUT_MS),
    });
    const failed = response.status >= 500 || response.status === 408 || response.status === 429;
    recordRequest(
      host,
      endpointId,
      requests,
      performance.now() - started,
      response.status,
      failed,
      scope,
    );
    return response;
  } catch (error) {
    const failed = !(error instanceof RpcCircuitOpenError);
    if (failed) {
      recordRequest(host, endpointId, requests, performance.now() - started, null, true, scope);
      log.warn("rpc request failed", {
        requestId: scope.requestId,
        operation: scope.operation,
        context: scope.context,
        providerHost: host,
        methods: requests.map((request) => request.method),
        err: error,
      });
    }
    throw error;
  } finally {
    release();
  }
}) as typeof fetch;

function snapshotScope(scope: ScopeState): RpcScopeDetails {
  return {
    requestId: scope.requestId,
    operation: scope.operation,
    context: scope.context,
    priority: scope.priority,
    providerHosts: [...scope.providerHosts],
    httpRequests: scope.httpRequests,
    methods: Object.fromEntries(scope.methods),
    retries: scope.retries,
    http429: scope.http429,
    failures: scope.failures,
    estimatedUnits: scope.estimatedUnits,
    durationMs: Math.round(performance.now() - scope.startedAt),
  };
}

export interface RpcMetricsSnapshot {
  schemaVersion: 2;
  service: string;
  startedAt: string;
  capturedAt: string;
  unitTableVersion: string;
  estimatedUnitsAreLabeledEstimates: true;
  totalHttpRequests: number;
  totalMethods: number;
  totalRetries: number;
  totalHttp429: number;
  totalFailures: number;
  totalEstimatedUnits: number;
  latencyMs: { sampleCount: number; p50: number | null; p95: number | null };
  byContext: Record<RpcContext, { requests: number; methods: number; estimatedUnits: number }>;
  byHost: Record<
    string,
    {
      requests: number;
      retries: number;
      http429: number;
      failures: number;
      p50: number | null;
      p95: number | null;
      generalRateLimitRps: number | null;
      logsRateLimitRps: number | null;
    }
  >;
  /** Opaque SHA-256 endpoint IDs, never keyed URL paths. Counts are not bills. */
  byEndpoint: Record<
    string,
    { host: string; requests: number; http429: number; failures: number; estimatedUnits: number }
  >;
  byMethod: Record<
    string,
    {
      calls: number;
      retries: number;
      http429: number;
      failures: number;
      p50: number | null;
      p95: number | null;
    }
  >;
  operations: Record<
    string,
    {
      count: number;
      requests: number;
      failures: number;
      http429: number;
      sampleCount: number;
      p50: number | null;
      p95: number | null;
    }
  >;
  outcomes: Record<string, number>;
}

export function getRpcMetricsSnapshot(): RpcMetricsSnapshot {
  const allLatencies = [...hostMetrics.values()].flatMap((metric) => metric.latenciesMs);
  return {
    schemaVersion: 2,
    service: env.SERVICE_NAME,
    startedAt: startedAt.toISOString(),
    capturedAt: new Date().toISOString(),
    unitTableVersion: RPC_UNIT_TABLE_VERSION,
    estimatedUnitsAreLabeledEstimates: true,
    totalHttpRequests,
    totalMethods,
    totalRetries,
    totalHttp429,
    totalFailures,
    totalEstimatedUnits,
    latencyMs: {
      sampleCount: allLatencies.length,
      p50: percentile(allLatencies, 0.5),
      p95: percentile(allLatencies, 0.95),
    },
    byContext: Object.fromEntries(
      [...contextMetrics.entries()].map(([context, metric]) => [context, metric]),
    ) as RpcMetricsSnapshot["byContext"],
    byHost: Object.fromEntries(
      [...hostMetrics.entries()].map(([host, metric]) => [
        host,
        {
          requests: metric.requests,
          retries: metric.retries,
          http429: metric.http429,
          failures: metric.failures,
          p50: percentile(metric.latenciesMs, 0.5),
          p95: percentile(metric.latenciesMs, 0.95),
          generalRateLimitRps: configuredRate(host, "general")?.rps ?? null,
          logsRateLimitRps: configuredRate(host, "logs")?.rps ?? null,
        },
      ]),
    ),
    byEndpoint: Object.fromEntries([...endpointMetrics].map(([id, metric]) => [id, { ...metric }])),
    byMethod: Object.fromEntries(
      [...methodMetrics.entries()].map(([method, metric]) => [
        method,
        {
          calls: metric.calls,
          retries: metric.retries,
          http429: metric.http429,
          failures: metric.failures,
          p50: percentile(metric.latenciesMs, 0.5),
          p95: percentile(metric.latenciesMs, 0.95),
        },
      ]),
    ),
    operations: Object.fromEntries(
      [...operationMetrics.entries()].map(([operation, metric]) => [
        operation,
        {
          count: metric.count,
          requests: metric.requests,
          failures: metric.failures,
          http429: metric.http429,
          sampleCount: metric.latenciesMs.length,
          p50: percentile(metric.latenciesMs, 0.5),
          p95: percentile(metric.latenciesMs, 0.95),
        },
      ]),
    ),
    outcomes: Object.fromEntries(outcomes),
  };
}

export async function persistRpcMetricsSnapshot(force = false): Promise<void> {
  if (!force && Date.now() - lastPersistAt < 2_000) return;
  lastPersistAt = Date.now();
  try {
    await redis.set(
      `ops:rpc:${env.SERVICE_NAME}`,
      JSON.stringify(getRpcMetricsSnapshot()),
      "EX",
      env.RPC_METRICS_TTL_SEC,
    );
  } catch (error) {
    log.warn("could not persist rpc metrics snapshot", { err: error });
  }
}

export async function loadRpcMetricsSnapshots(): Promise<RpcMetricsSnapshot[]> {
  try {
    const names = [...new Set(["cortex-api", "cortex-worker", env.SERVICE_NAME])];
    const values = await redis.mget(...names.map((name) => `ops:rpc:${name}`));
    return values.flatMap((value) => {
      if (!value) return [];
      try {
        return [JSON.parse(value) as RpcMetricsSnapshot];
      } catch {
        return [];
      }
    });
  } catch (error) {
    log.warn("could not load rpc metrics snapshots", { err: error });
    return [];
  }
}

export function recordRpcOutcome(operation: string, status: string): void {
  const key = `${operation}:${status}`;
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}

export async function withRpcScope<T>(
  options: RpcScopeOptions,
  work: () => Promise<T>,
): Promise<T> {
  const scope: ScopeState = {
    requestId: options.requestId ?? `${env.SERVICE_NAME}-${++sequence}`,
    operation: options.operation,
    context: options.context ?? "unknown",
    priority: options.priority ?? "background",
    startedAt: performance.now(),
    providerHosts: new Set(),
    httpRequests: 0,
    methods: new Map(),
    retries: 0,
    http429: 0,
    failures: 0,
    estimatedUnits: 0,
    previousFailures: new Map(),
  };
  return storage.run(scope, async () => {
    try {
      return await work();
    } finally {
      const details = snapshotScope(scope);
      if (details.httpRequests > 0) {
        const metric = operationMetrics.get(details.operation) ?? {
          count: 0,
          requests: 0,
          failures: 0,
          http429: 0,
          latenciesMs: [],
        };
        metric.count += 1;
        metric.requests += details.httpRequests;
        metric.failures += details.failures;
        metric.http429 += details.http429;
        recentSamples(metric.latenciesMs, details.durationMs);
        operationMetrics.set(details.operation, metric);
        log.info("rpc operation measured", {
          ...details,
        });
      }
      void persistRpcMetricsSnapshot();
    }
  });
}

/** Runs a measurement scope and preserves the old `{ value, requests }` API. */
export async function countRpcRequests<T>(
  work: () => Promise<T>,
  options: Omit<RpcScopeOptions, "requestId"> = { operation: "rpc-scope" },
): Promise<{ value: T; requests: number; details: RpcScopeDetails }> {
  let details: RpcScopeDetails | undefined;
  const value = await withRpcScope(options, async () => {
    try {
      return await work();
    } finally {
      const scope = storage.getStore();
      if (scope) details = snapshotScope(scope);
    }
  });
  const measured = details ?? {
    requestId: "unknown",
    operation: options.operation,
    context: options.context ?? "unknown",
    priority: options.priority ?? "background",
    providerHosts: [],
    httpRequests: 0,
    methods: {},
    retries: 0,
    http429: 0,
    failures: 0,
    estimatedUnits: 0,
    durationMs: 0,
  };
  return { value, requests: measured.httpRequests, details: measured };
}

export function currentRpcScope(): Pick<RpcScopeOptions, "operation" | "context" | "priority"> {
  const scope = storage.getStore();
  return scope
    ? { operation: scope.operation, context: scope.context, priority: scope.priority }
    : { operation: "unscoped", context: "unknown", priority: "background" };
}
