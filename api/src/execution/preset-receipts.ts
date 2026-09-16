import { createHash } from "node:crypto";
import { getAddress, parseEventLogs, type Hex } from "viem";
import { presetFactoryAbi } from "../chain/abis/presetFactory.ts";
import { themeFactoryEventsAbi } from "../chain/abis/keylessVault.ts";
import type { ThemeProposalBasket, ThemeTokenRecord } from "../db/schema.ts";
import type { ExecutionContext } from "./context.ts";
import { PRESET_CATALOG_HASH, PRESET_IDS, presetId } from "./preset-catalog.ts";
import {
  validatePresetRegistry,
  type PresetEntry,
  type PresetRegistry,
} from "./preset-manifest.ts";
import { approvedVaultPolicyHash, encodePresetDeployment } from "./shared-lenses.ts";
import { PRESET_RELEASE } from "./vault-accounting.ts";

const lc = (value: string) => value.toLowerCase();

export async function verifyPresetFactory(
  context: ExecutionContext,
  requireComplete = false,
): Promise<PresetRegistry> {
  const registry = context.manifest.presets;
  if (!registry) throw new Error("Preset factory is not configured");
  validatePresetRegistry(registry);
  const base = { address: registry.factory, abi: presetFactoryAbi } as const;
  const [version, deployer, catalog, ids, complete] = await Promise.all([
    context.publicClient.readContract({ ...base, functionName: "RELEASE" }),
    context.publicClient.readContract({ ...base, functionName: "presetDeployer" }),
    context.publicClient.readContract({ ...base, functionName: "catalogHash" }),
    context.publicClient.readContract({ ...base, functionName: "presetIds" }),
    context.publicClient.readContract({ ...base, functionName: "presetsComplete" }),
  ]);
  if (
    version !== PRESET_RELEASE ||
    lc(deployer) !== lc(registry.deployer) ||
    catalog !== PRESET_CATALOG_HASH ||
    ids.length !== PRESET_IDS.length ||
    ids.some((id, index) => id !== PRESET_IDS[index]) ||
    (requireComplete && !complete)
  )
    throw new Error("Preset factory identity/catalog is invalid or bootstrap is incomplete");
  return registry;
}

/** Bootstrap-only bounded lookup. Nitro slots store parent-chain block.number,
 * so real networks require a pinned creation transaction, not a log query at
 * that height. Anvil slots use the execution height and support local recovery. */
export async function locatePreset(
  context: ExecutionContext,
  registry: PresetRegistry,
  slug: string,
  basket: ThemeProposalBasket,
  transactionHash?: Hex,
): Promise<PresetEntry | null> {
  const id = presetId(slug);
  const [token, vault, feeController, policyHash, blockNumber] =
    await context.publicClient.readContract({
      address: registry.factory,
      abi: presetFactoryAbi,
      functionName: "presets",
      args: [id],
    });
  if (BigInt(token) === 0n) return null;
  if (approvedVaultPolicyHash(token, { creator: registry.deployer, basket }) !== policyHash)
    throw new Error(`${slug}: occupied preset slot does not match the frozen bootstrap plan`);
  const pinnedHash =
    transactionHash ?? registry.entries.find((entry) => entry.id === id)?.transactionHash;
  if (!pinnedHash && context.manifest.mode !== "local-fork")
    throw new Error(
      `${slug}: occupied preset requires a pinned deployment transaction hash (--receipts)`,
    );
  const receipt = pinnedHash
    ? await context.publicClient.getTransactionReceipt({ hash: pinnedHash })
    : undefined;
  const events = receipt
    ? parseEventLogs({
        abi: themeFactoryEventsAbi,
        logs: receipt.logs,
        strict: true,
      }).filter((event) => lc(event.address) === lc(registry.factory))
    : await context.logsClient.getLogs({
        address: registry.factory,
        events: themeFactoryEventsAbi,
        fromBlock: blockNumber,
        toBlock: blockNumber,
        strict: true,
      });
  const matches = events.filter(
    (event) =>
      event.eventName === "ThemeDeployed" &&
      event.args.themeToken.toLowerCase() === token.toLowerCase(),
  );
  if (matches.length !== 1 || !matches[0]?.transactionHash || !matches[0].blockHash)
    throw new Error(`${slug}: canonical preset creation event is unavailable`);
  return {
    slug,
    id,
    token,
    vault,
    feeController,
    policyHash,
    blockNumber: (receipt?.blockNumber ?? blockNumber).toString(),
    transactionHash: matches[0].transactionHash,
    blockHash: matches[0].blockHash,
    basket,
  };
}

function creationSlotHeight(
  context: ExecutionContext,
  receipt: { blockNumber: bigint; l1BlockNumber?: unknown },
): bigint {
  if (context.manifest.mode === "local-fork") return receipt.blockNumber;
  // viem preserves Nitro's raw receipt extension (hex); some formatters decode it.
  const parent = receipt.l1BlockNumber;
  if (typeof parent === "bigint" && parent >= 0n) return parent;
  if (typeof parent === "string" && /^0x[0-9a-fA-F]+$/.test(parent)) return BigInt(parent);
  throw new Error("Nitro receipt is missing a valid l1BlockNumber");
}

/** Verify only a pinned transaction. Receipt metadata may move after a reorg,
 * but the tx, factory slot, addresses and immutable policy may never change. */
export async function verifyPresetReceipt(
  context: ExecutionContext,
  registry: PresetRegistry,
  entry: PresetEntry,
) {
  const [receipt, transaction, slot] = await Promise.all([
    context.publicClient.getTransactionReceipt({ hash: entry.transactionHash }),
    context.publicClient.getTransaction({ hash: entry.transactionHash }),
    context.publicClient.readContract({
      address: registry.factory,
      abi: presetFactoryAbi,
      functionName: "presets",
      args: [entry.id],
    }),
  ]);
  const block = await context.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  if (
    receipt.status !== "success" ||
    block.hash !== receipt.blockHash ||
    lc(transaction.to ?? "") !== lc(registry.factory) ||
    lc(transaction.from) !== lc(registry.deployer) ||
    transaction.input.toLowerCase() !==
      encodePresetDeployment(entry.basket, registry.deployer).toLowerCase() ||
    lc(slot[0]) !== lc(entry.token) ||
    lc(slot[1]) !== lc(entry.vault) ||
    lc(slot[2]) !== lc(entry.feeController) ||
    lc(slot[3]) !== lc(entry.policyHash) ||
    slot[4] !== creationSlotHeight(context, receipt)
  )
    throw new Error(`${entry.slug}: preset receipt, slot or approved calldata does not match`);
  const logs = parseEventLogs({
    abi: themeFactoryEventsAbi,
    logs: receipt.logs,
    strict: true,
  }).filter((event) => lc(event.address) === lc(registry.factory));
  const deployment = logs.filter((event) => event.eventName === "ThemeDeployed");
  const composition = logs.filter((event) => event.eventName === "ThemeComposition");
  const created = deployment[0];
  const basket = composition[0];
  if (
    deployment.length !== 1 ||
    composition.length !== 1 ||
    !created ||
    !basket ||
    lc(created.args.themeToken) !== lc(entry.token) ||
    lc(created.args.vault) !== lc(entry.vault) ||
    lc(created.args.feeController) !== lc(entry.feeController) ||
    created.args.slug !== entry.slug ||
    lc(created.args.policyHash) !== lc(entry.policyHash) ||
    lc(basket.args.policyHash) !== lc(entry.policyHash) ||
    lc(basket.args.themeToken) !== lc(entry.token) ||
    approvedVaultPolicyHash(entry.token, { creator: registry.deployer, basket: entry.basket }) !==
      entry.policyHash
  )
    throw new Error(`${entry.slug}: preset creation events do not match the registered policy`);
  const codes = await Promise.all(
    [entry.token, entry.vault, entry.feeController].map((address) =>
      context.publicClient.getCode({ address }),
    ),
  );
  if (codes.some((code) => !code || code === "0x"))
    throw new Error(`${entry.slug}: preset contract code is missing`);
  const row: ThemeTokenRecord = {
    id: lc(entry.token),
    token: lc(entry.token),
    vault: lc(entry.vault),
    creator: lc(registry.deployer),
    theme: entry.slug,
    spec: {
      constituents: entry.basket.constituents.map((c) => lc(c.tokenAddress)),
      feeds: entry.basket.constituents.map((c) => lc(c.feed)),
      targetWeightsBps: entry.basket.constituents.map((c) => c.weightBps),
      capsBps: entry.basket.constituents.map((c) => c.capBps),
      mintRedeemBandBps: entry.basket.mintRedeemBandBps,
      venues: entry.basket.venues.map(lc),
      usdg: lc(entry.basket.usdg!),
      feeController: lc(entry.feeController),
      policyHash: lc(entry.policyHash),
      name: entry.basket.tokenName,
      symbol: entry.basket.tokenSymbol,
      decimals: entry.basket.decimals,
    },
    creatorFeeBps: 0,
    status: "deployed",
    aumUsd: null,
    chainId: context.manifest.chainId,
    deployTx: lc(entry.transactionHash),
    deployedAt: new Date(Number(block.timestamp) * 1000),
    deployBlock: Number(receipt.blockNumber),
    deployBlockHash: lc(receipt.blockHash),
    deployLogIndex: created.logIndex,
    executionDeploymentId: context.manifest.deploymentId,
    factoryAddress: lc(registry.factory),
    factoryVersion: PRESET_RELEASE,
    canonical: true,
    canonicalReason: null,
    executionCompatibility: "verified",
    executionCompatibilityReason: null,
  };
  return { row, logs, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash as Hex };
}

/** Full verification is mandatory before any creation evidence is cached. */
async function readRegisteredPresetReceipts(context: ExecutionContext, confirmations: number) {
  const registry = context.manifest.presets;
  if (!registry?.entries.length) return { receipts: [], head: 0n };
  await verifyPresetFactory(context, true);
  const receipts = await Promise.all(
    registry.entries.map((entry) => verifyPresetReceipt(context, registry, entry)),
  );
  const head = await context.publicClient.getBlockNumber({ cacheTime: 0 });
  if (receipts.some((receipt) => receipt.blockNumber + BigInt(confirmations) > head))
    throw new Error("Preset bootstrap is awaiting canonical confirmations");
  return { receipts, head };
}

type VerifiedReceipts = Awaited<ReturnType<typeof readRegisteredPresetReceipts>>;
type ReceiptCache = {
  key: string;
  verified?: VerifiedReceipts;
  pending?: Promise<VerifiedReceipts>;
};

// One process-local generation only. Restart deliberately requires full chain
// verification; Redis/DB contents can never seed trusted receipt evidence.
let receiptCache: ReceiptCache | undefined;

async function refreshRegisteredPresets(
  context: ExecutionContext,
  confirmations: number,
  cached: VerifiedReceipts | undefined,
): Promise<VerifiedReceipts> {
  if (cached) {
    // Read by NUMBER, not hash: an orphaned block may still be retrievable by
    // its old hash. Do not use a TTL or skip this check when the head is equal.
    const heights = [...new Set(cached.receipts.map((receipt) => receipt.blockNumber))];
    const [head, blocks] = await Promise.all([
      context.publicClient.getBlockNumber({ cacheTime: 0 }),
      Promise.all(heights.map((blockNumber) => context.publicClient.getBlock({ blockNumber }))),
    ]);
    const canonical = new Map(heights.map((height, i) => [height, blocks[i].hash]));
    if (
      head >= cached.head &&
      cached.receipts.every((receipt) => canonical.get(receipt.blockNumber) === receipt.blockHash)
    ) {
      if (cached.receipts.some((receipt) => receipt.blockNumber + BigInt(confirmations) > head))
        throw new Error("Preset bootstrap is awaiting canonical confirmations");
      return { receipts: cached.receipts, head };
    }
    // A relevant reorg/rollback may reinclude the SAME pinned transaction at a
    // different block. Only full receipt/slot/policy verification may adopt it.
  }
  return readRegisteredPresetReceipts(context, confirmations);
}

/** No log-range discovery. Reuse only fully verified immutable creation
 * evidence, with fresh canonical block/confirmation checks on EVERY call.
 * Live balances, flows, quotes, and transaction preflight are never cached here. */
export async function registeredPresetReceipts(context: ExecutionContext, confirmations = 0) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
    receiptCache = undefined;
    throw new Error("Invalid preset confirmation requirement");
  }
  const registry = context.manifest.presets;
  try {
    if (registry) validatePresetRegistry(registry);
  } catch (error) {
    receiptCache = undefined;
    throw error;
  }
  if (!registry?.entries.length) {
    receiptCache = undefined;
    return [];
  }
  // Include actual manifest contents as well as the disk digest: even a caller
  // that passes a modified context with its old digest cannot hit the cache.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        context.manifestDigest,
        context.manifest,
        context.providerIdentity ?? context.publicClient.uid,
        confirmations,
      ]),
    )
    .digest("hex");
  if (receiptCache?.key !== key) receiptCache = { key };
  const state = receiptCache;
  // Only simultaneous work is shared. Later calls must check canonicality
  // again, even at the same height. An old generation's promise cannot replace
  // a newer generation's cache because it only owns its detached state object.
  state.pending ??= refreshRegisteredPresets(context, confirmations, state.verified)
    .then((verified) => {
      state.verified = verified;
      return verified;
    })
    .catch((error: unknown) => {
      state.verified = undefined;
      throw error;
    })
    .finally(() => {
      state.pending = undefined;
    });
  // Callers sync DB metadata and replay logs; none may mutate cached evidence.
  return structuredClone((await state.pending).receipts);
}
