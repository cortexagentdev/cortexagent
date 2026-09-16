import { MULTICALL3_ADDRESS } from "./addresses.ts";
import { inferRpcContext, rpcHost, withRpcScope, type RpcContext } from "./rpc-metrics.ts";
import { env } from "../env.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CAPABILITY_TTL_MS = 5 * 60_000;

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
  logRange: { status: "ok" | "failed"; maxBlocksProbed: number | null };
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

const cache = new Map<string, { expiresAt: number; record: RpcCapabilityRecord }>();
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

export async function readRpcHead(url: string): Promise<RpcHead> {
  return withRpcScope(
    {
      operation: `${inferRpcContext(rpcHost(url))}-head-health`,
      context: inferRpcContext(rpcHost(url)),
      priority: "recovery",
    },
    async () => {
      const number = Number(BigInt(String(await rpcCall(url, "eth_blockNumber", []))));
      const block = (await rpcCall(url, "eth_getBlockByNumber", ["latest", false])) as {
        hash?: string;
        timestamp?: string;
      } | null;
      return {
        host: rpcHost(url),
        number,
        hash: block?.hash ?? null,
        timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null,
      };
    },
  );
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
  const heads: RpcHead[] = [];
  for (const url of urls) {
    try {
      const head = await readRpcHead(url);
      heads.push(head);
    } catch {
      // An explicitly configured alternative can serve if it agrees with the
      // same execution chain. The failed endpoint remains visible in health.
    }
  }
  const selected = heads[0];
  if (
    !selected ||
    heads.some((head) => head.number !== selected.number || head.hash !== selected.hash)
  )
    throw new RpcCapabilityError(
      "RPC_PROVIDER_OUTAGE",
      "Execution providers are unavailable or disagree; no fresh executable plan was issued.",
      "execution",
      urls.map(rpcHost),
    );
  const now = Date.now();
  if (
    selected.number > executionHeadState.block ||
    selected.hash !== executionHeadState.hash ||
    executionHeadState.lastProgressAt === 0
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
  if (selected.number < 0 || expectedChainId <= 0)
    throw new RpcCapabilityError(
      "RPC_PROVIDER_OUTAGE",
      "Execution head metadata is incomplete.",
      "execution",
      urls.map(rpcHost),
    );
  return selected;
}

async function probeEndpoint(url: string, expectedChainId: number): Promise<RpcCapabilityRecord> {
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
    status: "failed",
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
    for (const width of [10, 20, 50, 100, 250, env.RPC_LOG_PROBE_MAX_BLOCKS]) {
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

export async function refreshRpcCapabilities(
  context: RpcContext,
  urls: readonly string[],
  expectedChainId: number,
): Promise<RpcCapabilityRecord[]> {
  return withRpcScope(
    { operation: `${context}-rpc-capability-probe`, context, priority: "recovery" },
    async () => {
      const records: RpcCapabilityRecord[] = [];
      for (const url of urls) {
        const host = rpcHost(url);
        try {
          const record = await probeEndpoint(url, expectedChainId);
          cache.set(`${context}:${host}`, { expiresAt: Date.now() + CAPABILITY_TTL_MS, record });
          records.push(record);
        } catch (error) {
          const record: RpcCapabilityRecord = {
            host,
            checkedAt: new Date().toISOString(),
            chainId: null,
            latest: "failed",
            historical: "failed",
            multicall: "failed",
            simulation: "failed",
            blockHash: "failed",
            logRange: { status: "failed", maxBlocksProbed: null },
            refusal: error instanceof Error ? error.message : "provider probe failed",
          };
          cache.set(`${context}:${host}`, { expiresAt: Date.now() + 30_000, record });
          records.push(record);
        }
      }
      return records;
    },
  );
}

export async function requireRpcCapabilities(
  context: RpcContext,
  urls: readonly string[],
  expectedChainId: number,
  requirements: readonly RpcCapabilityRequirement[],
): Promise<RpcCapabilityRecord> {
  const records: RpcCapabilityRecord[] = [];
  const uncached = urls.filter((url) => {
    const entry = cache.get(`${context}:${rpcHost(url)}`);
    if (!entry || entry.expiresAt <= Date.now()) return true;
    records.push(entry.record);
    return false;
  });
  if (uncached.length)
    records.push(...(await refreshRpcCapabilities(context, uncached, expectedChainId)));
  const selected = records.find((record) =>
    requirements.every((requirement) => {
      if (requirement === "logs") return record.logRange.status === "ok";
      return record[requirement] === "ok";
    }),
  );
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
