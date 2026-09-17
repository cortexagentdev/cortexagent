import { db } from "../db/client.ts";
import { universe } from "../db/schema.ts";
import { sql } from "drizzle-orm";
import { env } from "../env.ts";
import { executionReadiness } from "../execution/context.ts";
import { registryStatus } from "../execution/registry.ts";
import {
  cachedRpcCapabilities,
  defaultRpcCapabilityTargets,
  readRpcHead,
  readRpcHeadsAtCommonHeight,
  refreshRpcCapabilities,
  type RpcHead,
  type RpcHeadReading,
} from "../chain/rpc-capabilities.ts";
import { loadRpcMetricsSnapshots, rpcHost } from "../chain/rpc-metrics.ts";
import { logger } from "../lib/logger.ts";
import { redis } from "../lib/redis.ts";
import { cortexQueue } from "../queue/queues.ts";
import { indexerStatus } from "../workers/vault-indexer.ts";

const log = logger.child({ module: "ops-health" });
const headState = new Map<
  string,
  { block: number; hash: string | null; lastProgressAt: number; observedAt: number }
>();

async function capabilityHealth(
  context: "research" | "execution",
  urls: readonly string[],
  expectedChainId: number,
) {
  const cached = new Map(cachedRpcCapabilities().map((record) => [record.host, record]));
  const missing = urls.filter((url) => !cached.has(new URL(url).host));
  if (missing.length) {
    for (const record of await refreshRpcCapabilities(context, missing, expectedChainId)) {
      cached.set(record.host, record);
    }
  }
  return urls
    .map((url) => cached.get(new URL(url).host))
    .filter((record): record is NonNullable<typeof record> => Boolean(record));
}

type HealthStatus = "healthy" | "degraded" | "unconfigured";

async function monitorHeads(
  context: "research" | "execution",
  urls: readonly string[],
  expectedChainId: number,
) {
  if (!urls.length)
    return { status: "unconfigured" as const, heads: [], reasons: ["unconfigured"] };
  const readings: RpcHeadReading[] = [];
  const heads: RpcHead[] = [];
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const head = await readRpcHead(url);
      readings.push({ url, head });
      heads.push(head);
    } catch {
      failures.push(new URL(url).host);
    }
  }
  const common = await readRpcHeadsAtCommonHeight(readings);
  const allCommonHeadsAvailable = common.readings.length === readings.length;
  const consistentHeads = common.readings.map((reading) => reading.head);
  const stateKey = `${context}:${urls.map((url) => new URL(url).host).join(",")}`;
  const now = Date.now();
  const highest = heads.reduce<RpcHead | null>(
    (current, head) => (!current || head.number > current.number ? head : current),
    null,
  );
  const state = headState.get(stateKey);
  if (
    highest &&
    (!state ||
      highest.number > state.block ||
      (highest.number === state.block && highest.hash !== state.hash))
  ) {
    headState.set(stateKey, {
      block: highest.number,
      hash: highest.hash,
      lastProgressAt: now,
      observedAt: now,
    });
  }
  const current = headState.get(stateKey);
  const disagreement =
    allCommonHeadsAvailable &&
    new Set(consistentHeads.map((head) => `${head.number}:${head.hash}`)).size > 1;
  const failedHosts = [...new Set([...failures, ...common.failedHosts])];
  const stalled = Boolean(current && now - current.lastProgressAt > env.RPC_STALLED_HEAD_MS);
  const reasons = [
    ...(failedHosts.length ? [`provider outage: ${failedHosts.join(", ")}`] : []),
    ...(disagreement ? ["provider disagreement"] : []),
    ...(stalled ? [`head stalled for over ${env.RPC_STALLED_HEAD_MS}ms`] : []),
    ...(heads.some((head) => head.number < 0 || (head.timestamp ?? 0) <= 0)
      ? ["head metadata incomplete"]
      : []),
  ];
  return {
    status: reasons.length ? ("degraded" as const) : ("healthy" as const),
    expectedChainId,
    heads,
    highest,
    lastProgressAt: current ? new Date(current.lastProgressAt).toISOString() : null,
    stalledThresholdMs: env.RPC_STALLED_HEAD_MS,
    reasons,
  };
}

function mergeMetrics(snapshots: Awaited<ReturnType<typeof loadRpcMetricsSnapshots>>) {
  return {
    services: snapshots.map((snapshot) => ({
      service: snapshot.service,
      capturedAt: snapshot.capturedAt,
      unitTableVersion: snapshot.unitTableVersion,
      estimatedUnitsAreLabeledEstimates: snapshot.estimatedUnitsAreLabeledEstimates,
      totalHttpRequests: snapshot.totalHttpRequests,
      totalMethods: snapshot.totalMethods,
      totalRetries: snapshot.totalRetries,
      totalHttp429: snapshot.totalHttp429,
      totalFailures: snapshot.totalFailures,
      totalEstimatedUnits: snapshot.totalEstimatedUnits,
      latencyMs: snapshot.latencyMs,
      byContext: snapshot.byContext,
      byHost: snapshot.byHost,
      byEndpoint: snapshot.byEndpoint ?? {},
      byMethod: snapshot.byMethod,
      operations: snapshot.operations,
      outcomes: snapshot.outcomes,
    })),
    totalHttp429: snapshots.reduce((sum, snapshot) => sum + snapshot.totalHttp429, 0),
    totalFailures: snapshots.reduce((sum, snapshot) => sum + snapshot.totalFailures, 0),
  };
}

async function queueHealth() {
  try {
    const counts = await cortexQueue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
    );
    const backlog = counts.waiting + counts.delayed;
    return {
      status: backlog > env.WORKER_BACKLOG_CAP ? "degraded" : "healthy",
      backlog,
      backlogCap: env.WORKER_BACKLOG_CAP,
      counts,
    };
  } catch (error) {
    return {
      status: "degraded",
      backlog: null,
      backlogCap: env.WORKER_BACKLOG_CAP,
      error: "queue unavailable",
    };
  }
}

async function storageHealth() {
  try {
    const [database, redisPing, size] = await Promise.all([
      db.execute(sql`select 1 as ok`),
      redis.ping(),
      db.execute<{ bytes: string }>(
        sql`select pg_database_size(current_database())::text as bytes`,
      ),
    ]);
    return {
      status: database[0]?.ok === 1 && redisPing === "PONG" ? "healthy" : "degraded",
      database: "ok",
      redis: redisPing,
      databaseBytes: Number(size[0]?.bytes ?? 0),
    };
  } catch {
    return { status: "degraded", database: "unavailable", redis: "unavailable" };
  }
}

export async function operationalHealth() {
  const targets = defaultRpcCapabilityTargets();
  const [researchHead, executionHead, capabilities, metrics, queue, storage, readiness] =
    await Promise.all([
      monitorHeads("research", targets.research.urls, targets.research.chainId),
      monitorHeads("execution", targets.execution.urls, targets.execution.chainId),
      (async () => {
        const records = [
          ...(await capabilityHealth("research", targets.research.urls, targets.research.chainId)),
          ...(targets.execution.urls.length
            ? await capabilityHealth("execution", targets.execution.urls, targets.execution.chainId)
            : []),
        ];
        return records.length ? records : cachedRpcCapabilities();
      })(),
      loadRpcMetricsSnapshots(),
      queueHealth(),
      storageHealth(),
      executionReadiness(),
    ]);

  let discovery: unknown = { configured: false };
  let indexer: unknown = { configured: false };
  if (readiness.ready) {
    try {
      [discovery, indexer] = await Promise.all([registryStatus(), indexerStatus()]);
    } catch (error) {
      log.warn("execution health detail unavailable", { err: error });
      discovery = { status: "degraded", error: "discovery status unavailable" };
      indexer = { status: "degraded", error: "indexer status unavailable" };
    }
  }

  const oracle = await db
    .select({ maxAgeSec: sql<number | null>`max(${universe.feedAgeSec})` })
    .from(universe)
    .catch(() => [{ maxAgeSec: null }]);
  const redactedReadiness = {
    ...readiness,
    walletRpcUrl: readiness.walletRpcUrl ? rpcHost(readiness.walletRpcUrl) : null,
  };
  const status: HealthStatus =
    [researchHead.status, executionHead.status, queue.status, storage.status].includes(
      "degraded",
    ) ||
    (readiness.ready && (indexer as { status?: string }).status === "degraded")
      ? "degraded"
      : readiness.ready || executionHead.status === "unconfigured"
        ? "healthy"
        : "unconfigured";
  const observationRows =
    (discovery as { observations?: Array<{ newest?: Date | null }> }).observations ?? [];
  const newestPoolObservation = observationRows
    .map((row) => (row.newest instanceof Date ? row.newest.getTime() : 0))
    .reduce((latest, value) => Math.max(latest, value), 0);

  return {
    status,
    observedAt: new Date().toISOString(),
    rpc: {
      research: researchHead,
      execution: executionHead,
      capabilities,
      metrics: mergeMetrics(metrics),
    },
    execution: {
      identity: redactedReadiness,
      discovery,
      poolFreshness: {
        newestObservedAt: newestPoolObservation
          ? new Date(newestPoolObservation).toISOString()
          : null,
        ageSec: newestPoolObservation
          ? Math.floor((Date.now() - newestPoolObservation) / 1000)
          : null,
      },
      indexer,
      oracle: { maxFeedAgeSec: oracle[0]?.maxAgeSec ?? null },
    },
    quote: {
      latencyAndRefusals: metrics.flatMap((snapshot) =>
        Object.entries(snapshot.operations)
          .filter(([operation]) => operation.includes("quote"))
          .map(([operation, value]) => ({ service: snapshot.service, operation, ...value })),
      ),
      outcomes: metrics.flatMap((snapshot) =>
        Object.entries(snapshot.outcomes)
          .filter(([key]) => key.includes("quote"))
          .map(([key, count]) => ({ service: snapshot.service, key, count })),
      ),
    },
    worker: { queue, indexer },
    storage,
  };
}
