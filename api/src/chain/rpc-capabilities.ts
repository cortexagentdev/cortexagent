import { MULTICALL3_ADDRESS } from "./addresses.ts";
import { inferRpcContext, rpcHost, withRpcScope, type RpcContext } from "./rpc-metrics.ts";
import { env } from "../env.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CAPABILITY_TTL_MS = 5 * 60_000;
// A verified record keeps serving requests while a background probe replaces
// it. Only past this age does a request wait for a fresh probe instead.
const CAPABILITY_MAX_STALE_MS = 30 * 60_000;
const FAILED_CAPABILITY_TTL_MS = 30_000;
// Shorter than the TTL so a warm process rarely serves an expired record.
const CAPABILITY_REFRESH_INTERVAL_MS = 4 * 60_000;

export type RpcCapabilityRequirement =
  "latest" | "historical" | "logs" | "multicall" | "simulation" | "blockHash";

export interface RpcCapabilityRecord {
  host: string;
  checkedAt: string;
  chainId: number | null;
  latest: "ok" | "failed";
  historical: "ok" | "failed";
  multicall: "ok" | "failed";
  simulation: "ok" | "failed";
  blockHash: "ok" | "failed";
  /** "unprobed" when only the core methods were checked; see `probeEndpoint`. */
  logRange: { status: "ok" | "failed" | "unprobed"; maxBlocksProbed: number | null };
  refusal: string | null;
}

export class RpcCapabilityError extends Error {
  constructor(
    public readonly code: "RPC_CAPABILITY_UNAVAILABLE" | "RPC_PROVIDER_OUTAGE",
    message: string,
    public readonly context: RpcContext,
    public readonly hosts: string[],
  ) {
    super(message);
    this.name = "RpcCapabilityError";
  }
}

interface CapabilityEntry {
  expiresAt: number;
  probedAt: number;
  record: RpcCapabilityRecord;
}

const cache = new Map<string, CapabilityEntry>();
// One probe per context and host at a time. A log-range probe also satisfies a
// caller that only needs the core methods.
const probes = new Map<string, { logs: boolean; promise: Promise<RpcCapabilityRecord> }>();
const executionHeadState = { block: -1, hash: null as string | null, lastProgressAt: 0 };

function hexBlock(value: number): string {
  return `0x${Math.max(0, value).toString(16)}`;
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(env.RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "JSON-RPC error");
  return body.result;
}

export interface RpcHead {
  host: string;
  number: number;
  hash: string | null;
  timestamp: number | null;
}

interface RpcBlockHeader {
  number?: string;
  hash?: string;
  timestamp?: string;
}

async function readRpcHeader(url: string, blockTag: string, operation: string): Promise<RpcHead> {
  return withRpcScope(
    {
      operation: `${inferRpcContext(rpcHost(url))}-${operation}`,
      context: inferRpcContext(rpcHost(url)),
      priority: "recovery",
    },
    async () => {
      // Read number, hash, and timestamp from one header so chain progress
      // cannot make the metadata internally inconsistent.
      const block = (await rpcCall(url, "eth_getBlockByNumber", [
        blockTag,
        false,
      ])) as RpcBlockHeader | null;
      if (!block?.number) throw new Error("RPC returned an incomplete block header");
      const number = Number(BigInt(block.number));
      if (!Number.isSafeInteger(number) || number < 0)
        throw new Error("RPC returned an invalid block number");
      if (typeof block.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(block.hash))
        throw new Error("RPC returned an invalid block hash");
      if (typeof block.timestamp !== "string")
        throw new Error("RPC returned an incomplete block timestamp");
      const timestamp = Number(BigInt(block.timestamp));
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
        throw new Error("RPC returned an invalid block timestamp");
      return {
        host: rpcHost(url),
        number,
        hash: block.hash,
        timestamp,
      };
    },
  );
}

export async function readRpcHead(url: string): Promise<RpcHead> {
  return readRpcHeader(url, "latest", "head-health");
}

export async function readRpcHeadAt(url: string, number: number): Promise<RpcHead> {
  const head = await readRpcHeader(url, hexBlock(number), "head-consistency");
  if (head.number !== number) throw new Error("RPC returned a different block header");
  return head;
}

export interface RpcHeadReading {
  url: string;
  head: RpcHead;
}

/**
 * Providers can answer latest at different moments while the chain advances.
 * Compare their coherent headers at the lowest observed height so that normal
 * head movement is not mistaken for a fork.
 */
export async function readRpcHeadsAtCommonHeight(
  readings: readonly RpcHeadReading[],
): Promise<{ block: number | null; readings: RpcHeadReading[]; failedHosts: string[] }> {
  const commonBlock = readings.reduce<number | null>(
    (current, reading) =>
      current === null ? reading.head.number : Math.min(current, reading.head.number),
    null,
  );
  if (commonBlock === null) return { block: null, readings: [], failedHosts: [] };

  const checked = await Promise.all(
    readings.map(async ({ url, head }) => {
      try {
        return {
          url,
          head: head.number === commonBlock ? head : await readRpcHeadAt(url, commonBlock),
        };
      } catch {
        return { url, head: null };
      }
    }),
  );
  return {
    block: commonBlock,
    readings: checked.flatMap(({ url, head }) => (head ? [{ url, head }] : [])),
    failedHosts: checked.flatMap(({ url, head }) => (head ? [] : [rpcHost(url)])),
  };
}

/**
 * A quote or unsigned transaction must not be called fresh merely because an
 * endpoint answers. This guard keeps an execution head that stopped advancing
 * from producing another executable plan, while research reads remain usable.
 */
export async function assertExecutionHead(
  urls: readonly string[],
  expectedChainId: number,
): Promise<RpcHead> {
  if (!urls.length)
    throw new RpcCapabilityError(
      "RPC_PROVIDER_OUTAGE",
      "Execution RPC is not configured; no executable plan can be issued.",
      "execution",
      [],
    );
  const readings = await Promise.all(
    urls.map(async (url) => {
      try {
        return { url, head: await readRpcHead(url) };
      } catch {
        // An explicitly configured alternative can serve if it agrees with the
        // same execution chain. The failed endpoint remains visible in health.
        return null;
      }
    }),
  );
  const available = readings.filter((reading): reading is RpcHeadReading => reading !== null);
  const common = await readRpcHeadsAtCommonHeight(available);
  const selected = common.readings[0]?.head;
  if (
    !selected ||
    common.readings.length !== available.length ||
    common.readings.some((reading) => reading.head.hash !== selected.hash)
  )
    throw new RpcCapabilityError(
      "RPC_PROVIDER_OUTAGE",
      "Execution providers are unavailable or disagree; no fresh executable plan was issued.",
      "execution",
      urls.map(rpcHost),
    );
  const now = Date.now();
  if (
    executionHeadState.lastProgressAt === 0 ||
    selected.number > executionHeadState.block ||
    (selected.number === executionHeadState.block && selected.hash !== executionHeadState.hash)
  ) {
    executionHeadState.block = selected.number;
    executionHeadState.hash = selected.hash;
    executionHeadState.lastProgressAt = now;
  }
  if (now - executionHeadState.lastProgressAt > env.RPC_STALLED_HEAD_MS)
    throw new RpcCapabilityError(
      "RPC_PROVIDER_OUTAGE",
      `Execution head has not progressed for over ${env.RPC_STALLED_HEAD_MS}ms; refresh is required.`,
      "execution",
      urls.map(rpcHost),
    );
  if (selected.number < 0 || !selected.hash || !selected.timestamp || expectedChainId <= 0)
    throw new RpcCapabilityError(
      "RPC_PROVIDER_OUTAGE",
      "Execution head metadata is incomplete.",
      "execution",
      urls.map(rpcHost),
    );
  return selected;
}

/**
 * `logs` adds the `eth_getLogs` range walk. It is the slowest part of a probe
 * (log queries are paced far below ordinary reads), so callers that do not
 * require log capability skip it.
 */
async function probeEndpoint(
  url: string,
  expectedChainId: number,
  logs: boolean,
): Promise<RpcCapabilityRecord> {
  const host = rpcHost(url);
  let chainId: number | null = null;
  let latestBlock = 0;
  let latestHash: string | null = null;
  let latest: RpcCapabilityRecord["latest"] = "failed";
  let historical: RpcCapabilityRecord["historical"] = "failed";
  let multicall: RpcCapabilityRecord["multicall"] = "failed";
  let simulation: RpcCapabilityRecord["simulation"] = "failed";
  let blockHash: RpcCapabilityRecord["blockHash"] = "failed";
  let logRange: RpcCapabilityRecord["logRange"] = {
    status: logs ? "failed" : "unprobed",
    maxBlocksProbed: null,
  };
  let refusal: string | null = null;

  try {
    chainId = Number(BigInt(String(await rpcCall(url, "eth_chainId", []))));
    if (chainId !== expectedChainId) throw new Error(`wrong chain ${chainId}`);
    latestBlock = Number(BigInt(String(await rpcCall(url, "eth_blockNumber", []))));
    latest = "ok";
    const latestHeader = (await rpcCall(url, "eth_getBlockByNumber", ["latest", false])) as {
      hash?: string;
    } | null;
    latestHash = latestHeader?.hash ?? null;
  } catch (error) {
    refusal = error instanceof Error ? error.message : "latest head failed";
  }

  if (latest === "ok") {
    try {
      await rpcCall(url, "eth_getBlockByNumber", [hexBlock(latestBlock - 1), false]);
      historical = "ok";
    } catch {
      historical = "failed";
    }
    try {
      const code = await rpcCall(url, "eth_getCode", [MULTICALL3_ADDRESS, "latest"]);
      multicall = typeof code === "string" && code !== "0x" ? "ok" : "failed";
    } catch {
      multicall = "failed";
    }
    try {
      await rpcCall(url, "eth_call", [{ to: ZERO_ADDRESS, data: "0x" }, "latest"]);
      simulation = "ok";
    } catch {
      simulation = "failed";
    }
    if (latestHash) {
      try {
        await rpcCall(url, "eth_getBlockByHash", [latestHash, false]);
        blockHash = "ok";
      } catch {
        blockHash = "failed";
      }
    }
    let previous = 0;
    const widths = logs ? [10, 20, 50, 100, 250, env.RPC_LOG_PROBE_MAX_BLOCKS] : [];
    for (const width of widths) {
      const bounded = Math.min(width, env.RPC_LOG_PROBE_MAX_BLOCKS);
      if (bounded <= previous) continue;
      try {
        await rpcCall(url, "eth_getLogs", [
          {
            fromBlock: hexBlock(latestBlock - bounded + 1),
            toBlock: "latest",
            address: ZERO_ADDRESS,
            topics: [],
          },
        ]);
        previous = bounded;
        logRange = { status: "ok", maxBlocksProbed: bounded };
      } catch {
        break;
      }
    }
  }

  if (latest === "ok" && chainId === expectedChainId) refusal = null;
  return {
    host,
    checkedAt: new Date().toISOString(),
    chainId,
    latest,
    historical,
    multicall,
    simulation,
    blockHash,
    logRange,
    refusal,
  };
}

/** One URL per host: keys at the same provider share a capability record. */
function uniqueHosts(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((url) => {
    const host = rpcHost(url);
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

function probeHost(
  context: RpcContext,
  url: string,
  expectedChainId: number,
  logs: boolean,
): Promise<RpcCapabilityRecord> {
  const host = rpcHost(url);
  const key = `${context}:${host}`;
  const inflight = probes.get(key);
  if (inflight && (inflight.logs || !logs)) return inflight.promise;
  const promise = (async () => {
    let record: RpcCapabilityRecord;
    let ttl = CAPABILITY_TTL_MS;
    try {
      record = await probeEndpoint(url, expectedChainId, logs);
      // A core-only probe keeps the last known log range of a healthy host.
      const previous = cache.get(key)?.record;
      if (!logs && previous && record.latest === "ok") record.logRange = previous.logRange;
    } catch (error) {
      record = {
        host,
        checkedAt: new Date().toISOString(),
        chainId: null,
        latest: "failed",
        historical: "failed",
        multicall: "failed",
        simulation: "failed",
        blockHash: "failed",
        logRange: { status: logs ? "failed" : "unprobed", maxBlocksProbed: null },
        refusal: error instanceof Error ? error.message : "provider probe failed",
      };
      ttl = FAILED_CAPABILITY_TTL_MS;
    }
    const now = Date.now();
    cache.set(key, { expiresAt: now + ttl, probedAt: now, record });
    return record;
  })().finally(() => {
    if (probes.get(key)?.promise === promise) probes.delete(key);
  });
  probes.set(key, { logs, promise });
  return promise;
}

/**
 * Probes each distinct host once, all hosts in parallel. Every host has its
 * own pacing queue, so probing them one after another only adds latency.
 */
export async function refreshRpcCapabilities(
  context: RpcContext,
  urls: readonly string[],
  expectedChainId: number,
  { logs = true }: { logs?: boolean } = {},
): Promise<RpcCapabilityRecord[]> {
  return withRpcScope(
    { operation: `${context}-rpc-capability-probe`, context, priority: "recovery" },
    () =>
      Promise.all(uniqueHosts(urls).map((url) => probeHost(context, url, expectedChainId, logs))),
  );
}

function satisfies(
  record: RpcCapabilityRecord,
  requirements: readonly RpcCapabilityRequirement[],
): boolean {
  return requirements.every((requirement) => {
    if (requirement === "logs") return record.logRange.status === "ok";
    return record[requirement] === "ok";
  });
}

/**
 * Stale-while-revalidate. A cached record that satisfies the requirements is
 * served at once, and expired hosts are re-probed in the background. A request
 * waits for a probe only when no usable record exists at all.
 */
export async function requireRpcCapabilities(
  context: RpcContext,
  urls: readonly string[],
  expectedChainId: number,
  requirements: readonly RpcCapabilityRequirement[],
): Promise<RpcCapabilityRecord> {
  const logs = requirements.includes("logs");
  const hosts = uniqueHosts(urls);
  const now = Date.now();
  const usable: RpcCapabilityRecord[] = [];
  const refresh: string[] = [];
  for (const url of hosts) {
    const entry = cache.get(`${context}:${rpcHost(url)}`);
    if (!entry || (logs && entry.record.logRange.status === "unprobed")) {
      refresh.push(url);
      continue;
    }
    if (entry.expiresAt <= now) refresh.push(url);
    if (now - entry.probedAt <= CAPABILITY_MAX_STALE_MS) usable.push(entry.record);
  }

  const cached = usable.find((record) => satisfies(record, requirements));
  if (cached) {
    if (refresh.length)
      void refreshRpcCapabilities(context, refresh, expectedChainId, { logs }).catch(
        () => undefined,
      );
    return cached;
  }

  if (refresh.length) await refreshRpcCapabilities(context, refresh, expectedChainId, { logs });
  const records = hosts.flatMap((url) => {
    const entry = cache.get(`${context}:${rpcHost(url)}`);
    return entry ? [entry.record] : [];
  });
  const selected = records.find((record) => satisfies(record, requirements));
  if (selected) return selected;
  throw new RpcCapabilityError(
    records.some((record) => record.latest === "ok")
      ? "RPC_CAPABILITY_UNAVAILABLE"
      : "RPC_PROVIDER_OUTAGE",
    `No ${context} RPC endpoint satisfies ${requirements.join(", ")}; no compatible fallback was selected.`,
    context,
    records.map((record) => record.host),
  );
}

/**
 * Keeps a long-running process's records warm so a request after an idle
 * period does not pay for a probe. Includes the log range, since no request is
 * waiting on it. Returns a stop function.
 */
export function startRpcCapabilityRefresh(
  context: RpcContext,
  urls: readonly string[],
  expectedChainId: number,
): () => void {
  if (!urls.length) return () => undefined;
  const run = () =>
    void refreshRpcCapabilities(context, urls, expectedChainId).catch(() => undefined);
  run();
  const timer = setInterval(run, CAPABILITY_REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function cachedRpcCapabilities(): RpcCapabilityRecord[] {
  return [...cache.values()]
    .filter((entry) => entry.expiresAt > Date.now())
    .map((entry) => entry.record);
}

export function defaultRpcCapabilityTargets() {
  return {
    research: {
      urls: [...(env.RHC_RPC_URLS ?? [env.RHC_RPC_URL])],
      logs: [...(env.RHC_LOGS_RPC_URLS ?? [env.RHC_RPC_URL])],
      chainId: env.RHC_CHAIN_ID,
    },
    execution: {
      urls: [...(env.EXECUTION_RPC_URLS ?? [])],
      logs: [...(env.EXECUTION_LOGS_RPC_URLS ?? env.EXECUTION_RPC_URLS ?? [])],
      chainId: env.EXECUTION_MODE === "robinhood-mainnet" ? 4663 : 46630,
    },
  } as const;
}

export function capabilityContextForUrl(url: string): RpcContext {
  return inferRpcContext(rpcHost(url));
}
