import { createPublicClient, defineChain, http, type PublicClient } from "viem";

import { env } from "../env.ts";
import { rpcTransport } from "./rpc-transport.ts";

/**
 * Robinhood Chain mainnet. An Arbitrum Orbit L2, chain id 4663.
 *
 * This is the C1 data chain. Every terminal read targets it (locked decision 6).
 */
export const rhcMainnet = defineChain({
  id: env.RHC_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env.RHC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "RHC Explorer", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/**
 * Robinhood Chain testnet, chain id 46630.
 *
 * C2 ships to testnet only, so the vault writes in BE-26 target this chain and
 * nothing else does (locked decision 5). C1 never reads from it.
 */
export const rhcTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env.RHC_TESTNET_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "RHC Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/**
 * An endpoint's host, for logs.
 *
 * A keyed URL carries its API key in the path, so the full URL must never reach
 * a log line, a log shipper or a screenshot. The host alone still answers the
 * only question a log needs to: which provider served this.
 */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** General reads rotate the configured prefix, then try ordered fallbacks. */
export const MAINNET_RPC_URLS: readonly string[] =
  env.RHC_RPC_URLS && env.RHC_RPC_URLS.length > 0 ? env.RHC_RPC_URLS : [env.RHC_RPC_URL];

/**
 * Mainnet endpoints for `eth_getLogs`, best first.
 *
 * Separate from the list above on purpose: a free Alchemy key is fast for calls
 * and refuses any log query wider than 10 blocks, so the ranking inverts for
 * this one method. The recommended free order is Validation Cloud, public
 * Robinhood, then Alchemy: the first two have been observed to answer wider
 * filters, while free Alchemy is useful as a bounded fallback for small
 * ranges. See `RHC_LOGS_RPC_URLS` in `env.ts` for the measurements.
 */
export const MAINNET_LOGS_RPC_URLS: readonly string[] =
  env.RHC_LOGS_RPC_URLS && env.RHC_LOGS_RPC_URLS.length > 0
    ? env.RHC_LOGS_RPC_URLS
    : [env.RHC_RPC_URL];

function transport(urls: readonly string[], rotationSize = 1, retryCount = env.RPC_RETRY_COUNT) {
  return rpcTransport(urls, {
    rotationSize,
    retryCount,
    retryDelay: env.RPC_RETRY_DELAY_MS + Math.floor(Math.random() * (env.RPC_RETRY_DELAY_MS + 1)),
    timeout: env.RPC_TIMEOUT_MS,
  });
}

/**
 * The mainnet read client. Batching is still not optional (see `multicall.ts`):
 * rotation distributes requests, it does not create provider quota.
 */
export const publicClient: PublicClient = createPublicClient({
  chain: rhcMainnet,
  transport: transport(MAINNET_RPC_URLS, env.RHC_RPC_ROTATION_SIZE),
});

/**
 * The mainnet client for log queries. Every `eth_getLogs` call in the product
 * goes through this one, never `publicClient`.
 */
export const logsClient: PublicClient = createPublicClient({
  chain: rhcMainnet,
  transport: transport(MAINNET_LOGS_RPC_URLS, 1, env.RPC_LOGS_RETRY_COUNT),
});

/** The testnet read client. Vault tasks only. */
export const testnetPublicClient: PublicClient = createPublicClient({
  chain: rhcTestnet,
  transport: http(env.RHC_TESTNET_RPC_URL),
});

/**
 * Transitional execution clients. Their endpoints come only from execution
 * configuration (or the documented legacy execution alias), never from the
 * mainnet research clients above. `getExecutionContext()` performs the
 * manifest/generation verification before an executable plan is issued.
 */
const executionMode = env.EXECUTION_MODE ?? "robinhood-testnet";
export const executionChain = defineChain({
  id: executionMode === "robinhood-mainnet" ? 4663 : 46630,
  name: executionMode,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: env.EXECUTION_RPC_URLS ?? [env.RHC_TESTNET_RPC_URL] } },
});
export const executionPublicClient: PublicClient = createPublicClient({
  chain: executionChain,
  transport: transport(
    env.EXECUTION_RPC_URLS ?? [env.RHC_TESTNET_RPC_URL],
    env.EXECUTION_RPC_ROTATION_SIZE,
  ),
});
export const executionLogsClient: PublicClient = createPublicClient({
  chain: executionChain,
  transport: transport(
    env.EXECUTION_LOGS_RPC_URLS ?? env.EXECUTION_RPC_URLS ?? [env.RHC_TESTNET_RPC_URL],
    1,
    env.RPC_LOGS_RETRY_COUNT,
  ),
});
