import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { ThemeProposalBasket } from "../db/schema.ts";
import { PRESET_CATALOG_HASH, PRESET_SLUGS, presetId } from "./preset-catalog.ts";
import type { PresetRegistry } from "./preset-manifest.ts";
import { encodePresetDeployment } from "./shared-lenses.ts";

export interface PresetPlan {
  schemaVersion: 1;
  chainId: number;
  deploymentId: string;
  factory: Address;
  deployer: Address;
  catalogHash: Hex;
  entries: { slug: string; id: Hex; basket: ThemeProposalBasket; data: Hex }[];
}

export const presetPlanHash = (plan: PresetPlan) =>
  keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "uint256 chainId, bytes32 deploymentIdHash, address factory, address deployer, bytes32 catalogHash, bytes32[] ids, bytes32[] calldataHashes",
      ),
      [
        BigInt(plan.chainId),
        keccak256(toHex(plan.deploymentId)),
        plan.factory,
        plan.deployer,
        plan.catalogHash,
        plan.entries.map((entry) => entry.id),
        plan.entries.map((entry) => keccak256(entry.data)),
      ],
    ),
  );

/** A resumed run uses the original policies, never reconstructs already-used
 * slots from today's liquidity. Every entry is committed before the first send. */
export function validatePresetPlan(
  plan: PresetPlan,
  registry: PresetRegistry,
  chainId: number,
  deploymentId: string,
): void {
  if (
    plan.schemaVersion !== 1 ||
    plan.chainId !== chainId ||
    plan.deploymentId !== deploymentId ||
    plan.factory.toLowerCase() !== registry.factory.toLowerCase() ||
    plan.deployer.toLowerCase() !== registry.deployer.toLowerCase() ||
    plan.catalogHash !== PRESET_CATALOG_HASH ||
    plan.entries.length !== PRESET_SLUGS.length
  )
    throw new Error("Bootstrap plan identity/catalog mismatch");
  for (const [index, entry] of plan.entries.entries()) {
    if (
      entry.slug !== PRESET_SLUGS[index] ||
      entry.id !== presetId(entry.slug) ||
      entry.basket.slug !== entry.slug ||
      entry.basket.factory?.toLowerCase() !== plan.factory.toLowerCase() ||
      entry.basket.creatorFeeBps !== 0 ||
      entry.data !== encodePresetDeployment(entry.basket, plan.deployer)
    )
      throw new Error(`Invalid frozen bootstrap policy: ${entry.slug}`);
  }
}
