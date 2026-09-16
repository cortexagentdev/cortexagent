import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { ThemeProposalBasket, ThemeTokenRecord } from "../db/schema.ts";
import { PRESET_CATALOG_HASH, PRESET_SLUGS, presetId } from "./preset-catalog.ts";
import { approvedVaultPolicyHash } from "./shared-lenses.ts";
import { PRESET_RELEASE } from "./vault-accounting.ts";

export interface PresetEntry {
  slug: string;
  id: Hex;
  token: Address;
  vault: Address;
  feeController: Address;
  policyHash: Hex;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  basket: ThemeProposalBasket;
}

export interface PresetRegistry {
  mode: "fixed-presets";
  catalogHash: Hex;
  factory: Address;
  deployer: Address;
  /** Empty while bootstrap is pending. Publication is all-or-nothing. */
  entries: PresetEntry[];
}

const hash = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const address = (value: unknown): value is Address =>
  typeof value === "string" && isAddress(value) && BigInt(value) !== 0n;

/** Fail closed on partial catalogs or altered policy pins. This manifest is an
 * operator-owned artifact, never populated from browser input or generic logs. */
export function validatePresetRegistry(value: PresetRegistry): void {
  if (
    !value ||
    value.mode !== "fixed-presets" ||
    value.catalogHash !== PRESET_CATALOG_HASH ||
    !address(value.factory) ||
    !address(value.deployer) ||
    !Array.isArray(value.entries)
  )
    throw new Error("Invalid preset registry identity");
  if (value.entries.length === 0) return;
  if (value.entries.length !== PRESET_SLUGS.length) throw new Error("Incomplete preset catalog");
  const slugs = new Set<string>();
  const addresses = new Set<string>();
  for (const entry of value.entries) {
    if (
      !entry ||
      !PRESET_SLUGS.includes(entry.slug) ||
      slugs.has(entry.slug) ||
      entry.id !== presetId(entry.slug) ||
      ![entry.token, entry.vault, entry.feeController].every(address) ||
      !hash(entry.policyHash) ||
      !hash(entry.transactionHash) ||
      !hash(entry.blockHash) ||
      !/^\d+$/.test(entry.blockNumber) ||
      !Number.isSafeInteger(Number(entry.blockNumber)) ||
      !entry.basket ||
      entry.basket.slug !== entry.slug ||
      entry.basket.factory?.toLowerCase() !== value.factory.toLowerCase() ||
      entry.basket.creatorFeeBps !== 0 ||
      approvedVaultPolicyHash(entry.token, { creator: value.deployer, basket: entry.basket }) !==
        entry.policyHash
    )
      throw new Error(`Invalid preset entry: ${entry?.slug ?? "unknown"}`);
    slugs.add(entry.slug);
    for (const item of [entry.token, entry.vault, entry.feeController]) {
      const key = item.toLowerCase();
      if (addresses.has(key)) throw new Error("Duplicate preset contract address");
      addresses.add(key);
    }
  }
}

export function pendingPresetRegistry(factory: Address, deployer: Address): PresetRegistry {
  return {
    mode: "fixed-presets",
    catalogHash: PRESET_CATALOG_HASH,
    factory: getAddress(factory),
    deployer: getAddress(deployer),
    entries: [],
  };
}

export function matchesRegisteredPreset(
  row: ThemeTokenRecord,
  entry: PresetEntry,
  registry: PresetRegistry,
  chainId: number,
  deploymentId: string,
): boolean {
  const basket = entry.basket;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a).toLowerCase() === JSON.stringify(b).toLowerCase();
  return (
    row.canonical &&
    row.status === "deployed" &&
    row.executionCompatibility === "verified" &&
    row.factoryVersion === PRESET_RELEASE &&
    row.chainId === chainId &&
    row.executionDeploymentId === deploymentId &&
    row.factoryAddress?.toLowerCase() === registry.factory.toLowerCase() &&
    row.creator.toLowerCase() === registry.deployer.toLowerCase() &&
    row.theme === entry.slug &&
    row.id.toLowerCase() === entry.token.toLowerCase() &&
    row.token.toLowerCase() === entry.token.toLowerCase() &&
    row.vault.toLowerCase() === entry.vault.toLowerCase() &&
    row.creatorFeeBps === 0 &&
    row.spec.name === basket.tokenName &&
    row.spec.symbol === basket.tokenSymbol &&
    row.spec.decimals === basket.decimals &&
    row.spec.mintRedeemBandBps === basket.mintRedeemBandBps &&
    row.spec.usdg.toLowerCase() === basket.usdg?.toLowerCase() &&
    same(
      row.spec.constituents,
      basket.constituents.map((c) => c.tokenAddress),
    ) &&
    same(
      row.spec.feeds,
      basket.constituents.map((c) => c.feed),
    ) &&
    same(
      row.spec.targetWeightsBps,
      basket.constituents.map((c) => c.weightBps),
    ) &&
    same(
      row.spec.capsBps,
      basket.constituents.map((c) => c.capBps),
    ) &&
    same(row.spec.venues, basket.venues) &&
    row.spec.feeController.toLowerCase() === entry.feeController.toLowerCase() &&
    row.spec.policyHash.toLowerCase() === entry.policyHash.toLowerCase() &&
    row.deployTx.toLowerCase() === entry.transactionHash.toLowerCase()
  );
}
