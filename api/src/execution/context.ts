/** The one boundary between live research and an executable chain state. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type PublicClient,
} from "viem";

import { env } from "../env.ts";
import { rpcTransport } from "../chain/rpc-transport.ts";
import { validatePresetRegistry, type PresetRegistry } from "./preset-manifest.ts";
import { PRESET_RELEASE } from "./vault-accounting.ts";

export type ExecutionMode = "local-fork" | "robinhood-testnet" | "robinhood-mainnet";
export type ReadinessReason =
  | "UNCONFIGURED"
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "RPC_UNAVAILABLE"
  | "WRONG_CHAIN"
  | "WRONG_ENDPOINT"
  | "CODE_MISSING"
  | "BYTECODE_MISMATCH"
  | "GENERATION_MISMATCH";

export interface ExecutionManifest {
  /** Official fixed catalog. Missing/empty means no official deposits or discovery. */
  presets?: PresetRegistry;
  schemaVersion: number;
  deploymentId: string;
  mode: ExecutionMode;
  chainId: number;
  usdg: { address: Address; decimals: number };
  factories: Array<{
    address: Address;
    runtimeHash: `0x${string}`;
    creationBlock?: string;
    creationBlockHash?: `0x${string}`;
    version?: string;
    linkedLibraries?: Record<string, Address>;
    capabilities?: {
      deadlineMint: boolean;
      deadlineRedeem: boolean;
      /** Historical manifests only; the current release has no keeper entry point. */
      deadlineRebalance?: boolean;
      feeMode: "zero" | "legacy";
      feeLedger: "recorded-accounting";
      feePayout: false;
    };
  }>;
  libraries?: Array<{ address: Address; runtimeHash: `0x${string}` }>;
  adapters: Array<{
    address: Address;
    runtimeHash: `0x${string}`;
    routeHash?: `0x${string}`;
    version?: string;
  }>;
  fork?: {
    upstreamChainId: number;
    upstreamBlockNumber: number;
    upstreamBlockHash: `0x${string}`;
    generationId: `0x${string}`;
    marker: { address: Address; value: `0x${string}`; runtimeHash: `0x${string}` };
  };
}

export interface ExecutionReadiness {
  ready: boolean;
  mode: ExecutionMode | null;
  chainId: number | null;
  deploymentId: string | null;
  manifestDigest: `0x${string}` | null;
  walletRpcUrl: string | null;
  explorerUrl: string | null;
  factory: Address | null;
  usdg: Address | null;
  adapters: Address[];
  walletVerification: { address: Address; codeSha256: string } | null;
  reasons: ReadinessReason[];
}

export interface ExecutionContext {
  manifest: ExecutionManifest;
  manifestDigest: `0x${string}`;
  /** Opaque identity of the independently verified provider set. Never URLs or keys.
   * Absent on hand-built contexts, which cannot share evidence across clients. */
  providerIdentity?: string;
  publicClient: PublicClient;
  logsClient: PublicClient;
  readiness: ExecutionReadiness;
}

/**
 * The configuration and manifest identity needed for public metadata reads.
 *
 * This deliberately contains no RPC client and performs no endpoint, chain,
 * bytecode or generation-marker verification. A caller may use it to select
 * already-indexed metadata, but anything that can authorize or build a
 * transaction must continue through `getExecutionContext()`.
 */
export interface ExecutionMetadata {
  manifest: ExecutionManifest;
  manifestDigest: `0x${string}`;
  /** Internal identity used to guard an awaited metadata read. */
  identityKey: string;
}

function expectedChain(mode: ExecutionMode) {
  return mode === "robinhood-mainnet" ? 4663 : 46630;
}

interface ExecutionConfiguration {
  mode: ExecutionMode | undefined;
  manifestPath: string | undefined;
  deploymentId: string | undefined;
  /** Effective copies. A verification never observes later env-array mutation. */
  rpcUrls: readonly string[];
  logsUrls: readonly string[];
  rpcUrlsConfigured: boolean;
  rotationSize: number;
  retryCount: number;
  logsRetryCount: number;
  retryDelayMs: number;
  timeoutMs: number;
  walletRpcUrl: string | undefined;
  /** The legacy execution fallback is part of the configuration identity. */
  fallbackRpcUrl: string;
}

interface ManifestSnapshot {
  manifest: ExecutionManifest;
  digest: `0x${string}`;
}

interface ManifestRead {
  snapshot?: ManifestSnapshot;
  reason?: "MANIFEST_MISSING" | "MANIFEST_INVALID";
  /** Content plus filesystem identity, including invalid contents. */
  evidence: string;
}

interface VerificationRequest {
  config: ExecutionConfiguration;
  manifest: ManifestSnapshot | null;
  reason: ReadinessReason | null;
  /** Exact JSON identity of config plus manifest evidence and validation result. */
  key: string;
}

function captureConfiguration(): ExecutionConfiguration {
  // Compatibility aliases are deliberately local to this migration seam.
  // They are never used for mainnet execution, and a manifest is still required.
  const rpcUrlsConfigured = env.EXECUTION_RPC_URLS !== undefined;
  const rpcUrls = rpcUrlsConfigured
    ? [...env.EXECUTION_RPC_URLS!]
    : env.EXECUTION_MODE
      ? [env.RHC_TESTNET_RPC_URL]
      : [];
  const logsUrls = env.EXECUTION_LOGS_RPC_URLS ? [...env.EXECUTION_LOGS_RPC_URLS] : [...rpcUrls];
  return {
    mode: env.EXECUTION_MODE,
    manifestPath: env.EXECUTION_MANIFEST_PATH,
    deploymentId: env.EXECUTION_DEPLOYMENT_ID,
    rpcUrls,
    logsUrls,
    rpcUrlsConfigured,
    rotationSize: env.EXECUTION_RPC_ROTATION_SIZE,
    retryCount: env.RPC_RETRY_COUNT,
    logsRetryCount: env.RPC_LOGS_RETRY_COUNT,
    retryDelayMs: env.RPC_RETRY_DELAY_MS,
    timeoutMs: env.RPC_TIMEOUT_MS,
    walletRpcUrl: env.EXECUTION_WALLET_RPC_URL,
    fallbackRpcUrl: env.RHC_TESTNET_RPC_URL,
  };
}

function transport(
  endpoints: readonly string[],
  config: ExecutionConfiguration,
  rotationSize = 1,
  logs = false,
) {
  return rpcTransport(endpoints, {
    rotationSize,
    retryCount: logs ? config.logsRetryCount : config.retryCount,
    retryDelay: config.retryDelayMs + Math.floor(Math.random() * (config.retryDelayMs + 1)),
    timeout: config.timeoutMs,
  });
}

function fileEvidence(path: string, digest: string): string {
  try {
    const stat = statSync(path);
    return JSON.stringify({
      digest,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: stat.birthtimeMs,
    });
  } catch {
    return JSON.stringify({ digest, missing: true });
  }
}

function parseManifest(path: string): ManifestRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { reason: "MANIFEST_MISSING", evidence: "missing" };
  }
  const digest = keccak256(toHex(raw));
  const evidence = fileEvidence(path, digest);
  try {
    const value: unknown = JSON.parse(raw);
    const m = value as Partial<ExecutionManifest>;
    if (
      !m ||
      typeof m.schemaVersion !== "number" ||
      typeof m.deploymentId !== "string" ||
      !["local-fork", "robinhood-testnet", "robinhood-mainnet"].includes(m.mode ?? "") ||
      typeof m.chainId !== "number" ||
      !m.usdg ||
      !isAddress(m.usdg.address) ||
      !Array.isArray(m.factories) ||
      !Array.isArray(m.adapters)
    )
      return { reason: "MANIFEST_INVALID", evidence };
    const validContract = (entry: { address: string; runtimeHash: string }) =>
      isAddress(entry.address) && /^0x[\da-fA-F]{64}$/.test(entry.runtimeHash);
    if (
      !m.factories.every(validContract) ||
      !m.adapters.every(validContract) ||
      (m.libraries !== undefined &&
        (!Array.isArray(m.libraries) || !m.libraries.every(validContract)))
    )
      return { reason: "MANIFEST_INVALID", evidence };
    if (m.mode === "local-fork" && (!m.fork || !isAddress(m.fork.marker.address))) {
      return { reason: "MANIFEST_INVALID", evidence };
    }
    if (m.presets) {
      validatePresetRegistry(m.presets);
      if (
        !m.factories.some(
          (factory) =>
            factory.address.toLowerCase() === m.presets!.factory.toLowerCase() &&
            factory.version === PRESET_RELEASE,
        )
      )
        return { reason: "MANIFEST_INVALID", evidence };
    }
    return { snapshot: { manifest: m as ExecutionManifest, digest }, evidence };
  } catch {
    return { reason: "MANIFEST_INVALID", evidence };
  }
}

function bareReadiness(reason: ReadinessReason): ExecutionReadiness {
  return {
    ready: false,
    mode: null,
    chainId: null,
    deploymentId: null,
    manifestDigest: null,
    walletRpcUrl: null,
    explorerUrl: null,
    factory: null,
    usdg: null,
    adapters: [],
    walletVerification: null,
    reasons: [reason],
  };
}

let cached: {
  key: string;
  epoch: number;
  expiresAt: number;
  context: ExecutionContext | null;
  readiness: ExecutionReadiness;
} | null = null;

interface VerificationOutcome {
  context: ExecutionContext | null;
  readiness: ExecutionReadiness;
}

interface PendingVerification {
  token: symbol;
  key: string;
  epoch: number;
  request: VerificationRequest;
  detached: boolean;
  promise: Promise<VerificationOutcome>;
}

let verificationEpoch = 0;
let activeKey: string | null = null;
let pending: PendingVerification | undefined;
let currentReadiness = bareReadiness("UNCONFIGURED");

const readinessFailureReasons = new Set<ReadinessReason>([
  "WRONG_CHAIN",
  "WRONG_ENDPOINT",
  "CODE_MISSING",
  "BYTECODE_MISMATCH",
  "GENERATION_MISMATCH",
]);

/**
 * Verification runs during interactive requests as well as worker startup.
 * Keep a small amount of parallelism here; the shared RPC fetch boundary still
 * enforces the process-wide permit cap and reserves interactive capacity.
 */
const MAX_PARALLEL_VERIFICATION_ENDPOINTS = 2;
const MAX_PARALLEL_VERIFICATION_CONTRACTS = 4;

/** Run independent identity checks with deterministic error propagation. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const errors = new Array<unknown>(items.length);
  let next = 0;

  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        // Wait for all workers so no in-flight RPC is left detached from the
        // verification request, then report the first configured item error.
        errors[index] = error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()),
  );
  const firstError = errors.find((error) => error !== undefined);
  if (firstError !== undefined) throw firstError;
  return results;
}

function classifyVerificationError(error: unknown): ReadinessReason {
  const message = error instanceof Error ? error.message : "";
  return readinessFailureReasons.has(message as ReadinessReason)
    ? (message as ReadinessReason)
    : "RPC_UNAVAILABLE";
}

function requestReadiness(request: VerificationRequest): ExecutionReadiness {
  return bareReadiness(request.reason ?? "RPC_UNAVAILABLE");
}

function captureVerificationRequest(): VerificationRequest {
  const config = captureConfiguration();
  let manifest: ManifestSnapshot | null = null;
  let reason: ReadinessReason | null;
  let evidence = "none";

  if (!config.mode || !config.manifestPath || !config.deploymentId) {
    reason = "UNCONFIGURED";
  } else {
    const read = parseManifest(config.manifestPath);
    evidence = read.evidence;
    manifest = read.snapshot ?? null;
    reason = read.reason ?? null;
    if (
      manifest &&
      (manifest.manifest.mode !== config.mode ||
        manifest.manifest.deploymentId !== config.deploymentId ||
        manifest.manifest.chainId !== expectedChain(manifest.manifest.mode))
    ) {
      reason = "WRONG_ENDPOINT";
    }
  }

  const key = JSON.stringify({
    config: {
      mode: config.mode,
      manifestPath: config.manifestPath,
      deploymentId: config.deploymentId,
      rpcUrls: config.rpcUrls,
      logsUrls: config.logsUrls,
      rpcUrlsConfigured: config.rpcUrlsConfigured,
      rotationSize: config.rotationSize,
      retryCount: config.retryCount,
      logsRetryCount: config.logsRetryCount,
      retryDelayMs: config.retryDelayMs,
      timeoutMs: config.timeoutMs,
      walletRpcUrl: config.walletRpcUrl,
      fallbackRpcUrl: config.fallbackRpcUrl,
    },
    manifestDigest: manifest?.digest ?? null,
    manifestEvidence: evidence,
    reason,
  });
  return { config, manifest, reason, key };
}

/**
 * Read the current, structurally validated manifest identity without doing
 * live execution verification. Public display metadata can use this fast
 * path; transaction and chain-state callers must still use
 * `getExecutionContext()`.
 */
export function getExecutionMetadata(): ExecutionMetadata | null {
  const request = captureVerificationRequest();
  if (request.reason || !request.manifest) return null;
  return {
    manifest: request.manifest.manifest,
    manifestDigest: request.manifest.digest,
    identityKey: request.key,
  };
}

/**
 * Manifest/config changes must invalidate an in-flight metadata response just
 * as they invalidate a verified execution response. This check is synchronous
 * and therefore cheap enough to run immediately after the DB read.
 */
export function isExecutionMetadataCurrent(metadata: ExecutionMetadata): boolean {
  const current = captureVerificationRequest();
  return current.reason === null && current.key === metadata.identityKey;
}

function detachPending(): void {
  if (pending) pending.detached = true;
  pending = undefined;
}

/** Adopt a changed configuration as a new execution generation. */
function adoptRequest(request: VerificationRequest): number {
  if (activeKey !== request.key) {
    activeKey = request.key;
    verificationEpoch++;
    cached = null;
    detachPending();
    currentReadiness = requestReadiness(request);
  }
  return verificationEpoch;
}

function currentRequestFor(entry: PendingVerification): VerificationRequest | null {
  if (entry.detached || activeKey !== entry.key || verificationEpoch !== entry.epoch) return null;
  // The manifest is read again at publication. This catches a replacement at
  // the same path even when no caller explicitly invalidated the context. The
  // filesystem identity also detects A→B→A replacements when the bytes return.
  const current = captureVerificationRequest();
  if (current.key !== entry.key) {
    // A file/config change can happen without another caller. Adopt it here so
    // an executionReadiness waiter cannot report the previous ready state.
    adoptRequest(current);
    return null;
  }
  return current;
}

async function verifyExecution(
  request: VerificationRequest,
  epoch: number,
): Promise<VerificationOutcome> {
  const { config, manifest: parsed } = request;
  if (!parsed) return { context: null, readiness: requestReadiness(request) };
  const { manifest, digest } = parsed;
  let publicClient: PublicClient;
  let logsClient: PublicClient;
  let walletVerification: ExecutionReadiness["walletVerification"];
  try {
    const chain = defineChain({
      id: manifest.chainId,
      name: manifest.mode,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [...config.rpcUrls] } },
    });
    // A mainnet execution manifest must name its own authenticated execution
    // pool; the legacy testnet fallback is never allowed to satisfy it.
    if (manifest.mode === "robinhood-mainnet" && !config.rpcUrlsConfigured)
      throw new Error("WRONG_CHAIN");

    const verifyEndpoint = async (url: string) => {
      const endpoint = createPublicClient({
        chain,
        // These are independent, read-only identity checks. One JSON-RPC
        // envelope avoids paying the provider pacing interval per contract.
        // There is no fallback here: every configured endpoint must pass.
        transport: http(url, {
          batch: { wait: 0, batchSize: 16 },
          retryCount: config.retryCount,
          retryDelay: config.retryDelayMs,
          timeout: config.timeoutMs,
        }),
      });

      // Start chain and code reads together, but publish no context until
      // every check passes. Settle both branches even on failure so no RPC
      // work/rejection is detached from its verification generation.
      const contracts = [
        ...manifest.factories,
        ...manifest.adapters,
        ...(manifest.libraries ?? []),
      ];
      const chainIdRead = endpoint.getChainId();
      const codeReads = mapWithConcurrency(
        contracts,
        MAX_PARALLEL_VERIFICATION_CONTRACTS,
        async (contract) => {
          const code = await endpoint.getCode({ address: getAddress(contract.address) });
          if (!code || code === "0x") throw new Error("CODE_MISSING");
          if (keccak256(code) !== contract.runtimeHash) throw new Error("BYTECODE_MISMATCH");
          return { contract, code };
        },
      );
      const [chainResult, codeResult] = await Promise.allSettled([chainIdRead, codeReads]);
      if (chainResult.status === "rejected") throw chainResult.reason;
      if (chainResult.value !== manifest.chainId) throw new Error("WRONG_CHAIN");
      if (codeResult.status === "rejected") throw codeResult.reason;
      const checkedContracts = codeResult.value;
      if (manifest.fork) {
        // The generation marker check stays after contract checks so a rejected
        // marker request can never become an unobserved promise if a bytecode
        // check fails first. It remains a required independent identity check.
        const markerCode = await endpoint.getCode({
          address: getAddress(manifest.fork.marker.address),
        });
        if (!markerCode || markerCode === "0x") throw new Error("GENERATION_MISMATCH");
        if (keccak256(markerCode) !== manifest.fork.marker.runtimeHash)
          throw new Error("BYTECODE_MISMATCH");
        const marker = await endpoint.readContract({
          address: getAddress(manifest.fork.marker.address),
          abi: [
            {
              type: "function",
              name: "generation",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "bytes32" }],
            },
          ],
          functionName: "generation",
        });
        if (marker !== manifest.fork.marker.value) throw new Error("GENERATION_MISMATCH");
        return {
          address: manifest.fork.marker.address,
          codeSha256: createHash("sha256")
            .update(Buffer.from(markerCode.slice(2), "hex"))
            .digest("hex"),
        } satisfies NonNullable<ExecutionReadiness["walletVerification"]>;
      }
      const factory = checkedContracts.find(({ contract }) => contract === manifest.factories[0]);
      return factory
        ? {
            address: factory.contract.address,
            codeSha256: createHash("sha256")
              .update(Buffer.from(factory.code.slice(2), "hex"))
              .digest("hex"),
          }
        : null;
    };

    // Verify every configured read/log endpoint independently. A fallback must
    // never hide a different chain or a same-chain fork generation. Two
    // endpoints may overlap, while the shared RPC permit pool bounds physical
    // requests alongside the rest of the process.
    const endpoints = [...new Set([...config.rpcUrls, ...config.logsUrls])];
    const endpointVerifications = await mapWithConcurrency(
      endpoints,
      MAX_PARALLEL_VERIFICATION_ENDPOINTS,
      verifyEndpoint,
    );
    walletVerification = endpointVerifications.find((value) => value !== null) ?? null;
    publicClient = createPublicClient({
      chain,
      transport: transport(config.rpcUrls, config, config.rotationSize),
    });
    logsClient = createPublicClient({
      chain,
      transport: transport(config.logsUrls, config, 1, true),
    });
  } catch (error) {
    return {
      context: null,
      readiness: bareReadiness(classifyVerificationError(error)),
    };
  }
  const readiness: ExecutionReadiness = {
    ready: true,
    mode: manifest.mode,
    chainId: manifest.chainId,
    deploymentId: manifest.deploymentId,
    manifestDigest: digest,
    walletRpcUrl: config.walletRpcUrl ?? null,
    explorerUrl:
      manifest.mode === "local-fork"
        ? null
        : manifest.mode === "robinhood-mainnet"
          ? "https://robinhoodchain.blockscout.com"
          : "https://explorer.testnet.chain.robinhood.com",
    factory: manifest.factories[0] ? getAddress(manifest.factories[0].address) : null,
    usdg: getAddress(manifest.usdg.address),
    adapters: manifest.adapters.map((a) => getAddress(a.address)),
    walletVerification,
    reasons: [],
  };
  const providerIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        rpcUrls: config.rpcUrls,
        logsUrls: config.logsUrls,
        rotationSize: config.rotationSize,
        verificationEpoch: epoch,
      }),
    )
    .digest("hex");
  return {
    context: {
      manifest,
      manifestDigest: digest,
      providerIdentity,
      publicClient,
      logsClient,
      readiness,
    },
    readiness,
  };
}

async function settlePending(entry: PendingVerification): Promise<VerificationOutcome> {
  let outcome: VerificationOutcome;
  try {
    outcome = await verifyExecution(entry.request, entry.epoch);
  } catch (error) {
    outcome = { context: null, readiness: bareReadiness(classifyVerificationError(error)) };
  }
  if (!currentRequestFor(entry)) {
    // The caller that started this pass must never receive an executable
    // context from a superseded config, manifest or invalidation generation.
    return { context: null, readiness: currentReadiness };
  }
  if (!outcome.context) {
    // Endpoint recovery must not reuse pre-failure receipt evidence even if the
    // configured provider URLs did not change.
    verificationEpoch++;
    currentReadiness = outcome.readiness;
    cached = {
      key: entry.key,
      epoch: verificationEpoch,
      expiresAt: Date.now() + 5_000,
      context: null,
      readiness: outcome.readiness,
    };
    return outcome;
  }
  currentReadiness = outcome.readiness;
  cached = {
    key: entry.key,
    epoch: entry.epoch,
    expiresAt: Date.now() + 5_000,
    context: outcome.context,
    readiness: outcome.readiness,
  };
  return outcome;
}

/** Reads and verifies the active execution identity. Never substitutes research RPC. */
export async function getExecutionContext(): Promise<ExecutionContext | null> {
  const request = captureVerificationRequest();
  const epoch = adoptRequest(request);
  if (
    cached &&
    cached.key === request.key &&
    cached.epoch === epoch &&
    cached.expiresAt > Date.now()
  )
    return cached.context;
  if (request.reason) {
    const readiness = requestReadiness(request);
    const advance = request.reason !== "UNCONFIGURED";
    if (advance) verificationEpoch++;
    currentReadiness = readiness;
    cached = {
      key: request.key,
      epoch: verificationEpoch,
      expiresAt: Date.now() + 5_000,
      context: null,
      readiness,
    };
    return null;
  }
  if (pending && pending.key === request.key && pending.epoch === epoch && !pending.detached) {
    const entry = pending;
    const outcome = await entry.promise;
    return outcome.context && currentRequestFor(entry) ? outcome.context : null;
  }
  if (pending) detachPending();
  const entry: PendingVerification = {
    token: Symbol("execution-verification"),
    key: request.key,
    epoch,
    request,
    detached: false,
    promise: Promise.resolve({ context: null, readiness: requestReadiness(request) }),
  };
  pending = entry;
  entry.promise = Promise.resolve()
    .then(() => settlePending(entry))
    .finally(() => {
      // An old verification must not clear a newer configuration's pending
      // slot after A→B→A or an explicit reset.
      if (pending === entry) pending = undefined;
    });
  const outcome = await entry.promise;
  return outcome.context && currentRequestFor(entry) ? outcome.context : null;
}

export async function executionReadiness(): Promise<ExecutionReadiness> {
  await getExecutionContext();
  // A configuration/file transition can happen in the microtask between the
  // verification result and this return. Capture and adopt it once more so a
  // caller never receives the prior generation's ready report. A changed valid
  // config is intentionally reported not-ready until its next caller verifies
  // it; that is safer than presenting an unverified last-good context.
  const latest = captureVerificationRequest();
  if (activeKey !== latest.key) adoptRequest(latest);
  return currentReadiness;
}

/** Tests/tools call this after changing provider configuration. */
export function invalidateExecutionContext() {
  verificationEpoch++;
  cached = null;
  detachPending();
  currentReadiness = bareReadiness("RPC_UNAVAILABLE");
}
