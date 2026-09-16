/** QuoterV2 at v3-periphery 0682387198a24c7cd63566a2c58398533860a5d1. */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodePacked,
  getAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
  type Hex,
} from "viem";
import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../chain/abis/uniswapV3.ts";
import { poolAvailability, QuoteFailure } from "./quote-types.ts";

export const quoterV2Abi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
export type V3Route = {
  factory: Address;
  router: Address;
  quoter: Address;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  feePips: number;
};
export const encodeV3Path = (route: V3Route) =>
  encodePacked(["address", "uint24", "address"], [route.tokenIn, route.feePips, route.tokenOut]);

export async function readV3Pool(client: PublicClient, route: V3Route, blockHash: Hex) {
  const pin = { blockHash, requireCanonical: true } as const;
  // Stage-01 code fingerprints, not merely familiar addresses on a chain ID.
  await Promise.all(
    (
      [
        [route.factory, "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739"],
        [route.router, "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc"],
        [route.quoter, "0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28"],
      ] as const
    ).map(async ([address, expected]) => {
      const code = await client.getCode({ address, ...pin });
      if (!code || keccak256(code) !== expected)
        throw new QuoteFailure(
          "DEPLOYMENT_MISMATCH",
          "Verified V3 runtime fingerprint differs at the quote block.",
        );
    }),
  );
  const address = await client.readContract({
    address: route.factory,
    abi: uniswapV3FactoryAbi,
    functionName: "getPool",
    args: [route.tokenIn, route.tokenOut, route.feePips],
    ...pin,
  });
  if (address === zeroAddress)
    throw new QuoteFailure(
      "NO_SUPPORTED_ROUTE",
      "Verified factory returned no pool for this pair and fee.",
    );
  if (getAddress(address) !== route.pool)
    throw new QuoteFailure(
      "DEPLOYMENT_MISMATCH",
      "Factory pool differs from the authenticated route.",
    );
  const [factory, token0, token1, fee, slot, liquidity] = await Promise.all([
    client.readContract({ address, abi: uniswapV3PoolAbi, functionName: "factory", ...pin }),
    client.readContract({ address, abi: uniswapV3PoolAbi, functionName: "token0", ...pin }),
    client.readContract({ address, abi: uniswapV3PoolAbi, functionName: "token1", ...pin }),
    client.readContract({ address, abi: uniswapV3PoolAbi, functionName: "fee", ...pin }),
    client.readContract({ address, abi: uniswapV3PoolAbi, functionName: "slot0", ...pin }),
    client.readContract({ address, abi: uniswapV3PoolAbi, functionName: "liquidity", ...pin }),
  ]);
  const ordered = [route.tokenIn.toLowerCase(), route.tokenOut.toLowerCase()].sort();
  if (
    factory.toLowerCase() !== route.factory.toLowerCase() ||
    token0.toLowerCase() !== ordered[0] ||
    token1.toLowerCase() !== ordered[1] ||
    fee !== route.feePips
  )
    throw new QuoteFailure(
      "DEPLOYMENT_MISMATCH",
      "Pool factory/token order/fee authentication failed.",
    );
  poolAvailability(slot[0], liquidity);
  if (!slot[6]) throw new QuoteFailure("SIMULATION_REVERTED", "Pool is locked.");
  return {
    sqrtPriceX96: slot[0],
    liquidity,
    zeroForOne: route.tokenIn.toLowerCase() === token0.toLowerCase(),
  };
}

export async function quoteV3(
  client: PublicClient,
  route: V3Route,
  amountIn: bigint,
  blockHash: Hex,
) {
  if (amountIn >= 1n << 255n)
    throw new QuoteFailure("INVALID_INPUT", "QuoterV2 input exceeds int256.");
  const { result } = await client
    .simulateContract({
      address: route.quoter,
      abi: quoterV2Abi,
      functionName: "quoteExactInput",
      args: [encodeV3Path(route), amountIn],
      blockHash,
      requireCanonical: true,
    })
    .catch((error: unknown) => {
      if (
        error instanceof BaseError &&
        error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof
          ContractFunctionRevertedError
      )
        throw new QuoteFailure(
          "SIMULATION_REVERTED",
          "QuoterV2 reverted; this is not proof of an absent pool.",
        );
      throw error;
    });
  if (result[0] === 0n)
    throw new QuoteFailure("INSUFFICIENT_AMOUNT", "Input produces zero output.");
  // QuoterV2 does not report consumed input. A price-limit hit can be partial.
  if (
    result[1].length !== 1 ||
    result[1][0]! <= 4295128740n ||
    result[1][0]! >= 1461446703485210103287273052203988822378723970341n
  )
    throw new QuoteFailure(
      "INSUFFICIENT_LIQUIDITY",
      "Swap reached the V3 price limit; full input consumption is unproven.",
    );
  return result;
}
