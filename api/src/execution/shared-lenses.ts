import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbiParameters,
} from "viem";
import { themeFactoryAbi } from "../chain/abis/keylessVault.ts";
import type { ThemeProposalRecord, ThemeTokenRecord } from "../db/schema.ts";
import { STATIC_RELEASE } from "./vault-accounting.ts";

/** Preset identity is the catalog slug, NOT a stock-combination hash. A changed
 * market/eligibility snapshot must not create another copy of a shared lens.
 * Future custom proposals must omit this server-owned marker. */
export function predefinedLensKey(slug: string): string {
  return `${STATIC_RELEASE}:${slug}`;
}

// KeylessVault.ThemePolicy, checked against the compiled constructor in the
// security regressions. Includes every immutable field, including the ceiling.
export const sharedVaultPolicyAbi = parseAbiParameters(
  "(address themeToken, address usdg, address creator, address[] constituents, address[] feeds, uint256[] targetWeightsBps, uint256[] capsBps, uint256 creatorFeeBps, uint256 mintRedeemBandBps, uint256 slippageCapBps, uint256 maxRedeemUsd, address[] allowedVenues)",
);

export function approvedVaultPolicyHash(
  token: string,
  proposal: Pick<ThemeProposalRecord, "creator" | "basket">,
) {
  const { basket } = proposal;
  if (!basket.usdg) throw new Error("Missing settlement token");
  return keccak256(
    encodeAbiParameters(sharedVaultPolicyAbi, [
      {
        themeToken: getAddress(token),
        usdg: getAddress(basket.usdg),
        creator: getAddress(proposal.creator),
        constituents: basket.constituents.map((c) => getAddress(c.tokenAddress)),
        feeds: basket.constituents.map((c) => getAddress(c.feed)),
        targetWeightsBps: basket.constituents.map((c) => BigInt(c.weightBps)),
        capsBps: basket.constituents.map((c) => BigInt(c.capBps)),
        creatorFeeBps: BigInt(basket.creatorFeeBps),
        mintRedeemBandBps: BigInt(basket.mintRedeemBandBps),
        slippageCapBps: BigInt(basket.slippageCapBps),
        maxRedeemUsd: BigInt(basket.maxRedeemUsdWad),
        allowedVenues: basket.venues.map((venue) => getAddress(venue)),
      },
    ]),
  );
}

/** Exact unsigned factory calldata, shared by bootstrap and receipt verification. */
export function encodePresetDeployment(basket: ThemeProposalRecord["basket"], creator: string) {
  if (!basket.usdg || !basket.factory) throw new Error("Incomplete preset deployment policy");
  return encodeFunctionData({
    abi: themeFactoryAbi,
    functionName: "deployTheme",
    args: [
      {
        slug: basket.slug,
        name: basket.tokenName,
        symbol: basket.tokenSymbol,
        decimals: basket.decimals,
        creator: getAddress(creator),
        usdg: getAddress(basket.usdg),
        constituents: basket.constituents.map((c) => getAddress(c.tokenAddress)),
        feeds: basket.constituents.map((c) => getAddress(c.feed)),
        targetWeightsBps: basket.constituents.map((c) => BigInt(c.weightBps)),
        capsBps: basket.constituents.map((c) => BigInt(c.capBps)),
        creatorFeeBps: BigInt(basket.creatorFeeBps),
        mintRedeemBandBps: BigInt(basket.mintRedeemBandBps),
        slippageCapBps: BigInt(basket.slippageCapBps),
        maxRedeemUsd: BigInt(basket.maxRedeemUsdWad),
        allowedVenues: basket.venues.map((venue) => getAddress(venue)),
      },
    ],
  });
}

export interface SharedLensScope {
  slug: string;
  chainId: number;
  deploymentId: string;
  factory: string;
}

/** A permissionless slug, creator-supplied broadcast hash, or "canonical" chain
 * flag alone is NOT authority to promote a vault to a predefined shared lens.
 * Match the factory event's policy hash to an immutable server-built revision.
 * No current price/depth comparison: an existing policy stays frozen. */
export function isSharedLensCandidate(
  vault: ThemeTokenRecord,
  proposal: ThemeProposalRecord,
  scope: SharedLensScope,
): boolean {
  const { basket } = proposal;
  if (
    !vault.canonical ||
    vault.status !== "deployed" ||
    vault.executionCompatibility !== "verified" ||
    vault.factoryVersion !== STATIC_RELEASE ||
    vault.chainId !== scope.chainId ||
    proposal.chainId !== scope.chainId ||
    vault.executionDeploymentId !== scope.deploymentId ||
    proposal.executionDeploymentId !== scope.deploymentId ||
    vault.factoryAddress?.toLowerCase() !== scope.factory.toLowerCase() ||
    basket.factory?.toLowerCase() !== scope.factory.toLowerCase() ||
    vault.theme !== scope.slug ||
    proposal.theme !== scope.slug ||
    basket.slug !== scope.slug ||
    basket.predefinedLensKey !== predefinedLensKey(scope.slug) ||
    proposal.status === "draft" ||
    vault.creator.toLowerCase() !== proposal.creator.toLowerCase() ||
    basket.creatorFeeBps !== 0 ||
    vault.creatorFeeBps !== 0 ||
    vault.spec.name !== basket.tokenName ||
    vault.spec.symbol !== basket.tokenSymbol ||
    vault.spec.decimals !== basket.decimals
  )
    return false;
  try {
    return approvedVaultPolicyHash(vault.id, proposal) === vault.spec.policyHash.toLowerCase();
  } catch {
    // A malformed or historical revision is never a shared-vault endorsement.
    return false;
  }
}
