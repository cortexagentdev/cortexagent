import { maxUint256 } from "viem";

export type RefusalCode =
  | "INVALID_INPUT"
  | "NO_SUPPORTED_ROUTE"
  | "DISCOVERY_INCOMPLETE"
  | "INSUFFICIENT_LIQUIDITY"
  | "INSUFFICIENT_AMOUNT"
  | "POOL_UNINITIALIZED"
  | "POOL_READ_FAILED"
  | "QUOTE_EXPIRED"
  | "QUOTE_REORGANIZED"
  | "ORACLE_UNAVAILABLE"
  | "ORACLE_STALE"
  | "PRICE_OUTSIDE_POLICY"
  | "WRONG_EXECUTION_CHAIN"
  | "DEPLOYMENT_MISMATCH"
  | "TOKEN_TRANSFER_UNSUPPORTED"
  | "UNSUPPORTED_PROTOCOL"
  | "SIMULATION_REVERTED";

export class QuoteFailure extends Error {
  constructor(
    public readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export function rawAmount(value: string): bigint {
  if (typeof value !== "string" || value.length > 78 || !/^[0-9]+$/.test(value))
    throw new QuoteFailure("INVALID_INPUT", "Amount must be an unsigned decimal uint256 string.");
  const amount = BigInt(value);
  if (amount === 0n) throw new QuoteFailure("INSUFFICIENT_AMOUNT", "Amount must be positive.");
  if (amount > maxUint256) throw new QuoteFailure("INVALID_INPUT", "Amount overflows uint256.");
  return amount;
}

/** Reproduce Solidity checked multiplication, including intermediate overflow. */
export function multiply(a: bigint, b: bigint): bigint {
  const result = a * b;
  if (result > maxUint256)
    throw new QuoteFailure("INVALID_INPUT", "Vault conversion overflows uint256.");
  return result;
}

export function poolAvailability(sqrtPrice: bigint, liquidity: bigint) {
  if (sqrtPrice === 0n)
    throw new QuoteFailure("POOL_UNINITIALIZED", "Pool price is uninitialized.");
  if (liquidity === 0n)
    throw new QuoteFailure("INSUFFICIENT_LIQUIDITY", "Pool has no active liquidity.");
}
