/**
 * The chain layer. Every on-chain read in this codebase enters here.
 *
 * Reads go through `multicallRead`, never through a per-asset `readContract`
 * loop: the RPC is a free public endpoint and a naive loop is ~500 requests per
 * cycle against ~4 batched (locked decision 7).
 */
export * from "./addresses.ts";
export * from "./abis/index.ts";
export { publicClient, testnetPublicClient, rhcMainnet, rhcTestnet } from "./client.ts";
export {
  multicallRead,
  isSuccess,
  resultOrUndefined,
  zipSuccesses,
  countFailures,
  DEFAULT_BATCH_SIZE,
  type MulticallItem,
  type MulticallOptions,
} from "./multicall.ts";
