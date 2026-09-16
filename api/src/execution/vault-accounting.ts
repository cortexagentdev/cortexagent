import { erc20Abi, getAddress } from "viem";
import { keylessVaultAbi } from "../chain/abis/index.ts";

export const CLAIMS_RELEASE = "claims-v4-zero-fee-v1";
export const STATIC_RELEASE = "static-v5-zero-fee-v1";
export const PRESET_RELEASE = "preset-v6-zero-fee-v1";

export function supportsDeferredClaims(row: { factoryVersion: string | null }) {
  return [CLAIMS_RELEASE, STATIC_RELEASE, PRESET_RELEASE].includes(row.factoryVersion ?? "");
}

/** Never count an exited holder's reserved assets as circulating-share backing. */
export function vaultBalanceCall(
  row: { factoryVersion: string | null; vault: string },
  token: string,
  index: number,
) {
  return supportsDeferredClaims(row)
    ? ({
        address: getAddress(row.vault),
        abi: keylessVaultAbi,
        functionName: "activeBalance",
        args: [BigInt(index)],
      } as const)
    : ({
        address: getAddress(token),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(row.vault)],
      } as const);
}
