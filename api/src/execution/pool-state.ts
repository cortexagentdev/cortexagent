/** Current, block-pinned state sampling for the verified Uniswap V3 branch. */
import { getAddress, type Address } from "viem";

import { uniswapV3PoolAbi } from "../chain/abis/index.ts";
import { multicallRead, resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { getExecutionContext, type ExecutionContext } from "./context.ts";
import { supportedPoolCandidates, writeCurrentObservation } from "./registry.ts";

export type PoolStateResult = {
  observed: number;
  failed: number;
  blockNumber: bigint;
  blockHash: `0x${string}`;
};

/**
 * Samples all supplied V3 pools at exactly one execution block. `liquidityRaw`
 * is protocol liquidity, not TVL or an executable amount.
 */
export async function sampleExecutionPoolState(
  context: ExecutionContext,
  poolAddresses?: readonly Address[],
): Promise<PoolStateResult> {
  const candidates = await supportedPoolCandidates();
  const wanted = poolAddresses?.map((address) => address.toLowerCase());
  const pools = candidates.filter(
    (pool) => pool.authenticated && (!wanted || wanted.includes(pool.poolAddress)),
  );
  const block = await context.publicClient.getBlock();
  const blockNumber = block.number;
  if (blockNumber === null) throw new Error("execution head has no block number");
  const blockHash = block.hash;
  if (!blockHash) throw new Error("execution head has no block hash");
  const calls = pools.flatMap((pool) => [
    {
      address: getAddress(pool.poolAddress),
      abi: uniswapV3PoolAbi,
      functionName: "slot0",
    } as const,
    {
      address: getAddress(pool.poolAddress),
      abi: uniswapV3PoolAbi,
      functionName: "liquidity",
    } as const,
  ]);
  const results = (await multicallRead(calls, {
    client: context.publicClient,
    blockNumber,
  })) as unknown as MulticallItem<unknown>[];
  let observed = 0;
  let failed = 0;
  await Promise.all(
    pools.map(async (pool, index) => {
      const slot = resultOrUndefined(results[index * 2]!);
      const liquidity = resultOrUndefined(results[index * 2 + 1]!);
      const address = getAddress(pool.poolAddress);
      if (
        !Array.isArray(slot) ||
        typeof slot[0] !== "bigint" ||
        typeof slot[1] !== "number" ||
        typeof liquidity !== "bigint"
      ) {
        failed += 1;
        await writeCurrentObservation({
          poolAddress: address,
          blockNumber,
          blockHash,
          blockTimestamp: block.timestamp,
          status: "read_failed",
          tvlUsd: null,
        });
        return;
      }
      observed += 1;
      const sqrtPriceX96 = slot[0];
      await writeCurrentObservation({
        poolAddress: address,
        blockNumber,
        blockHash,
        blockTimestamp: block.timestamp,
        status: sqrtPriceX96 === 0n ? "uninitialized" : liquidity === 0n ? "empty" : "ok",
        sqrtPriceX96,
        tick: slot[1],
        liquidityRaw: liquidity,
        tvlUsd: null,
      });
    }),
  );
  return { observed, failed, blockNumber, blockHash };
}

export async function sampleCurrentExecutionPoolState(): Promise<PoolStateResult> {
  const context = await getExecutionContext();
  if (!context) throw new Error("execution context is not ready");
  return sampleExecutionPoolState(context);
}
