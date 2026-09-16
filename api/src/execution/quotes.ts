/** Candidate quotes only: no wallet action, signing, approval, or transaction plan. */
import { getAddress, keccak256, toHex, formatUnits, type Hex, type Address } from "viem";
import tokens from "../../data/execution-tokens.json";
import { stockAbi } from "../chain/abis/stock.ts";
import { aggregatorV3Abi } from "../chain/abis/aggregatorV3.ts";
import {
  ensureExecutionBinding,
  loadVenueSeed,
  supportedPoolCandidates,
  registryStatus,
} from "./registry.ts";
import { encodeV3Path, readV3Pool, quoteV3, type V3Route } from "./quote-v3.ts";
import { multiply, rawAmount, QuoteFailure, type RefusalCode } from "./quote-types.ts";
import { env } from "../env.ts";
import { assertExecutionHead, requireRpcCapabilities } from "../chain/rpc-capabilities.ts";

const WAD = 10n ** 18n;
const BPS = 10000n;
const TTL = 15000;
export const candidateLimitations =
  "Candidate estimate only. USDG is assumed to equal one USD. Wallet/adapter issuer restrictions, full input consumption and sequential shared-pool settlement require whole-transaction simulation in stage 10.";
export type QuotePolicy = {
  toleranceBps: number;
  slippageCapBps: number;
  maxImpactBps: number;
  maxOracleDeviationBps: number;
};
export const defaultQuotePolicy: QuotePolicy = {
  toleranceBps: 50,
  slippageCapBps: 60,
  maxImpactBps: 60,
  maxOracleDeviationBps: 60,
};
export type QuoteRequest = {
  symbol: string;
  direction: "buy" | "sell";
  amountInRaw: string;
  policy?: QuotePolicy;
};
export type TokenMetadata = {
  address: Address;
  decimals: number;
  multiplierRaw: string;
  wholeValueWad: string;
  feed: Address | null;
  feedDecimals: number | null;
  answerRaw: string | null;
  updatedAt: string | null;
};
export type RouteQuote = {
  kind: "candidate";
  deploymentId: string;
  manifestDigest: Hex;
  chainId: number;
  blockNumber: string;
  blockHash: Hex;
  blockTimestamp: string;
  quotedAt: string;
  expiresAt: string;
  adapter: null;
  adapterRuntimeHash: null;
  routeHash: Hex;
  routeHashSchema: "candidate-v1";
  protocolVariant: "uniswap-v3-swaprouter02";
  quoterVersion: "QuoterV2";
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: string;
  expectedOutRaw: string;
  minimumOutRaw: string;
  oracleFloorRaw: string;
  oracleExpectedOutRaw: string;
  priceImpactBps: number;
  oracleDeviationBps: number;
  feePips: number;
  feeAmountRaw: null;
  poolAddresses: Address[];
  encodedPath: Hex;
  metadata: TokenMetadata[];
  metadataRevision: string;
  policy: QuotePolicy;
  human: { input: string; output: string };
  limitations: string;
};
export type QuoteResult =
  | { status: "quoted"; quote: RouteQuote }
  | {
      status: "refused" | "temporarily_unavailable";
      code: RefusalCode;
      message: string;
      estimate?: RouteQuote;
    };

function refusal(error: unknown, fallback: RefusalCode = "POOL_READ_FAILED"): QuoteResult {
  const code = error instanceof QuoteFailure ? error.code : fallback;
  return {
    status: [
      "POOL_READ_FAILED",
      "ORACLE_UNAVAILABLE",
      "DISCOVERY_INCOMPLETE",
      "QUOTE_REORGANIZED",
      "QUOTE_EXPIRED",
    ].includes(code)
      ? "temporarily_unavailable"
      : "refused",
    code,
    message:
      error instanceof QuoteFailure
        ? error.message
        : "Execution snapshot read failed; retry a fresh snapshot. No upstream substitution was made.",
  };
}
function validatePolicy(policy: QuotePolicy) {
  for (const key of [
    "toleranceBps",
    "slippageCapBps",
    "maxImpactBps",
    "maxOracleDeviationBps",
  ] as const)
    if (
      !Number.isInteger(policy[key]) ||
      policy[key] < 0 ||
      policy[key] > 500 ||
      (key === "slippageCapBps" && policy[key] === 0)
    )
      throw new QuoteFailure(
        "INVALID_INPUT",
        "Policy values must be integer bps in 0..500; vault cap must be positive.",
      );
}
const digest = (value: unknown) => keccak256(toHex(JSON.stringify(value)));
const cache = new Map<string, { until: number; result: QuoteResult }>();
const flights = new Map<string, Promise<QuoteResult>>();
const requestFlights = new Map<string, Promise<QuoteResult>>();

/** All calls require the same canonical hash, including fallback transports. */
export async function prepareCandidate(
  symbol: string,
  direction: "buy" | "sell",
  policy = defaultQuotePolicy,
  snapshotBlockHash?: Hex,
) {
  policy = { ...policy };
  validatePolicy(policy);
  if (direction !== "buy" && direction !== "sell")
    throw new QuoteFailure("INVALID_INPUT", "Direction must be buy or sell.");
  const stock = tokens.stocks.find((item) => item.symbol === symbol);
  if (!stock)
    throw new QuoteFailure(
      "TOKEN_TRANSFER_UNSUPPORTED",
      "Token is outside the reviewed stock subset.",
    );
  const context = await ensureExecutionBinding().catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("Execution binding mismatch"))
      throw new QuoteFailure(
        "DEPLOYMENT_MISMATCH",
        "Database belongs to another execution deployment.",
      );
    throw error;
  });
  const deploymentId = context.manifest.deploymentId;
  const manifestDigest = context.manifestDigest;
  const client = context.publicClient;
  const executionUrls = env.EXECUTION_RPC_URLS ?? [];
  try {
    await requireRpcCapabilities("execution", executionUrls, context.manifest.chainId, [
      "latest",
      "historical",
      "multicall",
      "simulation",
    ]);
    await assertExecutionHead(executionUrls, context.manifest.chainId);
  } catch (error) {
    throw new QuoteFailure(
      "POOL_READ_FAILED",
      error instanceof Error
        ? error.message
        : "Execution RPC capabilities are unavailable; no fresh quote was issued.",
    );
  }
  if ((await client.getChainId()) !== context.manifest.chainId)
    throw new QuoteFailure(
      "WRONG_EXECUTION_CHAIN",
      "RPC chain differs from the execution manifest.",
    );
  const usdg = getAddress(context.manifest.usdg.address);
  const venue = loadVenueSeed().venues[0]!;
  const stockAddress = getAddress(stock.address);
  const pools = await supportedPoolCandidates();
  const candidate = pools.find(
    (pool) =>
      pool.authenticated &&
      pool.venueName === venue.name &&
      pool.factory === venue.factory.toLowerCase() &&
      [pool.token0, pool.token1].includes(stock.address) &&
      [pool.token0, pool.token1].includes(usdg.toLowerCase()) &&
      venue.pools.some(
        (p) => p.address.toLowerCase() === pool.poolAddress && p.feePips === pool.feePips,
      ),
  );
  if (!candidate) {
    if (
      pools.some(
        (pool) =>
          !pool.authenticated &&
          [pool.token0, pool.token1].includes(stock.address) &&
          [pool.token0, pool.token1].includes(usdg.toLowerCase()),
      )
    )
      throw new QuoteFailure(
        "DISCOVERY_INCOMPLETE",
        "A possible route has not been authenticated; absence is not established.",
      );
    const status = await registryStatus();
    if (
      !status.progress.some(
        (p) =>
          p.venueName === venue.name && p.coverageStatus === "complete_for_supported_candidates",
      )
    )
      throw new QuoteFailure(
        "DISCOVERY_INCOMPLETE",
        "Supported candidate discovery is incomplete.",
      );
    throw new QuoteFailure("NO_SUPPORTED_ROUTE", "No authenticated supported route.");
  }
  const route: V3Route = {
    factory: venue.factory,
    router: venue.router,
    quoter: venue.quoter,
    pool: getAddress(candidate.poolAddress),
    tokenIn: direction === "buy" ? usdg : stockAddress,
    tokenOut: direction === "buy" ? stockAddress : usdg,
    feePips: candidate.feePips,
  };
  const started = Date.now();
  const block = await client.getBlock(snapshotBlockHash ? { blockHash: snapshotBlockHash } : {});
  if (block.number === null || !block.hash)
    throw new QuoteFailure("POOL_READ_FAILED", "Execution block is pending.");
  const blockHash = block.hash;
  const pin = { blockHash, requireCanonical: true } as const;
  const pool = await readV3Pool(client, route, blockHash);
  const feed = getAddress(stock.feed);
  let metadata: TokenMetadata[];
  try {
    const [
      stockDecimals,
      usdgDecimals,
      multiplier,
      oraclePaused,
      tokenPaused,
      paused,
      feedDecimals,
      round,
    ] = await Promise.all([
      client.readContract({
        address: stockAddress,
        abi: stockAbi,
        functionName: "decimals",
        ...pin,
      }),
      client.readContract({ address: usdg, abi: stockAbi, functionName: "decimals", ...pin }),
      client.readContract({
        address: stockAddress,
        abi: stockAbi,
        functionName: "uiMultiplier",
        ...pin,
      }),
      client.readContract({
        address: stockAddress,
        abi: stockAbi,
        functionName: "oraclePaused",
        ...pin,
      }),
      client.readContract({
        address: stockAddress,
        abi: stockAbi,
        functionName: "tokenPaused",
        ...pin,
      }),
      client.readContract({ address: stockAddress, abi: stockAbi, functionName: "paused", ...pin }),
      client.readContract({
        address: feed,
        abi: aggregatorV3Abi,
        functionName: "decimals",
        ...pin,
      }),
      client.readContract({
        address: feed,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
        ...pin,
      }),
    ]);
    if (
      tokenPaused ||
      paused ||
      oraclePaused ||
      multiplier === 0n ||
      stockDecimals > 36 ||
      usdgDecimals > 36 ||
      feedDecimals > 36
    )
      throw new QuoteFailure("TOKEN_TRANSFER_UNSUPPORTED", "Paused or unsupported token metadata.");
    if (usdgDecimals !== context.manifest.usdg.decimals)
      throw new QuoteFailure("DEPLOYMENT_MISMATCH", "USDG decimals differ from manifest.");
    if (round[1] <= 0n || round[3] === 0n)
      throw new QuoteFailure("ORACLE_UNAVAILABLE", "Oracle answer or update timestamp is invalid.");
    if (block.timestamp > round[3] && block.timestamp - round[3] > 90000n)
      throw new QuoteFailure("ORACLE_STALE", "Oracle exceeds vault MAX_STALENESS (90000 seconds).");
    const whole = multiply(multiply(round[1], WAD) / 10n ** BigInt(feedDecimals), multiplier) / WAD;
    if (whole === 0n) throw new QuoteFailure("ORACLE_UNAVAILABLE", "Oracle rounds to zero.");
    const stockMeta: TokenMetadata = {
      address: stockAddress,
      decimals: stockDecimals,
      multiplierRaw: multiplier.toString(),
      wholeValueWad: whole.toString(),
      feed,
      feedDecimals,
      answerRaw: round[1].toString(),
      updatedAt: round[3].toString(),
    };
    const usdMeta: TokenMetadata = {
      address: usdg,
      decimals: usdgDecimals,
      multiplierRaw: WAD.toString(),
      wholeValueWad: WAD.toString(),
      feed: null,
      feedDecimals: null,
      answerRaw: null,
      updatedAt: null,
    };
    metadata = direction === "buy" ? [usdMeta, stockMeta] : [stockMeta, usdMeta];
  } catch (error) {
    throw error instanceof QuoteFailure
      ? error
      : new QuoteFailure("ORACLE_UNAVAILABLE", "Execution token/feed snapshot could not be read.");
  }
  const [input, output] = metadata as [TokenMetadata, TokenMetadata];
  const routeHash = digest([
    "candidate-v1",
    venue.protocolVariant,
    route.factory.toLowerCase(),
    route.router.toLowerCase(),
    route.quoter.toLowerCase(),
    route.pool.toLowerCase(),
    encodeV3Path(route).toLowerCase(),
  ]);
  const metadataRevision = digest([tokens.revision, metadata]);
  async function validateSnapshot() {
    if (context.manifest.deploymentId !== deploymentId || context.manifestDigest !== manifestDigest)
      throw new QuoteFailure(
        "DEPLOYMENT_MISMATCH",
        "Execution identity changed during quote calculation.",
      );
    if (Date.now() - started >= TTL)
      throw new QuoteFailure("QUOTE_EXPIRED", "Snapshot exceeded its 15-second lifetime.");
    const canonical = await client.getBlock({ blockNumber: block.number! });
    if (canonical.hash !== blockHash)
      throw new QuoteFailure("QUOTE_REORGANIZED", "Canonical block hash changed.");
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (head > block.number! + 8n || head < block.number!)
      throw new QuoteFailure(
        "QUOTE_EXPIRED",
        "Quote block is outside the eight-block head-distance limit.",
      );
  }
  async function quote(amountInRaw: string): Promise<QuoteResult> {
    try {
      const amount = rawAmount(amountInRaw);
      await validateSnapshot();
      const key = digest([
        context.manifest.deploymentId,
        context.manifestDigest,
        context.manifest.chainId,
        block.number!.toString(),
        blockHash,
        routeHash,
        route.tokenIn,
        route.tokenOut,
        amount.toString(),
        policy,
        metadataRevision,
      ]);
      const hit = cache.get(key);
      if (hit && hit.until > Date.now()) return structuredClone(hit.result);
      const pending = flights.get(key);
      if (pending) return structuredClone(await pending);
      const calculate = async (): Promise<QuoteResult> => {
        try {
          const oracle =
            multiply(
              multiply(amount, BigInt(input.wholeValueWad)),
              10n ** BigInt(output.decimals),
            ) / multiply(BigInt(output.wholeValueWad), 10n ** BigInt(input.decimals));
          if (oracle === 0n)
            throw new QuoteFailure("INSUFFICIENT_AMOUNT", "Oracle output rounds to zero.");
          const result = await quoteV3(client, route, amount, blockHash);
          const out = result[0];
          const ratio = pool.sqrtPriceX96 * pool.sqrtPriceX96;
          const marginal = pool.zeroForOne
            ? (amount * ratio) / (1n << 192n)
            : (amount * (1n << 192n)) / ratio;
          if (!marginal)
            throw new QuoteFailure("INSUFFICIENT_AMOUNT", "Marginal output rounds to zero.");
          // Includes LP fee; conservative total shortfall from the pre-trade spot.
          const shortfall = marginal > out ? marginal - out : 0n;
          const deviation = oracle > out ? oracle - out : out - oracle;
          const oracleFloor = multiply(oracle, BPS - BigInt(policy.slippageCapBps)) / BPS;
          const minimum = multiply(out, BPS - BigInt(policy.toleranceBps)) / BPS;
          if (minimum === 0n || oracleFloor === 0n)
            throw new QuoteFailure("INSUFFICIENT_AMOUNT", "A required minimum rounds to zero.");
          const q: RouteQuote = {
            kind: "candidate",
            deploymentId: context.manifest.deploymentId,
            manifestDigest: context.manifestDigest,
            chainId: context.manifest.chainId,
            blockNumber: block.number!.toString(),
            blockHash,
            blockTimestamp: block.timestamp.toString(),
            quotedAt: new Date().toISOString(),
            expiresAt: new Date(started + TTL).toISOString(),
            adapter: null,
            adapterRuntimeHash: null,
            routeHash,
            routeHashSchema: "candidate-v1",
            protocolVariant: "uniswap-v3-swaprouter02",
            quoterVersion: "QuoterV2",
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            amountInRaw: amount.toString(),
            expectedOutRaw: out.toString(),
            minimumOutRaw: minimum.toString(),
            oracleFloorRaw: oracleFloor.toString(),
            oracleExpectedOutRaw: oracle.toString(),
            priceImpactBps: Number((shortfall * BPS) / marginal),
            oracleDeviationBps: Number((deviation * BPS) / oracle),
            feePips: route.feePips,
            feeAmountRaw: null,
            poolAddresses: [route.pool],
            encodedPath: encodeV3Path(route),
            metadata,
            metadataRevision,
            policy: { ...policy },
            human: {
              input: formatUnits(amount, input.decimals),
              output: formatUnits(out, output.decimals),
            },
            limitations: candidateLimitations,
          };
          await validateSnapshot();
          if (
            out < oracleFloor ||
            shortfall * BPS > marginal * BigInt(policy.maxImpactBps) ||
            deviation * BPS > oracle * BigInt(policy.maxOracleDeviationBps)
          )
            return {
              status: "refused",
              code: "PRICE_OUTSIDE_POLICY",
              message: "DEX impact or oracle deviation/floor exceeds policy.",
              estimate: q,
            };
          return { status: "quoted", quote: q };
        } catch (error) {
          return refusal(error);
        }
      };
      const promise = calculate();
      flights.set(key, promise);
      try {
        const result = await promise;
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(key, {
          until: Math.min(started + TTL, Date.now() + (result.status === "quoted" ? TTL : 1000)),
          result,
        });
        return structuredClone(result);
      } finally {
        flights.delete(key);
      }
    } catch (error) {
      return refusal(error);
    }
  }
  await validateSnapshot();
  return {
    quote,
    metadata: structuredClone(metadata),
    route: structuredClone(route),
    blockNumber: block.number,
    blockHash,
    validateSnapshot,
  };
}

export async function quoteExactInput(request: QuoteRequest): Promise<QuoteResult> {
  const key = digest([
    request.symbol,
    request.direction,
    request.amountInRaw,
    request.policy ?? defaultQuotePolicy,
  ]);
  const existing = requestFlights.get(key);
  if (existing) return structuredClone(await existing);
  const pending = (async () => {
    try {
      rawAmount(request.amountInRaw);
      const snapshot = await prepareCandidate(request.symbol, request.direction, request.policy);
      return await snapshot.quote(request.amountInRaw);
    } catch (error) {
      return refusal(error);
    }
  })();
  requestFlights.set(key, pending);
  try {
    return structuredClone(await pending);
  } finally {
    requestFlights.delete(key);
  }
}

/** At most 12 quotes by default, 16 maximum, never beyond the stated raw bracket. */
export async function probeCandidate(
  snapshot: Awaited<ReturnType<typeof prepareCandidate>>,
  lowerRaw: string,
  upperRaw: string,
  maxProbes = 12,
) {
  let low = rawAmount(lowerRaw),
    high = rawAmount(upperRaw);
  if (low >= high || !Number.isInteger(maxProbes) || maxProbes < 2 || maxProbes > 16)
    throw new QuoteFailure("INVALID_INPUT", "Invalid size bracket or probe count (2..16).");
  const samples: { amountInRaw: string; result: QuoteResult }[] = [];
  let best: RouteQuote | null = null;
  async function sample(amount: bigint) {
    const result = await snapshot.quote(amount.toString());
    samples.push({ amountInRaw: amount.toString(), result });
    if (result.status === "quoted" && (!best || amount > BigInt(best.amountInRaw)))
      best = result.quote;
    return result;
  }
  const bottom = await sample(low),
    top = await sample(high);
  const boundaryFailure = (r: QuoteResult) =>
    r.status === "refused" && ["PRICE_OUTSIDE_POLICY", "INSUFFICIENT_LIQUIDITY"].includes(r.code);
  if (bottom.status === "quoted" && boundaryFailure(top)) {
    while (samples.length < maxProbes && high - low > 1n) {
      const mid = (low + high) / 2n;
      const result = await sample(mid);
      if (result.status === "quoted") low = mid;
      else if (boundaryFailure(result)) high = mid;
      else break;
    }
  }
  await snapshot.validateSnapshot();
  return {
    kind: "candidate" as const,
    description:
      "Largest demonstrated size within the search bracket at this block; not absolute market capacity.",
    lowerRaw,
    upperRaw,
    blockNumber: snapshot.blockNumber.toString(),
    blockHash: snapshot.blockHash,
    best: best as RouteQuote | null,
    samples,
    limitations: candidateLimitations,
  };
}

/** Capacity constrained by each leg, target weights AND current raw holdings. */
export function basketExitEstimate(
  legs: { capacity: RouteQuote; weightBps: number; holdingRaw: string }[],
  policyCeilingWad: string,
) {
  if (!legs.length || legs.reduce((sum, leg) => sum + leg.weightBps, 0) !== 10000)
    throw new QuoteFailure("INVALID_INPUT", "Basket weights must sum to 10000.");
  let ceiling = rawAmount(policyCeilingWad);
  const first = legs[0]!.capacity;
  const seen = new Set<string>();
  let sharedPools = false;
  for (const leg of legs) {
    const q = leg.capacity;
    if (
      !Number.isInteger(leg.weightBps) ||
      leg.weightBps <= 0 ||
      q.deploymentId !== first.deploymentId ||
      q.manifestDigest !== first.manifestDigest ||
      q.blockHash !== first.blockHash ||
      q.metadata[1]!.feed !== null ||
      q.metadata[0]!.feed === null ||
      Date.parse(q.expiresAt) <= Date.now()
    )
      throw new QuoteFailure(
        "INVALID_INPUT",
        "Basket needs fresh stock-to-USDG quotes from one snapshot.",
      );
    const holding = leg.holdingRaw === "0" ? 0n : rawAmount(leg.holdingRaw);
    const amount = holding < BigInt(q.amountInRaw) ? holding : BigInt(q.amountInRaw);
    const value =
      multiply(amount, BigInt(q.metadata[0]!.wholeValueWad)) /
      10n ** BigInt(q.metadata[0]!.decimals);
    const bound = (value * BPS) / BigInt(leg.weightBps);
    if (bound < ceiling) ceiling = bound;
    for (const pool of q.poolAddresses) {
      if (seen.has(pool)) sharedPools = true;
      seen.add(pool);
    }
  }
  return {
    kind: "candidate",
    currentExecutableRedeemUsdWad: ceiling.toString(),
    sharedPools,
    requiresWholeTransactionSimulation: true,
    limitations: candidateLimitations,
  };
}
