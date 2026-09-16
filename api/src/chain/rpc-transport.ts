import { createTransport, fallback, http, type EIP1193RequestFn, type Transport } from "viem";

// Only stateless reads can change their preferred endpoint. Filters, writes,
// and log queries retain the configured order even if sent to a read client.
const rotatingMethods = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
  "web3_clientVersion",
]);

interface RpcTransportOptions {
  /** Rotate only the first N endpoints; the rest remain ordered fallbacks. */
  rotationSize?: number;
  retryCount: number;
  retryDelay: number;
  timeout: number;
}

/**
 * Round-robin the explicitly selected read pool, then fail over in order.
 * Logs use a separate, ordered transport. This does not verify endpoint chain
 * identity: execution must verify every endpoint before using this transport.
 */
export function rpcTransport(
  urls: readonly string[],
  { rotationSize = 1, ...options }: RpcTransportOptions,
): Transport {
  if (!Number.isInteger(rotationSize) || rotationSize < 1 || rotationSize > urls.length)
    throw new Error("RPC rotation size must fit the configured endpoint list.");
  if (new Set(urls).size !== urls.length)
    throw new Error("RPC endpoint list must not contain duplicates.");

  const transports = urls.map((url) => http(url, options));
  return (config) => {
    // Each order tries every endpoint at most once (plus bounded HTTP retries).
    // Disable fallback/wrapper retries: retrying the whole pool multiplies load.
    const orders = Array.from({ length: rotationSize }, (_, start) =>
      fallback(
        [
          ...transports.slice(start, rotationSize),
          ...transports.slice(0, start),
          ...transports.slice(rotationSize),
        ],
        { rank: false, retryCount: 0 },
      )(config),
    );
    let next = 0;
    return createTransport({
      key: "rpc-pool",
      name: "Read pool with ordered fallback",
      type: "rpc-pool",
      retryCount: 0,
      request: ((request, requestOptions) => {
        const rotate = rotatingMethods.has(request.method);
        const index = rotate ? next : 0;
        if (rotate) next = (next + 1) % rotationSize;
        return orders[index]!.request(request, requestOptions);
      }) as EIP1193RequestFn,
    });
  };
}
