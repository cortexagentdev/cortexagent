import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { apiCors } from "./http/cors.ts";

import { MAINNET_LOGS_RPC_URLS, MAINNET_RPC_URLS, rpcHost } from "./chain/client.ts";
import {
  defaultRpcCapabilityTargets,
  startRpcCapabilityRefresh,
} from "./chain/rpc-capabilities.ts";
import { withRpcScope } from "./chain/rpc-metrics.ts";
import { closeDb, db } from "./db/client.ts";
import { env, isDevelopment } from "./env.ts";
import {
  assertLensDefinitionsValid,
  findUnclassifiedAssets,
  logUnclassifiedAssets,
} from "./lenses/load.ts";
import { logger } from "./lib/logger.ts";
import { createRateLimiter } from "./lib/rate-limit.ts";
import { closeRedis } from "./lib/redis.ts";
import { installShutdownHandlers } from "./lib/shutdown.ts";
import { closeQueueConnection } from "./queue/connection.ts";
import { closeQueues, enqueue } from "./queue/queues.ts";
import { appRouter } from "./routers/index.ts";
import { createContext } from "./trpc.ts";
import {
  ensureExecutionBinding,
  registryStatus,
  seedVerifiedVenues,
} from "./execution/registry.ts";
import { publicStats } from "./http/public-stats.ts";
import { researchCards } from "./http/research-cards.ts";
import { indexerStatus } from "./workers/vault-indexer.ts";
import { syncPresetRecords } from "./execution/preset-registry-store.ts";
import { operationalHealth } from "./ops/health.ts";

const startedAt = Date.now();

// Do not bind research-only installations. Once execution is configured, fail
// closed before serving any execution route rather than writing to an
// unbound/mismatched database later.
if (env.EXECUTION_MODE) {
  const execution = await ensureExecutionBinding();
  await seedVerifiedVenues();
  await syncPresetRecords(execution);
}

// --- Classification and lens definitions (BE-18) ----------------------------
// Theme Lenses are built from hand-curated files in the repo. A malformed file
// (bad address, weights not summing to 100, duplicate or non-URL-safe slug, a
// lens member that does not resolve to a classified asset) corrupts a whole
// lens silently, so it fails startup here with a message naming the problem.
try {
  assertLensDefinitionsValid();
} catch (err) {
  logger.error("lens definition files are invalid, refusing to start", { err });
  process.exit(1);
}

const app = new Hono();

// The web and API can live on separate origins in production as well as dev.
app.use("/trpc/*", apiCors(env.WEB_ORIGIN));

// --- Rate limit -------------------------------------------------------------
// The bucket lives in Redis so api containers share one budget. In-memory would
// give each container its own, and the effective limit would be N x the number.
const RATE_CAPACITY = 120; // burst
const RATE_REFILL_PER_SEC = 20;

const takeToken = createRateLimiter({
  capacity: RATE_CAPACITY,
  refillPerSec: RATE_REFILL_PER_SEC,
  prefix: "ratelimit:trpc",
});

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("cf-connecting-ip") ?? headers.get("x-real-ip") ?? "unknown";
}

app.use("/trpc/*", async (c, next) => {
  const ip = clientIp(c.req.raw.headers);
  if (!(await takeToken(ip))) {
    logger.warn("rate limit exceeded", { ip, path: c.req.path });
    return c.json({ error: "Too many requests" }, 429, { "Retry-After": "1" });
  }
  return next();
});

// Operational request scopes make interactive wallet reads visible at the same
// JSON-RPC boundary as worker jobs. Provider hosts are inferred from the
// configured endpoint and never copied from a request URL.
app.use("/trpc/*", async (c, next) => {
  const path = c.req.path.replace(/^\/trpc\//, "");
  const execution = /^(vault|theme)\./.test(path);
  return withRpcScope(
    {
      operation: `http:${path.split(".")[0] ?? "trpc"}`,
      context: execution ? "execution" : "research",
      priority: execution ? "interactive" : "background",
      requestId: c.req.header("x-request-id") ?? undefined,
    },
    () => next(),
  );
});

// --- Health -----------------------------------------------------------------
// The block number is here on purpose: a stalled RPC shows up as a failed health
// check instead of a silently stale terminal.
// TODO(BE-3): read this through the chain client instead of an inline JSON-RPC call.
async function fetchBlockNumber(): Promise<number> {
  const res = await fetch(env.RHC_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`RPC responded ${res.status}`);

  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  if (!body.result) throw new Error("RPC returned no result");

  return Number.parseInt(body.result, 16);
}

app.get("/health", async (c) => {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);

  try {
    const blockNumber = await fetchBlockNumber();
    return c.json({ ok: true, chainId: env.RHC_CHAIN_ID, blockNumber, uptimeSec });
  } catch (err) {
    logger.error("health check could not read the chain head", { err });
    return c.json({ ok: false, chainId: env.RHC_CHAIN_ID, blockNumber: null, uptimeSec }, 503);
  }
});

// Deliberately small operational surface: it reports execution-bound coverage
// and last observations without exposing provider URLs or making a quote.
app.get("/execution/discovery", async (c) => {
  if (!env.EXECUTION_MODE) return c.json({ configured: false }, 503);
  try {
    return c.json({ configured: true, ...(await registryStatus()) });
  } catch (err) {
    logger.error("execution discovery status unavailable", { err });
    return c.json({ configured: true, error: "execution registry unavailable" }, 503);
  }
});

// Operational execution indexer status. It exposes cursor lag, degraded
// reorg state, and orphan counts without exposing RPC URLs or research rows.
app.get("/execution/indexer", async (c) => {
  if (!env.EXECUTION_MODE) return c.json({ configured: false }, 503);
  try {
    return c.json({ configured: true, ...(await indexerStatus()) });
  } catch (err) {
    logger.error("execution indexer status unavailable", { err });
    return c.json({ configured: true, error: "execution indexer unavailable" }, 503);
  }
});

app.get("/ops/health", async (c) => {
  try {
    const health = await operationalHealth();
    return c.json(health, health.status === "degraded" ? 503 : 200);
  } catch (err) {
    logger.error("operational health unavailable", { err });
    return c.json({ status: "degraded", error: "operational health unavailable" }, 503);
  }
});

// --- Unclassified assets (BE-18) -------------------------------------------
// Every universe row with no classification entry. It still appears in signals
// and is excluded from lenses; this endpoint (and the boot log) keep the gap
// visible rather than silent, per CortexBackend.md PART 2.
app.get("/admin/unclassified", async (c) => {
  try {
    const unclassified = await findUnclassifiedAssets(db);
    return c.json({ count: unclassified.length, assets: unclassified });
  } catch (err) {
    logger.error("could not read the unclassified list", { err });
    return c.json({ error: "universe table unavailable" }, 503);
  }
});

// --- Public stats -----------------------------------------------------------
// `/api/stats.json` and `/badge/*.svg`: the same overview reading the terminal
// renders, published keyless for anyone to read, chart or embed. It carries its
// own CORS and its own rate-limit bucket, so a hot badge cannot spend the
// terminal's budget.
app.route("/", publicStats);

// --- Shareable Research Cards -----------------------------------------------
// `/api/card/*.json` and `/card/*.png`: one signal, asset-quality read, or lens as a citable
// snapshot plus the Open Graph image a chat client unfurls. Public and keyless
// like the badges, on its own rate-limit bucket because rendering costs more
// than reading a number.
app.route("/", researchCards);

// --- tRPC -------------------------------------------------------------------
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    endpoint: "/trpc",
    // The adapter types createContext as returning a plain record. Ours is a
    // concrete interface built asynchronously (it reads the session cookie), and
    // the router infers its context from trpc.ts anyway.
    createContext: async (opts) =>
      (await createContext(opts)) as unknown as Record<string, unknown>,
    onError({ error, path }) {
      logger.error("trpc procedure failed", { path, code: error.code, err: error.cause ?? error });
    },
  }),
);

// --- Queue ------------------------------------------------------------------
// Development-only proof that the api can produce and the worker can consume.
// It never exists in production, so it needs no auth and no rate limit of its own.
if (isDevelopment) {
  app.post("/dev/ping-job", async (c) => {
    const job = await enqueue("ping", { at: new Date().toISOString() });
    return c.json({ enqueued: true, jobId: job.id });
  });
}

// Cold execution verification can take longer than Bun's 10-second default
// while checking every configured RPC. Keep the connection open for its reply.
const server = Bun.serve({ port: env.PORT, idleTimeout: 60, fetch: app.fetch });

logger.info("cortex-api listening", {
  port: env.PORT,
  chainId: env.RHC_CHAIN_ID,
  // Hosts only. These URLs carry API keys in the path, so the key never reaches
  // a log line, a log shipper or a screenshot.
  rpcEndpoints: MAINNET_RPC_URLS.map(rpcHost),
  logsRpcEndpoints: MAINNET_LOGS_RPC_URLS.map(rpcHost),
});

// Quotes check execution RPC capabilities on every request. Probing them in the
// background keeps that check a cache read instead of a minute-long cold probe.
const executionTargets = defaultRpcCapabilityTargets().execution;
const stopCapabilityRefresh = env.EXECUTION_MODE
  ? startRpcCapabilityRefresh("execution", executionTargets.urls, executionTargets.chainId)
  : () => undefined;

// Report the classification gap once at startup. Non-blocking: an empty or
// unreachable universe table just means there is nothing to report yet.
void logUnclassifiedAssets(db);

installShutdownHandlers([
  // stop(false) closes the listener but lets in-flight requests finish.
  { name: "http", run: async () => void (await server.stop(false)) },
  { name: "rpc-capability-refresh", run: async () => stopCapabilityRefresh() },
  { name: "queues", run: closeQueues },
  { name: "queue-connection", run: closeQueueConnection },
  { name: "redis", run: closeRedis },
  { name: "db", run: closeDb },
]);

// Named, never default. Bun auto-serves a default export that looks like a server
// config, and a Hono app does: `bun src/index.ts` would bind the port a second
// time and die with EADDRINUSE right after the explicit Bun.serve above.
export { app };
