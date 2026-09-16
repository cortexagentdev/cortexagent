/**
 * Dev script. Proves the BE-3 acceptance criteria against live RHC mainnet.
 *
 *   bun run chain:check
 *
 * Needs `api/.env` (copy `.env.example`; any non-empty JWT_SECRET will do, this
 * script touches neither Postgres nor Redis) and network access to
 * `rpc.mainnet.chain.robinhood.com`.
 *
 * It wraps `globalThis.fetch` to count JSON-RPC requests, because "one request"
 * is the whole point of the layer and an assertion nobody can eyeball. Every
 * address it uses is discovered at runtime from the free sources (locked
 * decision 7), never hardcoded, so the script keeps working as Robinhood lists
 * new names.
 *
 * Not shipped code and not a test. It is the reproduction of a measurement.
 */

import { getAddress, type Address, type Hex } from "viem";

import { STOCK_FACTORY_ADDRESS, ZERO_ADDRESS } from "./addresses.ts";
import { stockAbi, stockFactoryAbi, aggregatorV3Abi, poolAbi } from "./abis/index.ts";
import { publicClient } from "./client.ts";
import { countFailures, multicallRead } from "./multicall.ts";
import { env } from "../env.ts";

/** Chainlink's public reference directory for RHC. Dev discovery only. */
const CHAINLINK_DIRECTORY_URL =
  "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

const SAMPLE_SIZE = 10;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
}

// --- RPC request counter ----------------------------------------------------

const rpcHost = new URL(env.RHC_RPC_URL).host;
const realFetch = globalThis.fetch;
let rpcRequests = 0;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).host === rpcHost) rpcRequests += 1;
  return realFetch(input, init);
}) as typeof fetch;

function countingRequests<T>(fn: () => Promise<T>): Promise<{ value: T; requests: number }> {
  const before = rpcRequests;
  return fn().then((value) => ({ value, requests: rpcRequests - before }));
}

// --- Discovery, from the free sources ---------------------------------------

interface RhjAsset {
  id: Hex;
  tokenSymbol: string;
  status: string;
  deployments: { contractAddress: Address; chainId: number }[];
}

async function fetchStockTokens(
  limit: number,
): Promise<{ uid: Hex; address: Address; symbol: string }[]> {
  const response = await realFetch(`${env.RHJ_BASE_URL}/assets`);
  if (!response.ok) throw new Error(`/rhj/assets returned ${response.status}`);
  const body = (await response.json()) as { assets: RhjAsset[] };

  return body.assets
    .filter((asset) => asset.status === "ASSET_STATUS_ACTIVE")
    .flatMap((asset) => {
      const deployment = asset.deployments.find((d) => d.chainId === env.RHC_CHAIN_ID);
      if (!deployment) return [];
      return [
        {
          uid: asset.id,
          address: getAddress(deployment.contractAddress),
          symbol: asset.tokenSymbol,
        },
      ];
    })
    .slice(0, limit);
}

async function fetchChainlinkFeeds(limit: number): Promise<{ name: string; address: Address }[]> {
  const response = await realFetch(CHAINLINK_DIRECTORY_URL);
  if (!response.ok) throw new Error(`Chainlink directory returned ${response.status}`);
  const body = (await response.json()) as { name: string; proxyAddress: string | null }[];

  // The directory also carries crypto feeds (LINK, WEETH, BTC.B). Only the
  // "Robinhood " names are equity feeds over a Stock Token, which is what this
  // product prices against.
  return body
    .filter((feed): feed is { name: string; proxyAddress: string } => Boolean(feed.proxyAddress))
    .filter((feed) => feed.name.startsWith("Robinhood "))
    .map((feed) => ({ name: feed.name, address: getAddress(feed.proxyAddress) }))
    .slice(0, limit);
}

// --- The checks -------------------------------------------------------------

async function main(): Promise<void> {
  const chainId = await publicClient.getChainId();
  say(`chain ${chainId} via ${env.RHC_RPC_URL}\n`);

  const tokens = await fetchStockTokens(SAMPLE_SIZE);
  const feeds = await fetchChainlinkFeeds(SAMPLE_SIZE);
  say(`discovered ${tokens.length} Stock Tokens and ${feeds.length} Chainlink feeds\n`);

  // 1 · uiMultiplier() for 10 Stock Tokens in one request.
  const multipliers = await countingRequests(() =>
    multicallRead(
      tokens.map((token) => ({
        address: token.address,
        abi: stockAbi,
        functionName: "uiMultiplier",
      })),
      { client: publicClient, batchSize: 0 },
    ),
  );
  const multiplierValues = multipliers.value
    .map((item, i) => `${tokens[i]?.symbol}=${item.status === "success" ? item.result : "revert"}`)
    .join(" ");
  check(
    `uiMultiplier() x ${tokens.length} in one request`,
    multipliers.requests === 1 && countFailures(multipliers.value) === 0,
    `${multipliers.requests} RPC request(s), ${countFailures(multipliers.value)} failure(s): ${multiplierValues}`,
  );

  // 2 · latestRoundData() and decimals() for 10 feeds in one request.
  const feedReads = await countingRequests(() =>
    multicallRead(
      feeds.flatMap((feed) => [
        { address: feed.address, abi: aggregatorV3Abi, functionName: "latestRoundData" } as const,
        { address: feed.address, abi: aggregatorV3Abi, functionName: "decimals" } as const,
      ]),
      { client: publicClient, batchSize: 0 },
    ),
  );
  check(
    `latestRoundData() + decimals() x ${feeds.length} in one request`,
    feedReads.requests === 1 && countFailures(feedReads.value) === 0,
    `${feedReads.requests} RPC request(s) for ${feeds.length * 2} calls, ${countFailures(feedReads.value)} failure(s)`,
  );

  // 3 · The factory is fail-closed: an unknown uid resolves to address(0),
  //     and a known uid resolves to the address the REST source reports.
  const unknownUid = `0x${"ab".repeat(32)}` as Hex;
  const known = tokens[0];
  if (!known) throw new Error("no Stock Token discovered, cannot probe the factory");

  const factoryReads = await countingRequests(() =>
    multicallRead(
      [
        {
          address: STOCK_FACTORY_ADDRESS,
          abi: stockFactoryAbi,
          functionName: "tokenAddress",
          args: [unknownUid],
        } as const,
        {
          address: STOCK_FACTORY_ADDRESS,
          abi: stockFactoryAbi,
          functionName: "tokenAddress",
          args: [known.uid],
        } as const,
      ],
      { client: publicClient, batchSize: 0 },
    ),
  );
  const [unknownResult, knownResult] = factoryReads.value;
  check(
    "StockFactory.tokenAddress(unknown uid) is the zero address",
    unknownResult?.status === "success" && unknownResult.result === ZERO_ADDRESS,
    `returned ${unknownResult?.status === "success" ? unknownResult.result : unknownResult?.error?.message}`,
  );
  check(
    `StockFactory.tokenAddress(${known.symbol}) matches the REST address`,
    knownResult?.status === "success" && getAddress(knownResult.result) === known.address,
    `factory ${knownResult?.status === "success" ? knownResult.result : "revert"} vs REST ${known.address}`,
  );

  // 4 · A mixed batch where one call reverts returns per-item failures instead
  //     of throwing. slot0() against a Stock Token is the reverting call.
  const mixed = await countingRequests(() =>
    multicallRead(
      [
        ...tokens.map(
          (token) =>
            ({ address: token.address, abi: stockAbi, functionName: "totalSupplyUI" }) as const,
        ),
        { address: known.address, abi: poolAbi, functionName: "slot0" } as const,
      ],
      { client: publicClient, batchSize: 0 },
    ),
  );
  const mixedFailures = countFailures(mixed.value);
  const lastItem = mixed.value.at(-1);
  check(
    "a mixed batch returns per-item failures and does not throw",
    mixedFailures === 1 && lastItem?.status === "failure",
    `${mixed.value.length} calls, ${mixedFailures} failure(s), ${mixed.requests} RPC request(s)`,
  );

  say(`\ntotal RPC requests: ${rpcRequests}`);
  say(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

await main();
