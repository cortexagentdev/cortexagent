/**
 * Wallet transaction planning for an immutable vault.  This module is the only
 * place that turns a human amount into vault calldata; routers deliberately do
 * not accept a recipient, route, minimum, or calldata from a browser.
 */
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type PublicClient,
} from "viem";

import { aggregatorV3Abi, keylessVaultAbi, stockAbi } from "../chain/abis/index.ts";
import type { ThemeTokenRecord } from "../db/schema.ts";
import { env } from "../env.ts";
import { assertExecutionHead, requireRpcCapabilities } from "../chain/rpc-capabilities.ts";
import { recordRpcOutcome } from "../chain/rpc-metrics.ts";
import { getExecutionContext } from "./context.ts";
import { matchesRegisteredPreset } from "./preset-manifest.ts";

const BPS = 10_000n;
const QUOTE_TTL_MS = 20_000;
const MAX_QUOTE_BLOCK_DISTANCE = 5n;
const DEADLINE_SECONDS = 120n;
const MAX_SLIPPAGE_BPS = 1_000;
const UINT256_MAX = (1n << 256n) - 1n;

export const vaultActions = ["mint_in_kind", "mint_usdg", "redeem_in_kind", "redeem_usdg"] as const;
export type VaultAction = (typeof vaultActions)[number];
export type AmountDenomination = "target_notional_usdg" | "usdg" | "shares";

export interface ActionRequest {
  action: VaultAction;
  amount: string;
  denomination: AmountDenomination;
  slippageBps: number;
}

export interface ActionRefusal {
  status: "refused" | "temporarily_unavailable";
  code: string;
  message: string;
}

export interface ApprovalStep {
  key: string;
  token: Address;
  spender: Address;
  amountRaw: string;
  to: Address;
  data: `0x${string}`;
  value: "0";
  required: boolean;
  zeroFirst: boolean;
}

export interface ActionQuote {
  status: "quoted" | "needs_approval";
  quoteId: string;
  deploymentId: string;
  manifestDigest: `0x${string}`;
  chainId: number;
  caller: Address;
  action: VaultAction;
  amountRaw: string;
  denomination: AmountDenomination;
  blockNumber: string;
  blockHash: `0x${string}`;
  quotedAt: string;
  expiresAt: string;
  approvals: ApprovalStep[];
  expectedResultRaw: string | null;
  summary: string;
}

export interface ActionPlan extends Omit<
  ActionQuote,
  "status" | "approvals" | "expectedResultRaw"
> {
  status: "ready";
  approvals: ApprovalStep[];
  deadline: string | null;
  call: { to: Address; data: `0x${string}`; value: "0" };
  simulation: { resultRaw: string; blockNumber: string; blockHash: `0x${string}` };
  gasEstimate: string;
}

type CachedQuote = {
  request: ActionRequest;
  row: ThemeTokenRecord;
  caller: Address;
  quote: ActionQuote;
  mintAmounts: bigint[] | null;
};
const quotes = new Map<string, CachedQuote>();
const quoteFlights = new Map<string, Promise<ActionQuote | ActionPlan | ActionRefusal>>();

function refusal(code: string, message: string, temporary = false): ActionRefusal {
  return { status: temporary ? "temporarily_unavailable" : "refused", code, message };
}

/** Decimal strings only: no float round-trip, exponent, sign, or excess precision. */
function parseDecimal(value: string, decimals: number): bigint | ActionRefusal {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed))
    return refusal(
      "INVALID_AMOUNT",
      "Enter a positive decimal amount without scientific notation or a sign.",
    );
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals)
    return refusal("INVALID_AMOUNT", `This amount has more than ${decimals} decimal places.`);
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (raw === 0n) return refusal("INVALID_AMOUNT", "Enter an amount greater than zero.");
  if (raw > UINT256_MAX)
    return refusal("INVALID_AMOUNT", "This amount exceeds the vault's uint256 limit.");
  return raw;
}

function expectedDenomination(action: VaultAction): AmountDenomination {
  if (action === "mint_in_kind") return "target_notional_usdg";
  if (action === "mint_usdg") return "usdg";
  return "shares";
}

function sameAddresses(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((address, i) => address.toLowerCase() === right[i]?.toLowerCase())
  );
}

async function verifiedVault(row: ThemeTokenRecord) {
  const context = await getExecutionContext();
  if (!context)
    return refusal(
      "DEPLOYMENT_MISMATCH",
      "Execution identity is not verified; no wallet plan can be issued.",
      true,
    );
  const vault = getAddress(row.vault);
  const share = getAddress(row.id);
  const code = await context.publicClient.getCode({ address: vault });
  if (!code || code === "0x")
    return refusal("DEPLOYMENT_MISMATCH", "The indexed vault has no code on this execution chain.");
  try {
    const [themeToken, usdg, constituents, venues] = await Promise.all([
      context.publicClient.readContract({
        address: vault,
        abi: keylessVaultAbi,
        functionName: "themeToken",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: keylessVaultAbi,
        functionName: "usdg",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: keylessVaultAbi,
        functionName: "constituents",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: keylessVaultAbi,
        functionName: "allowedVenues",
      }),
    ]);
    if (
      getAddress(themeToken) !== share ||
      getAddress(usdg) !== getAddress(context.manifest.usdg.address)
    )
      return refusal(
        "DEPLOYMENT_MISMATCH",
        "Vault share token or USDG identity differs from the verified execution manifest.",
      );
    if (!sameAddresses(constituents, row.spec.constituents))
      return refusal(
        "DEPLOYMENT_MISMATCH",
        "Vault constituents differ from the indexed immutable policy.",
      );
    const adapter = context.manifest.adapters.find((candidate) =>
      venues.some((venue) => venue.toLowerCase() === candidate.address.toLowerCase()),
    );
    return { context, vault, share, adapter: adapter ? getAddress(adapter.address) : null };
  } catch {
    return refusal(
      "DEPLOYMENT_MISMATCH",
      "The vault policy could not be verified on the execution chain.",
      true,
    );
  }
}

function approval(token: Address, spender: Address, amount: bigint, current: bigint): ApprovalStep {
  // The verified Stock Tokens and USDG are standard ERC-20s.  No token in this
  // release is known to require a reset; adding one is an explicit compatibility
  // decision, rather than a blanket extra signature.
  return {
    key: `approve:${token.toLowerCase()}`,
    token,
    spender,
    amountRaw: amount.toString(),
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    value: "0",
    required: current < amount,
    zeroFirst: false,
  };
}

async function inKindAmounts(
  row: ThemeTokenRecord,
  notional: bigint,
  client: PublicClient,
  blockNumber: bigint,
) {
  const amounts: bigint[] = [];
  for (const [index, address] of row.spec.constituents.entries()) {
    const token = getAddress(address);
    const feed = getAddress(row.spec.feeds[index]!);
    const [decimals, multiplier, round, feedDecimals] = await Promise.all([
      client.readContract({ address: token, abi: stockAbi, functionName: "decimals", blockNumber }),
      client.readContract({
        address: token,
        abi: stockAbi,
        functionName: "uiMultiplier",
        blockNumber,
      }),
      client.readContract({
        address: feed,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
        blockNumber,
      }),
      client.readContract({
        address: feed,
        abi: aggregatorV3Abi,
        functionName: "decimals",
        blockNumber,
      }),
    ]);
    if (round[1] <= 0n || round[3] === 0n)
      return refusal("ORACLE_UNAVAILABLE", "A constituent feed has no usable current answer.");
    const wholeValueWad =
      (((round[1] * 10n ** 18n) / 10n ** BigInt(feedDecimals)) * multiplier) / 10n ** 18n;
    const amount =
      (((notional * BigInt(row.spec.targetWeightsBps[index] ?? 0)) / BPS) *
        10n ** BigInt(decimals)) /
      wholeValueWad;
    if (amount === 0n)
      return refusal(
        "INVALID_AMOUNT",
        "This target notional is too small to include every required constituent.",
      );
    amounts.push(amount);
  }
  return amounts;
}

async function build(
  row: ThemeTokenRecord,
  caller: Address,
  request: ActionRequest,
  requireSimulation: boolean,
  reviewed?: CachedQuote,
): Promise<ActionQuote | ActionPlan | ActionRefusal> {
  const started = Date.now();
  if (request.denomination !== expectedDenomination(request.action))
    return refusal(
      "INVALID_DENOMINATION",
      `${request.action} requires ${expectedDenomination(request.action)}.`,
    );
  if (
    !Number.isInteger(request.slippageBps) ||
    request.slippageBps < 0 ||
    request.slippageBps > MAX_SLIPPAGE_BPS
  )
    return refusal(
      "INVALID_SLIPPAGE",
      "Slippage must be a whole number from 0 to 1000 basis points.",
    );
  const execution = await getExecutionContext();
  if (!execution)
    return refusal(
      "DEPLOYMENT_MISMATCH",
      "Execution identity is not verified; no executable plan can be issued.",
      true,
    );
  if (request.action === "mint_in_kind" || request.action === "mint_usdg") {
    const registry = execution.manifest.presets;
    const entry = registry?.entries.find(
      (preset) => preset.token.toLowerCase() === row.id.toLowerCase(),
    );
    if (
      !registry ||
      !entry ||
      !matchesRegisteredPreset(
        row,
        entry,
        registry,
        execution.manifest.chainId,
        execution.manifest.deploymentId,
      )
    )
      return refusal(
        "UNREGISTERED_PRESET",
        "Deposits are only available into operator-registered predefined vaults. Existing withdrawals and deferred claims are not disabled.",
      );
  }
  try {
    const urls = env.EXECUTION_RPC_URLS ?? [];
    await requireRpcCapabilities("execution", urls, execution.manifest.chainId, [
      "latest",
      "historical",
      "multicall",
      "simulation",
    ]);
    await assertExecutionHead(urls, execution.manifest.chainId);
  } catch (error) {
    return refusal(
      "RPC_CAPABILITY_UNAVAILABLE",
      error instanceof Error
        ? error.message
        : "Execution RPC capabilities are unavailable; no executable plan was issued.",
      true,
    );
  }
  const verified = await verifiedVault(row);
  if ("status" in verified) return verified;
  const { context, vault, share, adapter } = verified;
  const routed = request.action === "mint_usdg" || request.action === "redeem_usdg";
  const factory = context.manifest.factories.find(
    (entry) =>
      entry.address.toLowerCase() === row.factoryAddress?.toLowerCase() &&
      entry.version === row.factoryVersion,
  );
  if (
    routed &&
    (!adapter || !factory?.capabilities?.deadlineMint || !factory.capabilities.deadlineRedeem)
  )
    return refusal(
      "UNSUPPORTED_VERSION",
      "This immutable vault version supports in-kind actions only; routed USDG actions require the verified deadline-aware release.",
    );

  const decimals = request.action.startsWith("mint_")
    ? request.action === "mint_usdg"
      ? context.manifest.usdg.decimals
      : 18
    : row.spec.decimals;
  const amount = parseDecimal(request.amount, decimals);
  if (typeof amount !== "bigint") return amount;
  const block = await context.publicClient.getBlock();
  if (!block.number || !block.hash)
    return refusal("RPC_UNAVAILABLE", "The execution node did not return a canonical block.", true);
  const deadline = routed ? block.timestamp + DEADLINE_SECONDS : null;
  const expiresAt = reviewed?.quote.expiresAt ?? new Date(started + QUOTE_TTL_MS).toISOString();
  async function snapshotCurrent() {
    const [canonical, head] = await Promise.all([
      context.publicClient.getBlock({ blockNumber: block.number! }),
      context.publicClient.getBlockNumber({ cacheTime: 0 }),
    ]);
    return (
      Date.now() < Date.parse(expiresAt) &&
      canonical.hash === block.hash &&
      head >= block.number! &&
      head <= block.number! + MAX_QUOTE_BLOCK_DISTANCE
    );
  }
  let approvals: ApprovalStep[] = [];
  let mintAmounts: bigint[] | null = null;
  let data: `0x${string}`;
  let summary: string;

  try {
    if (request.action === "mint_in_kind") {
      const amounts =
        reviewed?.mintAmounts ??
        (await inKindAmounts(row, amount, context.publicClient, block.number));
      if (!Array.isArray(amounts)) return amounts;
      mintAmounts = amounts;
      const allowanceReads = await Promise.all(
        row.spec.constituents.map((token) =>
          context.publicClient.readContract({
            address: getAddress(token),
            abi: erc20Abi,
            functionName: "allowance",
            args: [caller, vault],
            blockNumber: block.number,
          }),
        ),
      );
      const balances = await Promise.all(
        row.spec.constituents.map((token) =>
          context.publicClient.readContract({
            address: getAddress(token),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [caller],
            blockNumber: block.number,
          }),
        ),
      );
      if (balances.some((balance, i) => balance < amounts[i]!))
        return refusal(
          "INSUFFICIENT_BALANCE",
          "Your wallet does not hold the exact constituent amount required for this in-kind mint.",
        );
      approvals = amounts.map((raw, i) =>
        approval(getAddress(row.spec.constituents[i]!), vault, raw, allowanceReads[i]!),
      );
      data = encodeFunctionData({
        abi: keylessVaultAbi,
        functionName: "mint",
        args: [amounts, caller, 1n],
      });
      summary = `Mint ${row.spec.symbol} in kind from a ${request.amount} USDG target notional.`;
    } else if (request.action === "mint_usdg") {
      const balance = await context.publicClient.readContract({
        address: getAddress(context.manifest.usdg.address),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [caller],
        blockNumber: block.number,
      });
      if (balance < amount)
        return refusal("INSUFFICIENT_BALANCE", "Your wallet does not hold this USDG amount.");
      const current = await context.publicClient.readContract({
        address: getAddress(context.manifest.usdg.address),
        abi: erc20Abi,
        functionName: "allowance",
        args: [caller, vault],
        blockNumber: block.number,
      });
      approvals = [approval(getAddress(context.manifest.usdg.address), vault, amount, current)];
      data = encodeFunctionData({
        abi: keylessVaultAbi,
        functionName: "mintWithUsdgUntil",
        args: [amount, adapter!, caller, 1n, deadline!],
      });
      summary = `Mint ${row.spec.symbol} using ${request.amount} USDG.`;
    } else {
      const balance = await context.publicClient.readContract({
        address: share,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [caller],
        blockNumber: block.number,
      });
      if (balance < amount)
        return refusal("INSUFFICIENT_BALANCE", "Your wallet does not hold this many vault shares.");
      if (request.action === "redeem_in_kind") {
        data = encodeFunctionData({
          abi: keylessVaultAbi,
          functionName: "redeem",
          args: [amount, caller],
        });
        summary = `Redeem ${request.amount} ${row.spec.symbol} shares in kind.`;
      } else {
        data = encodeFunctionData({
          abi: keylessVaultAbi,
          functionName: "redeemToUsdgUntil",
          args: [amount, adapter!, caller, 1n, deadline!],
        });
        summary = `Redeem ${request.amount} ${row.spec.symbol} shares to USDG.`;
      }
    }
  } catch {
    return refusal(
      "RPC_UNAVAILABLE",
      "Required balance, allowance, token-decimals, or feed metadata could not be read.",
      true,
    );
  }

  const needed = approvals.filter((step) => step.required);
  const quoteBase = {
    deploymentId: context.manifest.deploymentId,
    manifestDigest: context.manifestDigest,
    chainId: context.manifest.chainId,
    caller,
    action: request.action,
    amountRaw: amount.toString(),
    denomination: request.denomination,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    quotedAt: new Date().toISOString(),
    expiresAt,
    approvals,
    summary,
  };
  const quoteId = keccak256(toHex(JSON.stringify({ ...quoteBase, nonce: crypto.randomUUID() })));
  if (needed.length && !requireSimulation) {
    if (!(await snapshotCurrent()))
      return refusal("QUOTE_EXPIRED", "Snapshot changed or expired; request a fresh quote.");
    const quote: ActionQuote = {
      status: "needs_approval",
      quoteId,
      expectedResultRaw: null,
      ...quoteBase,
    };
    if (quotes.size >= 128) quotes.delete(quotes.keys().next().value!);
    quotes.set(quoteId, { request, row, caller, quote, mintAmounts });
    return quote;
  }
  if (needed.length)
    return refusal(
      "APPROVAL_REQUIRED",
      "Confirm the bounded approvals, then request a fresh action quote before planning the vault call.",
    );

  try {
    const result = await context.publicClient.call({
      account: caller,
      to: vault,
      data,
      blockNumber: block.number,
    });
    if (result.data === undefined)
      return refusal("SIMULATION_REVERTED", "The vault call returned no simulation result.");
    const minimumResult = request.action === "redeem_in_kind" ? 0n : BigInt(result.data);
    const expected = request.action === "redeem_in_kind" ? "0" : minimumResult.toString();
    if (!requireSimulation) {
      if (!(await snapshotCurrent()))
        return refusal("QUOTE_EXPIRED", "Snapshot changed or expired; request a fresh quote.");
      const quote: ActionQuote = {
        status: "quoted",
        quoteId,
        expectedResultRaw: expected,
        ...quoteBase,
      };
      if (quotes.size >= 128) quotes.delete(quotes.keys().next().value!);
      quotes.set(quoteId, { request, row, caller, quote, mintAmounts });
      return quote;
    }
    const min =
      request.action === "redeem_in_kind"
        ? null
        : (BigInt(reviewed!.quote.expectedResultRaw!) * (BPS - BigInt(request.slippageBps))) / BPS;
    if (min !== null && min === 0n)
      return refusal("INVALID_AMOUNT", "The protected output rounds to zero; increase the amount.");
    const finalData =
      request.action === "mint_in_kind"
        ? encodeFunctionData({
            abi: keylessVaultAbi,
            functionName: "mint",
            args: [mintAmounts!, caller, min!],
          })
        : request.action === "redeem_in_kind"
          ? data
          : request.action === "mint_usdg"
            ? encodeFunctionData({
                abi: keylessVaultAbi,
                functionName: "mintWithUsdgUntil",
                args: [amount, adapter!, caller, min!, deadline!],
              })
            : encodeFunctionData({
                abi: keylessVaultAbi,
                functionName: "redeemToUsdgUntil",
                args: [amount, adapter!, caller, min!, deadline!],
              });
    const finalCall = await context.publicClient.call({
      account: caller,
      to: vault,
      data: finalData,
      blockNumber: block.number,
    });
    const gas = await context.publicClient.estimateGas({
      account: caller,
      to: vault,
      data: finalData,
    });
    const [native, gasPrice] = await Promise.all([
      context.publicClient.getBalance({ address: caller, blockNumber: block.number }),
      context.publicClient.getGasPrice(),
    ]);
    if (native < gas * gasPrice)
      return refusal(
        "INSUFFICIENT_GAS",
        "Your wallet does not have enough native ETH for the estimated gas.",
      );
    if (!(await snapshotCurrent()))
      return refusal(
        "QUOTE_EXPIRED",
        "Snapshot changed or expired during simulation; request a fresh quote.",
      );
    return {
      status: "ready",
      ...quoteBase,
      quoteId,
      deadline: deadline?.toString() ?? null,
      call: { to: vault, data: finalData, value: "0" },
      simulation: {
        resultRaw: finalCall.data ?? "0x",
        blockNumber: block.number.toString(),
        blockHash: block.hash,
      },
      gasEstimate: gas.toString(),
    };
  } catch {
    return refusal(
      "SIMULATION_REVERTED",
      "The full vault call reverted in simulation. Refresh the quote after checking balances, allowance, oracle freshness, and vault policy.",
    );
  }
}

export async function quoteVaultAction(
  row: ThemeTokenRecord,
  caller: Address,
  request: ActionRequest,
) {
  const key = JSON.stringify({
    vault: row.id.toLowerCase(),
    caller: caller.toLowerCase(),
    request,
  });
  const existing = quoteFlights.get(key);
  if (existing) return existing;
  const pending = build(row, caller, request, false);
  quoteFlights.set(key, pending);
  try {
    const result = await pending;
    recordRpcOutcome("wallet-quote", result.status);
    return result;
  } finally {
    quoteFlights.delete(key);
  }
}

export async function planVaultAction(quoteId: string, caller: Address) {
  const cached = quotes.get(quoteId);
  if (!cached || cached.caller !== caller || Date.parse(cached.quote.expiresAt) < Date.now())
    return refusal(
      "QUOTE_EXPIRED",
      "This action quote expired or belongs to another wallet. Request a fresh quote.",
    );
  if (cached.quote.status === "needs_approval")
    return refusal(
      "APPROVAL_REQUIRED",
      "Confirm approvals and request a fresh quote before planning.",
    );
  const context = await getExecutionContext();
  if (
    !context ||
    context.manifest.deploymentId !== cached.quote.deploymentId ||
    context.manifestDigest !== cached.quote.manifestDigest
  )
    return refusal(
      "DEPLOYMENT_MISMATCH",
      "Execution identity changed since this quote. Request a fresh quote.",
    );
  const [head, original] = await Promise.all([
    context.publicClient.getBlockNumber({ cacheTime: 0 }),
    context.publicClient.getBlock({ blockNumber: BigInt(cached.quote.blockNumber) }),
  ]);
  if (
    original.hash !== cached.quote.blockHash ||
    head < BigInt(cached.quote.blockNumber) ||
    head > BigInt(cached.quote.blockNumber) + MAX_QUOTE_BLOCK_DISTANCE
  )
    return refusal(
      "QUOTE_EXPIRED",
      "The quote snapshot is no longer canonical or recent. Request a fresh quote.",
    );
  const result = await build(cached.row, caller, cached.request, true, cached);
  recordRpcOutcome("wallet-plan", result.status);
  return result;
}
