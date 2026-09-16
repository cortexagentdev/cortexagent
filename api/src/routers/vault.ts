import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  type Address,
  type PublicClient,
} from "viem";
import { z } from "zod";

import type { VaultConstituent, VaultSummary } from "@shared/contracts.ts";

import { aggregatorV3Abi, keylessVaultAbi, stockAbi, themeTokenAbi } from "../chain/abis/index.ts";
import { executionChain, executionPublicClient } from "../chain/client.ts";
import { multicallRead, type MulticallItem } from "../chain/multicall.ts";
import {
  getExecutionContext,
  getExecutionMetadata,
  isExecutionMetadataCurrent,
  type ExecutionContext,
  type ExecutionMetadata,
} from "../execution/context.ts";
import {
  vaultDisplayCache,
  vaultDisplayKey,
  vaultDisplayProviderIdentity,
  vaultDisplayScope,
} from "../execution/vault-display-cache.ts";
import { supportsDeferredClaims, vaultBalanceCall } from "../execution/vault-accounting.ts";
import {
  officialVaultsMetadata,
  isOfficialDepositVault,
} from "../execution/shared-lens-registry.ts";
import {
  decodeLatestRoundData,
  decodeNavIndicative,
  decodeSmallUint,
  decodeUint,
  decodeUintArray,
  fromWad,
  WAD,
} from "../chain/vault-reads.ts";
import { flows, navHistory, themeTokens, universe, type ThemeTokenRecord } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { getSession } from "../lib/session.ts";
import { protectedProcedure, publicProcedure, router, type Context } from "../trpc.ts";
import {
  planVaultAction,
  quoteVaultAction,
  vaultActions,
  type AmountDenomination,
} from "../execution/action-plans.ts";

/**
 * `vaultRouter` (BE-27, write path added for W-9). A deployed theme token's NAV,
 * composition, mint / redeem quotes, flow log, and the unsigned transactions
 * that actually mint and redeem.
 *
 * C2 is testnet only (locked decision 5), so every chain read here goes through
 * the RHC testnet client (chain 46630) and every `tokenId` resolves against a
 * `theme_tokens` row the BE-26 indexer wrote.
 *
 * Every read procedure is a `publicProcedure`: a vault's NAV and composition are
 * public facts and the research surfaces are wallet-free (locked decision 1).
 * `mintTx` and `redeemTx` are `protectedProcedure`s, because both need the
 * caller's own address: it is the share recipient, and for a mint it is also the
 * allowance owner whose approvals decide which steps can be skipped.
 *
 * ## The API encodes, the wallet signs
 *
 * BE-27 put transaction building out of scope and W-9 assumed the backend would
 * supply it, so neither built it and the ticket could only say "Preview only".
 * `mintTx` / `redeemTx` close that gap the same way `themeRouter.deploy` does:
 * they return UNSIGNED calldata stamped with chain 46630 and nothing here holds
 * a key that could broadcast it or move a caller's tokens.
 *
 * ## In-kind only, deliberately
 *
 * `mintWithUsdg` and `redeemToUsdg` are NOT built here. Both route through a
 * swap venue on the allowlist, and 46630 has no venue with real liquidity
 * yet, so encoding either one would hand a user a transaction that reverts on
 * its first swap leg or fills at a price nobody should accept. The in-kind pair
 * needs no venue and no router at all, which is exactly why it is the pair that
 * can ship.
 *
 * ## `summary()` reads the chain, not just the cache
 *
 * The NAV poller (BE-26) keeps `nav_history` and `theme_tokens.aumUsd` fresh on
 * a 60s cycle, but per-constituent weights and drift are not cached anywhere. So
 * `summary()` does one `Multicall3` read against the vault, pinned to a single
 * testnet block, and prefers the vault's own `navValue()` / `navPerShare()` /
 * `currentWeightsBps()` views so the figures match a direct on-chain read by
 * construction. It falls back to `navIndicative()` (and then to the poller
 * cache) only when a constituent feed is outside its liveness bound and the
 * strict views revert, which is the designed safe failure, not an error
 * (global do-not 1).
 *
 * ## Per-constituent `paused` / `halted`
 *
 * Joined from `universe`. PART 6: one frozen or halted constituent must be
 * "surfaced in the UI with its state, not silently priced". Dropping these
 * fields makes FE-4 impossible.
 */

const log = logger.child({ module: "vault-router" });

/** Stock Tokens are 18-dp on RHC. Read per constituent, never assumed; this is
 *  only the fallback for a `decimals()` that could not be read at all. */
const DEFAULT_CONSTITUENT_DECIMALS = 18;

/** Chainlink equity feeds on RHC read 8-dp; used only when `decimals()` itself
 *  could not be read. */
const DEFAULT_FEED_DECIMALS = 8;

/**
 * The Chainlink deviation threshold, bps. `KeylessVault` requires
 * `mintRedeemBandBps > DEVIATION_THRESHOLD_BPS + creatorFeeBps` at construction:
 * the band has to exceed the oracle's bounded error plus the fee or that error
 * can be arbitraged out of the vault (PART 4). `mintQuote` asserts the same
 * bound before it quotes.
 */
const DEVIATION_THRESHOLD_BPS = 50;

/** Reads batched per constituent: balance, multiplier, token decimals, feed
 *  round, feed decimals. The stride into the multicall result array. */
const CALLS_PER_CONSTITUENT = 5;

/** The same five plus `allowance(caller, vault)`, which only the mint write path
 *  needs. Its own stride, so the read paths are not made to pay for it. */
const CALLS_PER_MINT_CONSTITUENT = 6;

/** C2's only chain (locked decision 5). Stamped on every transaction this router
 *  hands back, so a wallet on the wrong network refuses before it signs. */
const TESTNET_CHAIN_ID = executionChain.id;

/** 1e18 as a bigint. `vault-reads.ts` exports `WAD` as a `number` for display
 *  scaling; calldata is computed in exact integers and never through a float. */
const ONE_WAD = 10n ** 18n;

const BPS = 10_000n;

/** Slippage floor applied to the quoted shares when the caller names none.
 *  0.5%, the same order as the oracle deviation the band already absorbs. */
const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * The widest `minSharesOut` haircut a caller may ask for, 10%.
 *
 * Slippage tolerance on this path protects against the vault's NAV moving
 * between the quote and the mine, not against a venue: there is no venue. Past
 * 10% the floor stops being protection and becomes an instruction to accept
 * whatever comes back, which is not a control worth offering.
 */
const MAX_SLIPPAGE_BPS = 1_000;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const tokenIdInput = z
  .object({
    tokenId: z
      .string()
      .trim()
      .regex(ADDRESS_RE, "Invalid theme token id")
      .transform((value) => value.toLowerCase()),
  })
  .strict();

const NAV_RANGES = ["1W", "1M", "6M", "1Y"] as const;
type NavRange = (typeof NAV_RANGES)[number];

const navHistoryInput = tokenIdInput.extend({
  range: z.enum(NAV_RANGES).default("1M"),
});

const mintQuoteInput = tokenIdInput.extend({
  /** USD deposited. Human units, not wei. */
  usdIn: z.number().finite().positive().max(1_000_000_000),
});

const redeemQuoteInput = tokenIdInput.extend({
  /** Theme-token shares to redeem. Human units, not wei. */
  shares: z.number().finite().positive().max(1_000_000_000_000),
});

/**
 * The two write inputs bound magnitudes only, and deliberately do NOT use
 * `.positive()`.
 *
 * A zero or negative amount is a refusal here, not a 400. Zod rejecting it
 * throws a `BAD_REQUEST` that renders as a generic red toast, and the whole
 * point of `VaultTxPlan.refusal` is that a ticket says in words why it will not
 * build a transaction (BE-27 requirement 3). So the sign check lives in the
 * handler beside every other refusal.
 */
const mintTxInput = tokenIdInput.extend({
  /** USD to deposit, split across the constituents at target weight. Human
   *  units, not wei. */
  usdAmount: z.number().finite().max(1_000_000_000),
  /** Haircut applied to the quoted shares to get `minSharesOut`. */
  slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS),
});

const redeemTxInput = tokenIdInput.extend({
  /** Theme-token shares to burn. Human units, not wei. */
  shares: z.number().finite().max(1_000_000_000_000),
});

/** Stage 10's wallet API intentionally takes only a human amount and its named
 * denomination. Recipient, route, minimum and calldata always come from the
 * verified vault/manifest and authenticated session. */
const actionQuoteInput = z
  .object({
    vaultId: z
      .string()
      .trim()
      .regex(ADDRESS_RE, "Invalid vault share token id")
      .transform((v) => v.toLowerCase()),
    action: z.enum(vaultActions),
    amount: z.string().trim().min(1).max(160),
    denomination: z.enum(["target_notional_usdg", "usdg", "shares"]),
    slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS),
  })
  .strict();

const actionPlanInput = z
  .object({ quoteId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid quote id") })
  .strict();

const FLOWS_DEFAULT_LIMIT = 25;
const FLOWS_MAX_LIMIT = 100;

const flowsInput = tokenIdInput.extend({
  /** Opaque keyset cursor from the previous page. Newest first, one direction. */
  cursor: z.string().min(1).optional(),
  // `@trpc/react-query` injects this into the input of every `useInfiniteQuery`
  // call. The flow log paginates forward only, so it is accepted and ignored;
  // declaring it keeps `tokenIdInput`'s `.strict()` from rejecting the request.
  // Without it every call fails validation before it reaches the handler, and
  // the table renders "Flow history could not be loaded" on a vault whose flows
  // are perfectly readable. `signalRouter.feed` carries the same declaration.
  direction: z.enum(["forward", "backward"]).optional(),
  limit: z.number().int().positive().max(FLOWS_MAX_LIMIT).optional(),
});

// --- Response shapes (FE consumes these through tRPC inference) -------------

/**
 * One deployed theme token, as the vault surfaces list them.
 *
 * Every other procedure in this router is keyed by `tokenId`, and
 * `LensDetail.vaultTokenId` is still null (BE-20's `TODO(BE-26)`), so without
 * this the web app has no way to learn which vault to read.
 */
export interface VaultListEntry {
  tokenId: string;
  name: string;
  symbol: string;
  /** Lens slug the theme tracks, e.g. "ai-infrastructure". */
  theme: string;
  /** The NAV poller's last AUM figure. Null until the first poll and whenever a
   *  poll could not read the vault. Never 0 as a stand-in (global do-not 2). */
  aumUsd: number | null;
  deployedAt: string;
}

export interface VaultNavPoint {
  ts: string;
  navPerShare: number;
}

export interface VaultNavHistory {
  nav: VaultNavPoint[];
  /** True when the market is closed or any constituent feed is stale. */
  indicative: boolean;
  range: NavRange;
}

export interface VaultMintQuote {
  /** Theme-token shares the deposit mints, net of the retained band. */
  shares: number;
  navPerShare: number;
  /** Mint/redeem band, percent. Guaranteed above the 0.5% oracle deviation
   *  threshold plus the streaming fee, or the quote is refused. */
  bandPct: number;
  /** Streaming fee, bps of AUM per year. Not a charge taken at mint. */
  feeBps: number;
  indicative: boolean;
}

export interface RedeemBasketLeg {
  symbol: string;
  tokenAddress: `0x${string}`;
  /** Constituent amount received in kind, human units. */
  amount: number;
  usdValue: number | null;
}

export interface RedeemRefusal {
  /** Plain-language reason, safe to show as-is. */
  reason: string;
  /** The USD ceiling the routed redeem holds NAV against. */
  limitUsd: number;
  /** The USD value of the requested redeem. */
  requestedUsd: number;
}

export interface VaultRedeemQuote {
  basket: RedeemBasketLeg[];
  usdValue: number | null;
  maxRedeemUsd: number;
  /**
   * In-kind redeem has no oracle or router dependency by design, so this stays
   * true even when every feed is stale. It is false only when the vault holds
   * no shares to redeem.
   */
  inKindAvailable: boolean;
  /**
   * Set when the requested redeem exceeds `maxRedeemUsd`. The routed exit to
   * USDG is unavailable above that limit; in-kind redeem still is. A structured
   * refusal, never a thrown error, so the UI can explain the limit (PART 6).
   */
  refusal: RedeemRefusal | null;
  indicative: boolean;
}

export interface VaultFlowEntry {
  ts: string;
  kind: "mint" | "redeem";
  user: `0x${string}`;
  usdValue: number | null;
  shares: number;
  navPerShare: number | null;
  txHash: string;
}

export interface VaultFlowPage {
  flows: VaultFlowEntry[];
  nextCursor: string | null;
}

/**
 * One unsigned transaction in a mint or redeem plan.
 *
 * A plan is a list rather than a single transaction because an in-kind mint is
 * genuinely N+1 transactions: one ERC-20 approval per constituent, then the
 * mint. The UI renders them as steps and the wallet signs them in order.
 */
export interface VaultTxStep {
  caller: string;
  /** Stable machine key, e.g. "approve:0xabc…" or "mint". */
  key: string;
  /** Human label rendered as a step in the UI, e.g. "Approve NVDA". */
  label: string;
  to: string;
  data: string;
  chainId: number;
  /** False when the step is already satisfied (allowance covers it) and can be
   *  skipped. */
  required: boolean;
}

/**
 * A mint or redeem plan, or the reason there is none.
 *
 * Same structured-refusal shape as `themeRouter`: an unknown vault, an empty
 * vault, an amount that rounds to nothing and a feed that will not read are all
 * facts a human has to be told, and none of them is a server failure. Thrown
 * errors stay reserved for a genuinely unreachable RPC and a missing session.
 */
export interface VaultTxPlan {
  ok: boolean;
  steps: VaultTxStep[];
  /** Same structured-refusal style as themeRouter. Null when ok. */
  refusal: { headline: string; detail: string } | null;
}

// --- Chain state ----------------------------------------------------------

interface ConstituentLeg {
  address: Address;
  /** Constituent tokens the vault holds, scaled by the token's own `decimals()`. */
  heldHuman: number;
  priceUsd: number | null;
  /** `heldHuman × priceUsd`, or null when either input could not be read. Never
   *  0 as a stand-in (global do-not 2). */
  valueUsd: number | null;
}

interface VaultState {
  navPerShare: number | null;
  aumUsd: number | null;
  driftPct: number;
  bandPct: number;
  indicative: boolean;
  maxRedeemUsd: number | null;
  supplyHuman: number | null;
  legs: ConstituentLeg[];
  targetPct: number[];
  actualPct: number[];
  fromChain: boolean;
  /** Observation start, never the browser response time or a cache-hit time. */
  observedAt: string | null;
  /** The block pinned for the complete display read, when chain-backed. */
  observedBlock: string | null;
  source: "chain" | "indexed";
}

function fromUnits(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function checksum(address: string): `0x${string}` {
  return getAddress(address);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * One `Multicall3` read of a vault's live state, pinned to a single testnet
 * block. Returns `null` when the RPC is unreachable; the caller decides whether
 * to serve from the poller cache (`summary`, `navHistory`) or to fail the
 * request (`mintQuote`, `redeemQuote`, which quote an imminent transaction).
 */
async function readVaultChain(
  row: ThemeTokenRecord,
  client: PublicClient = executionPublicClient,
  startedAt = Date.now(),
): Promise<VaultState | null> {
  const spec = row.spec;
  const vault = checksum(row.vault);
  const token = checksum(row.id);
  const constituents = spec.constituents.map(checksum);
  const feeds = spec.feeds.map(checksum);
  const n = constituents.length;
  const targetPct = spec.targetWeightsBps.map((bps) => bps / 100);

  const vaultCalls = [
    { address: vault, abi: keylessVaultAbi, functionName: "navIndicative" },
    { address: vault, abi: keylessVaultAbi, functionName: "navValue" },
    { address: vault, abi: keylessVaultAbi, functionName: "navPerShare" },
    { address: vault, abi: keylessVaultAbi, functionName: "currentDriftBps" },
    { address: vault, abi: keylessVaultAbi, functionName: "currentWeightsBps" },
    { address: vault, abi: keylessVaultAbi, functionName: "maxRedeemUsd" },
    { address: vault, abi: keylessVaultAbi, functionName: "mintRedeemBandBps" },
    { address: token, abi: themeTokenAbi, functionName: "totalSupply" },
  ] as const;

  const constituentCalls = constituents.flatMap(
    (address, i) =>
      [
        vaultBalanceCall(row, address, i),
        { address, abi: stockAbi, functionName: "uiMultiplier" },
        { address, abi: stockAbi, functionName: "decimals" },
        { address: feeds[i]!, abi: aggregatorV3Abi, functionName: "latestRoundData" },
        { address: feeds[i]!, abi: aggregatorV3Abi, functionName: "decimals" },
      ] as const,
  );

  let results: MulticallItem<unknown>[];
  let blockNumber: bigint;
  try {
    // viem's default block-number cache is intentionally bypassed here. A
    // display-cache miss is the fresh read boundary, and a successful vault
    // receipt must be able to advance that boundary immediately.
    blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    results = (await multicallRead([...vaultCalls, ...constituentCalls], {
      client,
      blockNumber,
    })) as unknown as MulticallItem<unknown>[];
  } catch (err) {
    log.warn("vault chain read failed", { tokenId: row.id, err });
    return null;
  }

  const navInd = decodeNavIndicative(results[0]);
  const strictAum = decodeUint(results[1]);
  const strictNps = decodeUint(results[2]);
  const strictDriftBps = decodeUint(results[3]);
  const strictWeightsBps = decodeUintArray(results[4]);
  const maxRedeemRaw = decodeUint(results[5]);
  const bandBpsRaw = decodeUint(results[6]);
  const supplyRaw = decodeUint(results[7]);

  const legs: ConstituentLeg[] = constituents.map((address, i) => {
    const base = vaultCalls.length + i * CALLS_PER_CONSTITUENT;
    const balRaw = decodeUint(results[base]);
    const multRaw = decodeUint(results[base + 1]);
    const decimals = decodeSmallUint(results[base + 2]) ?? DEFAULT_CONSTITUENT_DECIMALS;
    const round = decodeLatestRoundData(results[base + 3]);
    const feedDecimals = decodeSmallUint(results[base + 4]) ?? DEFAULT_FEED_DECIMALS;

    // `answer × uiMultiplier()`, the vault's own per-whole-token valuation
    // (BE-25b `_wholeTokenValueWad`). A structurally invalid round (`answer <= 0`
    // or `updatedAt == 0`) is not priced at all. Age is NOT a rejection here:
    // a stale feed still carries the last answer and the vault's own
    // `navIndicative()` prices it the same way (global do-not 1).
    const priceUsd =
      round !== null && round.answer > 0n && round.updatedAt > 0n && multRaw !== null
        ? (Number(round.answer) / 10 ** feedDecimals) * (Number(multRaw) / WAD)
        : null;
    const heldHuman = balRaw === null ? 0 : fromUnits(balRaw, decimals);
    const valueUsd = priceUsd === null || balRaw === null ? null : heldHuman * priceUsd;
    return { address, heldHuman, priceUsd, valueUsd };
  });

  const zeroSupply = supplyRaw === 0n;
  const supplyHuman = supplyRaw === null ? null : fromUnits(supplyRaw, spec.decimals);
  // `navIndicative()` answers `(0, true)` when supply is zero. That is "no
  // value", not "worth nothing", so it is never carried through as a price.
  const indicativeVal = navInd !== null && navInd.value > 0n ? fromWad(navInd.value) : null;
  const navPerShareStrict = strictNps === null ? null : fromWad(strictNps);
  const aumStrict = strictAum === null ? null : fromWad(strictAum);
  // A partial sum understates AUM, so the balance-derived total is only usable
  // when every leg priced. Null, never 0, otherwise (global do-not 2).
  const computedTotal = legs.every((leg) => leg.valueUsd !== null)
    ? legs.reduce((sum, leg) => sum + (leg.valueUsd ?? 0), 0)
    : null;

  // With no shares outstanding, `navPerShare()` reverts with `NoSupply` and
  // there is nothing to divide by. The first mint prices at 1.00 by
  // construction (`shares = depositTotal` when supply is 0, BE-25b), so that is
  // the rate a ticket would actually get. It is a seed rate, not a market price,
  // and `indicative` is true beside it because no feed backs it.
  const navPerShare = zeroSupply ? 1 : (navPerShareStrict ?? indicativeVal);
  // Multicall3 can return an all-failed array while the transport itself
  // answered successfully. That is not a display snapshot: keep the existing
  // indexed fallback (and transaction fail-closed behavior) rather than
  // caching a state whose NAV is null.
  if (navPerShare === null) return null;

  const aumUsd =
    aumStrict ??
    (indicativeVal !== null && supplyHuman !== null ? indicativeVal * supplyHuman : null) ??
    computedTotal;

  let actualPct: number[];
  if (strictWeightsBps && strictWeightsBps.length === n) {
    actualPct = strictWeightsBps.map((bps) => Number(bps) / 100);
  } else if (computedTotal !== null && computedTotal > 0) {
    const total = computedTotal;
    actualPct = legs.map((leg) => ((leg.valueUsd ?? 0) / total) * 100);
  } else {
    actualPct = [...targetPct];
  }

  const driftPct =
    strictDriftBps !== null
      ? Number(strictDriftBps) / 100
      : n === 0
        ? 0
        : Math.max(...actualPct.map((actual, i) => Math.abs(actual - (targetPct[i] ?? 0))));

  const marketClosed = getSession(new Date()) !== "rth";
  const feedStale = navInd ? navInd.stale : true;

  return {
    navPerShare,
    aumUsd,
    driftPct,
    bandPct: bandBpsRaw !== null ? Number(bandBpsRaw) / 100 : spec.mintRedeemBandBps / 100,
    indicative: marketClosed || feedStale || navPerShareStrict === null,
    maxRedeemUsd: maxRedeemRaw === null ? null : fromWad(maxRedeemRaw),
    supplyHuman,
    legs,
    targetPct,
    actualPct,
    fromChain: true,
    observedAt: new Date(startedAt).toISOString(),
    observedBlock: blockNumber.toString(),
    source: "chain",
  };
}

/** The latest NAV poller observation for a token, the cache `summary()` falls
 *  back to when the chain read fails. */
async function readCachedState(ctx: Context, row: ThemeTokenRecord): Promise<VaultState> {
  const [latest] = await ctx.db
    .select({
      navPerShare: navHistory.navPerShare,
      aumUsd: navHistory.aumUsd,
      ts: navHistory.ts,
    })
    .from(navHistory)
    .where(
      and(
        eq(navHistory.tokenId, row.id),
        eq(navHistory.executionDeploymentId, row.executionDeploymentId),
        eq(navHistory.canonical, true),
      ),
    )
    .orderBy(desc(navHistory.ts))
    .limit(1);

  const targetPct = row.spec.targetWeightsBps.map((bps) => bps / 100);
  return {
    navPerShare: latest?.navPerShare ?? null,
    aumUsd: latest?.aumUsd ?? row.aumUsd ?? null,
    driftPct: 0,
    bandPct: row.spec.mintRedeemBandBps / 100,
    // The chain could not be reached to confirm feed liveness, so the safe
    // reading is that pricing is indicative.
    indicative: true,
    maxRedeemUsd: null,
    supplyHuman: null,
    legs: [],
    targetPct,
    actualPct: [...targetPct],
    fromChain: false,
    observedAt: latest?.ts.toISOString() ?? null,
    observedBlock: null,
    source: "indexed",
  };
}

async function loadVault(
  ctx: Context,
  tokenId: string,
  verifiedExecution?: ExecutionContext | null,
): Promise<ThemeTokenRecord> {
  const execution =
    verifiedExecution === undefined ? await getExecutionContext() : verifiedExecution;
  const [row] = execution
    ? await ctx.db
        .select()
        .from(themeTokens)
        .where(
          and(
            eq(themeTokens.id, tokenId),
            eq(themeTokens.executionDeploymentId, execution.manifest.deploymentId),
            eq(themeTokens.canonical, true),
          ),
        )
        .limit(1)
    : [];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Theme token not found" });
  }
  return row;
}

/**
 * Select display metadata under the current manifest identity without waiting
 * for live endpoint, chain, bytecode or generation-marker verification.
 *
 * This is intentionally usable only by public metadata routes. Every route
 * that reads executable chain state or prepares a transaction continues to use
 * `loadVault`, which requires a verified execution context.
 */
async function loadVaultMetadataWithIdentity(
  ctx: Context,
  tokenId: string,
): Promise<{ row: ThemeTokenRecord; metadata: ExecutionMetadata }> {
  const metadata = getExecutionMetadata();
  const [row] = metadata
    ? await ctx.db
        .select()
        .from(themeTokens)
        .where(
          and(
            eq(themeTokens.id, tokenId),
            eq(themeTokens.executionDeploymentId, metadata.manifest.deploymentId),
            eq(themeTokens.canonical, true),
          ),
        )
        .limit(1)
    : [];
  if (!row || !metadata || !isExecutionMetadataCurrent(metadata)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Theme token not found" });
  }
  return { row, metadata };
}

async function loadVaultMetadata(ctx: Context, tokenId: string): Promise<ThemeTokenRecord> {
  return (await loadVaultMetadataWithIdentity(ctx, tokenId)).row;
}

function displayIdentity(execution: ExecutionContext, row: ThemeTokenRecord) {
  return {
    manifestDigest: execution.manifestDigest,
    providerIdentity:
      execution.providerIdentity ?? vaultDisplayProviderIdentity(execution.publicClient),
    deploymentId: execution.manifest.deploymentId,
    chainId: execution.manifest.chainId,
    tokenAddress: row.id,
    vaultAddress: row.vault,
  };
}

function displayImmutableSpec(row: ThemeTokenRecord) {
  // These are all deployment evidence, not user input. Including the event
  // identity as well as the policy prevents a repaired/replaced DB row from
  // inheriting a previous row's display observation.
  return {
    id: row.id,
    token: row.token,
    vault: row.vault,
    chainId: row.chainId,
    executionDeploymentId: row.executionDeploymentId,
    deployTx: row.deployTx,
    deployBlock: row.deployBlock,
    deployBlockHash: row.deployBlockHash,
    deployLogIndex: row.deployLogIndex,
    factoryAddress: row.factoryAddress,
    factoryVersion: row.factoryVersion,
    spec: row.spec,
  };
}

/** The chain state for a quote procedure, or a 503-style error when the testnet
 *  RPC is down: a mint / redeem ticket must not quote off a stale cache. */
async function requireChainState(row: ThemeTokenRecord): Promise<VaultState> {
  const state = await readVaultChain(row);
  if (!state) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The vault is temporarily unreachable. Try again in a moment.",
    });
  }
  return state;
}

// --- Constituent join ---------------------------------------------------

interface ConstituentMeta {
  symbol: string;
  paused: boolean;
  halted: boolean;
  hasFeed: boolean;
}

async function constituentMeta(
  ctx: Context,
  addresses: string[],
): Promise<Map<string, ConstituentMeta>> {
  if (addresses.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      address: sql<string>`lower(${universe.tokenAddress})`,
      symbol: universe.symbol,
      paused: universe.paused,
      tokenPaused: universe.tokenPaused,
      isTradingHalt: universe.isTradingHalt,
      hasFeed: sql<boolean>`${universe.chainlinkFeed} is not null`,
    })
    .from(universe)
    .where(inArray(sql`lower(${universe.tokenAddress})`, addresses));

  return new Map(
    rows.map((r) => [
      r.address,
      {
        symbol: r.symbol,
        paused: r.paused || r.tokenPaused,
        halted: r.isTradingHalt,
        hasFeed: r.hasFeed,
      },
    ]),
  );
}

// --- NAV history bucketing --------------------------------------------

/** Range window and the downsample bucket that keeps a series near ~200 points
 *  even though the poller writes one row a minute. */
const RANGE_CONFIG: Record<NavRange, { interval: string; bucket: string }> = {
  "1W": { interval: "7 days", bucket: "1 hour" },
  "1M": { interval: "30 days", bucket: "6 hours" },
  "6M": { interval: "180 days", bucket: "1 day" },
  "1Y": { interval: "365 days", bucket: "1 day" },
};

// --- Flow cursor -------------------------------------------------------

const flowCursorSchema = z
  .object({
    ts: z.iso.datetime({ offset: true }),
    txHash: z.string().min(1),
    logIndex: z.number().int().nonnegative(),
  })
  .strict();

type FlowCursor = z.infer<typeof flowCursorSchema>;

function encodeFlowCursor(cursor: FlowCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeFlowCursor(raw: string): FlowCursor {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return flowCursorSchema.parse(json);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid flow cursor" });
  }
}

// --- Write path: transaction building --------------------------------
//
// Everything below encodes calldata and nothing below sends it. The routed
// pair (`mintWithUsdg`, `redeemToUsdg`) is out of scope on purpose: both swap
// through a venue on the vault's immutable allowlist, and 46630 has no venue
// with real liquidity, so a routed transaction encoded today reverts on its
// first leg. See the file docblock.

function txRefusal(headline: string, detail: string): VaultTxPlan {
  return { ok: false, steps: [], refusal: { headline, detail } };
}

/**
 * A human amount to native units, exactly.
 *
 * Routed through micro-units the way `themeRouter`'s `toWad` is, so a large
 * figure never leaves float range mid-conversion and `1.1` does not arrive as
 * `1.100000000000000088817841970012523233890533447265625` scaled by 1e18.
 */
function toUnits(value: number, decimals: number): bigint {
  if (decimals <= 6) return BigInt(Math.max(0, Math.round(value * 10 ** decimals)));
  return BigInt(Math.max(0, Math.round(value * 1e6))) * 10n ** BigInt(decimals - 6);
}

/** The vault a token id names, or `undefined`. Unlike `loadVault` this does not
 *  throw: on the write path an unknown token is a refusal the ticket renders. */
async function findVault(
  ctx: Context,
  tokenId: string,
  verifiedExecution?: ExecutionContext | null,
): Promise<ThemeTokenRecord | undefined> {
  const execution =
    verifiedExecution === undefined ? await getExecutionContext() : verifiedExecution;
  if (!execution) return undefined;
  const [row] = await ctx.db
    .select()
    .from(themeTokens)
    .where(
      and(
        eq(themeTokens.id, tokenId),
        eq(themeTokens.executionDeploymentId, execution.manifest.deploymentId),
        eq(themeTokens.canonical, true),
      ),
    )
    .limit(1);
  return row;
}

interface MintLegRead {
  address: Address;
  decimals: number;
  /**
   * USD (1e18) per WHOLE token: the vault's own `_wholeTokenValueWad`, which is
   * the feed answer rescaled to WAD and multiplied by `uiMultiplier()`. Null
   * when the feed did not read or answered a structurally invalid round.
   */
  wholeTokenValueWad: bigint | null;
  /** The vault's raw holding, for the NAV the mint prices against. */
  vaultBalance: bigint | null;
  /** `allowance(caller, vault)`. Null when the read itself failed. */
  allowance: bigint | null;
}

interface MintChainRead {
  legs: MintLegRead[];
  /** Raw `ThemeToken.totalSupply()`. Zero is a real answer: the first mint. */
  supply: bigint;
  bandBps: bigint;
}

/**
 * Everything `mint()` calldata needs, in ONE `Multicall3` request pinned to a
 * single block, in raw integers.
 *
 * Six reads per constituent and two vault-level reads. The read paths above
 * already batch, and a write path that looped `readContract` per constituent
 * would be the same defect for the same reason (see `chain/multicall.ts`).
 *
 * Raw, not the `VaultState` the quote paths build, because that one carries
 * floats for display. `mint` reverts with `DepositOffTargetWeight(i)` when a
 * leg's deposit VALUE misses its target weight, so the amounts have to be
 * derived from the same integers the vault will divide by.
 */
async function readMintChain(row: ThemeTokenRecord, owner: Address): Promise<MintChainRead | null> {
  const spec = row.spec;
  const vault = checksum(row.vault);
  const token = checksum(row.id);
  const constituents = spec.constituents.map(checksum);
  const feeds = spec.feeds.map(checksum);

  const vaultCalls = [
    { address: vault, abi: keylessVaultAbi, functionName: "mintRedeemBandBps" },
    { address: token, abi: themeTokenAbi, functionName: "totalSupply" },
  ] as const;

  const constituentCalls = constituents.flatMap(
    (address, i) =>
      [
        vaultBalanceCall(row, address, i),
        { address, abi: stockAbi, functionName: "uiMultiplier" },
        { address, abi: stockAbi, functionName: "decimals" },
        { address: feeds[i]!, abi: aggregatorV3Abi, functionName: "latestRoundData" },
        { address: feeds[i]!, abi: aggregatorV3Abi, functionName: "decimals" },
        // `stockAbi` is a read-only ABI by design, so the ERC-20 approval pair
        // comes from viem's own `erc20Abi` rather than being bolted onto it.
        { address, abi: erc20Abi, functionName: "allowance", args: [owner, vault] },
      ] as const,
  );

  let results: MulticallItem<unknown>[];
  try {
    const blockNumber = await executionPublicClient.getBlockNumber();
    results = (await multicallRead([...vaultCalls, ...constituentCalls], {
      client: executionPublicClient,
      blockNumber,
    })) as unknown as MulticallItem<unknown>[];
  } catch (err) {
    log.warn("mint tx chain read failed", { tokenId: row.id, err });
    return null;
  }

  const bandBpsRaw = decodeUint(results[0]);
  const supplyRaw = decodeUint(results[1]);
  if (supplyRaw === null) return null;

  const legs: MintLegRead[] = constituents.map((address, i) => {
    const base = vaultCalls.length + i * CALLS_PER_MINT_CONSTITUENT;
    const balRaw = decodeUint(results[base]);
    const multRaw = decodeUint(results[base + 1]);
    const decimals = decodeSmallUint(results[base + 2]) ?? DEFAULT_CONSTITUENT_DECIMALS;
    const round = decodeLatestRoundData(results[base + 3]);
    const feedDecimals = decodeSmallUint(results[base + 4]) ?? DEFAULT_FEED_DECIMALS;
    const allowance = decodeUint(results[base + 5]);

    // The vault's `_feedPriceWad` guards, minus the age guard. Age is NOT
    // checked here: `mint` reverts on a stale feed, which is the designed safe
    // failure (global do-not 1), and this router has no business predicting
    // that revert from a heartbeat it does not hold. A structurally invalid
    // round is different, because it prices to nothing at all.
    const wholeTokenValueWad =
      round !== null && round.answer > 0n && round.updatedAt > 0n && multRaw !== null
        ? (((round.answer * ONE_WAD) / 10n ** BigInt(feedDecimals)) * multRaw) / ONE_WAD
        : null;

    return { address, decimals, wholeTokenValueWad, vaultBalance: balRaw, allowance };
  });

  return {
    legs,
    supply: supplyRaw,
    bandBps: bandBpsRaw ?? BigInt(spec.mintRedeemBandBps),
  };
}

// --- Router ----------------------------------------------------------

export const vaultRouter = router({
  /** Address-exact navigation, including vaults older than the capped list.
   * No balance/creator filter: zero-share holders still need deferred claims. */
  lookup: publicProcedure
    .input(tokenIdInput)
    .query(async ({ ctx, input }): Promise<VaultListEntry> => {
      const row = await loadVaultMetadata(ctx, input.tokenId);
      return {
        tokenId: row.id,
        name: row.spec.name,
        symbol: row.spec.symbol,
        theme: row.theme,
        aumUsd: row.aumUsd,
        deployedAt: row.deployedAt.toISOString(),
      };
    }),
  /**
   * Official presets in catalog order. A newly indexed contract can never
   * become the default vault. Address-specific recovery uses `lookup` instead.
   */
  list: publicProcedure.query(async ({ ctx }): Promise<VaultListEntry[]> => {
    const rows = await officialVaultsMetadata(ctx);

    return rows.map((row) => ({
      tokenId: row.id,
      name: row.spec.name,
      symbol: row.spec.symbol,
      theme: row.theme,
      aumUsd: row.aumUsd,
      deployedAt: row.deployedAt.toISOString(),
    }));
  }),

  /**
   * A vault's live NAV, AUM, drift and composition. Reads the chain and prefers
   * the vault's own strict views, so the figures match a direct on-chain read.
   */
  summary: publicProcedure
    .input(tokenIdInput)
    .query(async ({ ctx, input }): Promise<VaultSummary> => {
      // Readiness and canonical DB identity are deliberately outside the
      // display cache. A warm process-local snapshot cannot keep an orphaned
      // row, an old manifest, or an old provider executable.
      const execution = await getExecutionContext();
      if (!execution) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The verified execution context is not ready; retry the display read.",
        });
      }
      const row = await loadVault(ctx, input.tokenId, execution);
      const identity = displayIdentity(execution, row);
      const scope = vaultDisplayScope(identity);
      const key = vaultDisplayKey(scope, displayImmutableSpec(row));
      const generation = vaultDisplayCache.generation(scope);

      let chainState: VaultState | null = null;
      try {
        chainState = await vaultDisplayCache.read({
          key,
          scope,
          load: (startedAt) => readVaultChain(row, execution.publicClient, startedAt),
          observedBlock: (value) =>
            value.observedBlock === null ? null : BigInt(value.observedBlock),
        });
      } catch {
        // A failed display read is handled by the existing indexed fallback.
        // The cache never stores the failure, so the next request retries RPC.
        // Keep the exception out of structured fields: provider errors can
        // carry URLs, request bodies and other credential-bearing diagnostics.
        log.warn("vault display snapshot unavailable", { tokenId: row.id });
      }

      // Recheck both execution and canonical DB identity after the awaited
      // read. Context resets, provider/manifest changes and a withdrawn row
      // must not let a pre-change pending read become a current summary.
      const currentExecution = await getExecutionContext();
      let currentRow: ThemeTokenRecord;
      try {
        currentRow = await loadVault(ctx, input.tokenId, currentExecution);
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The vault execution identity changed; retry the display read.",
        });
      }
      if (!currentExecution) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The verified execution context is no longer ready; retry the display read.",
        });
      }
      const currentScope = vaultDisplayScope(displayIdentity(currentExecution, currentRow));
      const currentKey = vaultDisplayKey(currentScope, displayImmutableSpec(currentRow));
      if (currentScope !== scope || currentKey !== key) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The vault identity changed; retry the display read.",
        });
      }

      // This join remains intentionally outside the cache. Pause/halt badges
      // are mutable DB safety metadata and must be current for every caller.
      const spec = currentRow.spec;
      // The receipt poller can invalidate a completed cache hit while the DB
      // state is being selected. Do not let that pre-receipt chain state win
      // the final response race; an indexed fallback is explicit and honest.
      if (
        chainState &&
        !vaultDisplayCache.isCurrent(
          scope,
          chainState.observedBlock === null ? null : BigInt(chainState.observedBlock),
          generation,
        )
      ) {
        chainState = null;
      }
      const state = chainState ?? (await readCachedState(ctx, currentRow));
      const meta = await constituentMeta(ctx, spec.constituents);

      // These are the last awaited operations before publication. Recheck the
      // canonical row and execution generation here too: the row/context may
      // have changed while the indexed fallback or metadata join was waiting.
      const finalExecution = await getExecutionContext();
      let finalRow: ThemeTokenRecord;
      try {
        finalRow = await loadVault(ctx, input.tokenId, finalExecution);
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The vault execution identity changed; retry the display read.",
        });
      }
      if (
        !finalExecution ||
        vaultDisplayScope(displayIdentity(finalExecution, finalRow)) !== scope ||
        vaultDisplayKey(
          vaultDisplayScope(displayIdentity(finalExecution, finalRow)),
          displayImmutableSpec(finalRow),
        ) !== key ||
        (chainState &&
          !vaultDisplayCache.isCurrent(
            scope,
            chainState.observedBlock === null ? null : BigInt(chainState.observedBlock),
            generation,
          ))
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The vault display snapshot is no longer current; retry the display read.",
        });
      }

      if (state.navPerShare === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Vault NAV is not available yet",
        });
      }

      const constituents: VaultConstituent[] = spec.constituents.map((address, i) => {
        const info = meta.get(address);
        const leg = state.legs[i];
        return {
          symbol: info?.symbol ?? shortAddress(address),
          tokenAddress: checksum(address),
          targetWeightPct: state.targetPct[i] ?? 0,
          actualWeightPct: state.actualPct[i] ?? 0,
          priceUsd: leg?.priceUsd ?? null,
          paused: info?.paused ?? false,
          halted: info?.halted ?? false,
        };
      });

      const withFeed = spec.constituents.filter((address) => meta.get(address)?.hasFeed).length;

      // `VaultSummary.aumUsd` is a plain number, so an unreadable AUM has to
      // resolve to something. Prefer the identity the vault itself uses
      // (`navPerShare × supply`), then the poller's last figure, and only then 0,
      // which by that point means an empty vault rather than a stand-in price.
      const aumUsd =
        state.aumUsd ??
        (state.supplyHuman === null ? null : state.navPerShare * state.supplyHuman) ??
        currentRow.aumUsd ??
        0;

      return {
        tokenId: currentRow.id,
        name: spec.name,
        symbol: spec.symbol,
        navPerShare: state.navPerShare,
        indicative: state.indicative,
        aumUsd,
        driftPct: state.driftPct,
        constituents,
        feedCoverage: { withFeed, total: spec.constituents.length },
        observedAt: state.observedAt,
        observedBlock: state.observedBlock,
        source: state.source,
      };
    }),

  /**
   * The connected wallet's exact balances on the configured execution chain.
   * This is deliberately protected: the account comes from the verified SIWE
   * session, never from the browser. Raw integers stay strings across the API
   * so the dashboard can render a usable `Max` amount without a float round
   * trip. The same pinned read includes vault holdings for the in-kind exit
   * preview and the smallest-leg basket capacity.
   */
  walletBalances: protectedProcedure.input(tokenIdInput).query(async ({ ctx, input }) => {
    const context = await getExecutionContext();
    const row = await findVault(ctx, input.tokenId, context);
    if (!row) {
      return {
        status: "unavailable" as const,
        chainId: null,
        message: "This vault is not indexed under the active execution deployment.",
      };
    }

    if (!context) {
      return {
        status: "unavailable" as const,
        chainId: null,
        message: "The verified execution context is not ready, so wallet balances cannot be read.",
      };
    }

    const owner = getAddress(ctx.session.address);
    const usdg = getAddress(context.manifest.usdg.address);
    const share = getAddress(row.id);
    const vault = getAddress(row.vault);
    const constituents = row.spec.constituents.map(checksum);
    const feeds = row.spec.feeds.map(checksum);
    const meta = await constituentMeta(ctx, row.spec.constituents);

    const vaultCalls = [
      { address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: share, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: share, abi: themeTokenAbi, functionName: "totalSupply" },
      { address: vault, abi: keylessVaultAbi, functionName: "maxRedeemUsd" },
    ] as const;
    const constituentCalls = constituents.flatMap(
      (address, i) =>
        [
          { address, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
          { address, abi: stockAbi, functionName: "decimals" },
          { address, abi: stockAbi, functionName: "uiMultiplier" },
          { address: feeds[i]!, abi: aggregatorV3Abi, functionName: "latestRoundData" },
          { address: feeds[i]!, abi: aggregatorV3Abi, functionName: "decimals" },
          vaultBalanceCall(row, address, i),
        ] as const,
    );

    try {
      // Wallet state is execution data, never a display-cache hit. Bypass
      // viem's default head cache so a just-mined action is visible here.
      const blockNumber = await context.publicClient.getBlockNumber({ cacheTime: 0 });
      const [rawResults, nativeBalance] = await Promise.all([
        multicallRead([...vaultCalls, ...constituentCalls], {
          client: context.publicClient,
          blockNumber,
        }),
        context.publicClient.getBalance({ address: owner, blockNumber }),
      ]);
      const results = rawResults as unknown as MulticallItem<unknown>[];
      const usdgBalance = decodeUint(results[0]);
      const shareBalance = decodeUint(results[1]);
      const supply = decodeUint(results[2]);
      const maxRedeemUsd = decodeUint(results[3]);
      if (usdgBalance === null || shareBalance === null || supply === null) {
        return {
          status: "unavailable" as const,
          chainId: context.manifest.chainId,
          message: "The execution node returned an incomplete wallet balance read.",
        };
      }

      const walletConstituents = constituents.map((address, i) => {
        const base = vaultCalls.length + i * 6;
        const balance = decodeUint(results[base]);
        const decimals = decodeSmallUint(results[base + 1]) ?? DEFAULT_CONSTITUENT_DECIMALS;
        const multiplier = decodeUint(results[base + 2]);
        const round = decodeLatestRoundData(results[base + 3]);
        const feedDecimals = decodeSmallUint(results[base + 4]) ?? DEFAULT_FEED_DECIMALS;
        const vaultBalance = decodeUint(results[base + 5]);
        const wholeValueWad =
          round !== null && round.answer > 0n && round.updatedAt > 0n && multiplier !== null
            ? (((round.answer * ONE_WAD) / 10n ** BigInt(feedDecimals)) * multiplier) / ONE_WAD
            : null;
        const weight = BigInt(row.spec.targetWeightsBps[i] ?? 0);
        const capacity =
          balance !== null && wholeValueWad !== null && weight > 0n
            ? (balance * wholeValueWad * BPS) / (weight * 10n ** BigInt(decimals))
            : null;
        return {
          address,
          symbol: meta.get(address.toLowerCase())?.symbol ?? shortAddress(address),
          decimals,
          targetWeightBps: Number(weight),
          balanceRaw: (balance ?? 0n).toString(),
          vaultBalanceRaw: (vaultBalance ?? 0n).toString(),
          wholeValueWad: wholeValueWad?.toString() ?? null,
          capacityRaw: capacity?.toString() ?? null,
        };
      });
      const capacities = walletConstituents
        .map((leg) => (leg.capacityRaw === null ? null : BigInt(leg.capacityRaw)))
        .filter((value): value is bigint => value !== null);
      const maxBasketNotionalRaw =
        capacities.length === walletConstituents.length && capacities.length > 0
          ? capacities.reduce((min, value) => (value < min ? value : min)).toString()
          : null;

      return {
        status: "ready" as const,
        chainId: context.manifest.chainId,
        blockNumber: blockNumber.toString(),
        nativeBalanceRaw: nativeBalance.toString(),
        usdg: {
          address: usdg,
          symbol: "USDG",
          decimals: context.manifest.usdg.decimals,
          balanceRaw: usdgBalance.toString(),
        },
        shares: {
          address: share,
          symbol: row.spec.symbol,
          decimals: row.spec.decimals,
          balanceRaw: shareBalance.toString(),
        },
        supplyRaw: supply.toString(),
        maxRedeemUsdRaw: maxRedeemUsd?.toString() ?? null,
        maxBasketNotionalRaw,
        constituents: walletConstituents,
      };
    } catch (error) {
      log.warn("wallet balance read failed", { tokenId: row.id, owner, error });
      return {
        status: "unavailable" as const,
        chainId: context.manifest.chainId,
        message: "The execution node did not answer the wallet balance read. Try again shortly.",
      };
    }
  }),

  /**
   * The NAV-per-share series for a range, downsampled.
   *
   * `indicative` is true when the market is closed now, or the newest poller
   * observation was indicative. That flag already means "market closed, or a
   * constituent feed was stale, or the strict read reverted" (BE-26), and the
   * poller writes one a minute, so it is the live answer to requirement 6 rather
   * than a per-bucket average of one. With no observation at all it is true: an
   * unknown NAV is not a firm one.
   */
  navHistory: publicProcedure
    .input(navHistoryInput)
    .query(async ({ ctx, input }): Promise<VaultNavHistory> => {
      const { row, metadata } = await loadVaultMetadataWithIdentity(ctx, input.tokenId);
      const { interval, bucket } = RANGE_CONFIG[input.range];

      const [rows, [latest]] = await Promise.all([
        ctx.db.execute<{
          bucket: string | Date;
          nav_per_share: number | string | null;
        }>(sql`
          SELECT time_bucket(${bucket}::interval, ${navHistory.ts}) AS bucket,
                 avg(${navHistory.navPerShare})::float8 AS nav_per_share
          FROM ${navHistory}
            WHERE ${navHistory.tokenId} = ${input.tokenId}
            AND ${navHistory.executionDeploymentId} = ${row.executionDeploymentId}
            AND ${navHistory.canonical} = true
            AND ${navHistory.ts} >= now() - ${interval}::interval
          GROUP BY bucket
          ORDER BY bucket ASC
        `),
        ctx.db
          .select({ indicative: navHistory.indicative })
          .from(navHistory)
          .where(
            and(
              eq(navHistory.tokenId, input.tokenId),
              eq(navHistory.executionDeploymentId, row.executionDeploymentId),
              eq(navHistory.canonical, true),
            ),
          )
          .orderBy(desc(navHistory.ts))
          .limit(1),
      ]);
      if (!isExecutionMetadataCurrent(metadata)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Theme token not found" });
      }

      const nav: VaultNavPoint[] = [];
      for (const r of rows) {
        if (r.nav_per_share === null) continue;
        const value = Number(r.nav_per_share);
        if (!Number.isFinite(value)) continue;
        const ts = r.bucket instanceof Date ? r.bucket : new Date(r.bucket);
        nav.push({ ts: ts.toISOString(), navPerShare: value });
      }

      const marketClosed = getSession(new Date()) !== "rth";
      return {
        nav,
        indicative: marketClosed || (latest?.indicative ?? true),
        range: input.range,
      };
    }),

  /** What `usdIn` mints today: shares net of the retained band, plus the band
   *  and streaming-fee figures the ticket displays. */
  mintQuote: publicProcedure
    .input(mintQuoteInput)
    .query(async ({ ctx, input }): Promise<VaultMintQuote> => {
      const row = await loadVault(ctx, input.tokenId);
      const state = await requireChainState(row);

      if (state.navPerShare === null || state.navPerShare <= 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Vault NAV is not available yet",
        });
      }

      // The band must exceed the feed's 0.5% deviation threshold PLUS the fee,
      // or the oracle's bounded error can be arbitraged out of the vault
      // (PART 4). `KeylessVault`'s constructor enforces exactly this bound;
      // asserting it again here means a vault deployed by anything other than
      // that constructor surfaces rather than quoting a band it cannot honour.
      const bandBps = Math.round(state.bandPct * 100);
      if (bandBps <= DEVIATION_THRESHOLD_BPS + row.creatorFeeBps) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Vault mint/redeem band does not clear the oracle deviation threshold plus fee",
        });
      }

      const grossShares = input.usdIn / state.navPerShare;
      const shares = grossShares * (1 - state.bandPct / 100);

      return {
        shares,
        navPerShare: state.navPerShare,
        bandPct: state.bandPct,
        feeBps: row.creatorFeeBps,
        indicative: state.indicative,
      };
    }),

  /**
   * The in-kind basket `shares` redeems, its USD value, and the routed-redeem
   * ceiling. Past `maxRedeemUsd` the response carries a structured `refusal`,
   * never a thrown error: in-kind redeem is still available and the UI needs to
   * say so (PART 6, requirement 3).
   */
  redeemQuote: publicProcedure
    .input(redeemQuoteInput)
    .query(async ({ ctx, input }): Promise<VaultRedeemQuote> => {
      const row = await loadVault(ctx, input.tokenId);
      const state = await requireChainState(row);
      const meta = await constituentMeta(ctx, row.spec.constituents);

      if (state.maxRedeemUsd === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Vault redeem limit is not available",
        });
      }

      const supply = state.supplyHuman;
      if (supply === null || supply <= 0) {
        return {
          basket: [],
          usdValue: 0,
          maxRedeemUsd: state.maxRedeemUsd,
          inKindAvailable: false,
          refusal: {
            reason: "This vault holds no shares to redeem.",
            limitUsd: state.maxRedeemUsd,
            requestedUsd: 0,
          },
          indicative: state.indicative,
        };
      }

      // Not a policy refusal, an impossible request: `redeem()` burns first and
      // reverts on a short balance, so a fraction above 1 could only describe a
      // basket the vault does not hold.
      if (input.shares > supply) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That is more shares than exist. Reduce the amount.",
        });
      }

      const fraction = input.shares / supply;
      const basket: RedeemBasketLeg[] = row.spec.constituents.map((address, i) => {
        const leg = state.legs[i];
        const legUsd = leg?.valueUsd ?? null;
        return {
          symbol: meta.get(address)?.symbol ?? shortAddress(address),
          tokenAddress: checksum(address),
          // Balances, not prices: this is what `redeem()` transfers, and it
          // reads no oracle to work it out.
          amount: (leg?.heldHuman ?? 0) * fraction,
          usdValue: legUsd === null ? null : legUsd * fraction,
        };
      });

      // A basket nothing could be priced against is unpriceable, not worthless,
      // so the total is null and the UI renders "-" (global do-not 2). It never
      // sums a partial basket into a number that reads as the whole one.
      const pricedTotal = basket.every((leg) => leg.usdValue !== null)
        ? basket.reduce((sum, leg) => sum + (leg.usdValue ?? 0), 0)
        : null;
      const usdValue = state.aumUsd !== null ? state.aumUsd * fraction : pricedTotal;

      const refusal: RedeemRefusal | null =
        usdValue !== null && usdValue > state.maxRedeemUsd
          ? {
              reason:
                "A routed redeem to USDG is capped for this vault. Redeem in kind for the full basket, or reduce the amount.",
              limitUsd: state.maxRedeemUsd,
              requestedUsd: usdValue,
            }
          : null;

      return {
        basket,
        usdValue,
        maxRedeemUsd: state.maxRedeemUsd,
        // The exit of last resort has no oracle or router dependency, so it is
        // available whenever the vault has supply, stale feeds or not.
        inKindAvailable: true,
        refusal,
        indicative: state.indicative,
      };
    }),

  /** The mint / redeem log for a vault, newest first, keyset-paginated. */
  flows: publicProcedure.input(flowsInput).query(async ({ ctx, input }): Promise<VaultFlowPage> => {
    const { metadata } = await loadVaultMetadataWithIdentity(ctx, input.tokenId);
    const limit = input.limit ?? FLOWS_DEFAULT_LIMIT;

    const conditions = [
      eq(flows.tokenId, input.tokenId),
      eq(flows.executionDeploymentId, metadata.manifest.deploymentId),
      eq(flows.canonical, true),
    ];
    if (input.cursor) {
      const cursor = decodeFlowCursor(input.cursor);
      const ts = new Date(cursor.ts);
      const keyset = or(
        lt(flows.ts, ts),
        and(eq(flows.ts, ts), lt(flows.txHash, cursor.txHash)),
        and(eq(flows.ts, ts), eq(flows.txHash, cursor.txHash), lt(flows.logIndex, cursor.logIndex)),
      );
      if (keyset) conditions.push(keyset);
    }

    const rows = await ctx.db
      .select({
        ts: flows.ts,
        kind: flows.kind,
        user: flows.user,
        usd: flows.usd,
        shares: flows.shares,
        navPerShare: flows.navPerShare,
        txHash: flows.txHash,
        logIndex: flows.logIndex,
      })
      .from(flows)
      .where(and(...conditions))
      .orderBy(desc(flows.ts), desc(flows.txHash), desc(flows.logIndex))
      .limit(limit + 1);

    if (!isExecutionMetadataCurrent(metadata)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Theme token not found" });
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      flows: page.map((r) => ({
        ts: r.ts.toISOString(),
        kind: r.kind,
        user: checksum(r.user),
        usdValue: r.usd,
        shares: r.shares,
        navPerShare: r.navPerShare,
        txHash: r.txHash,
      })),
      nextCursor:
        hasMore && last
          ? encodeFlowCursor({
              ts: last.ts.toISOString(),
              txHash: last.txHash,
              logIndex: last.logIndex,
            })
          : null,
    };
  }),

  /**
   * Preliminary action quote. A missing allowance is a useful answer, not a
   * simulated-ready trade: the caller first receives exact, bounded approvals.
   * Legacy `mintTx` / `redeemTx` remain below for dashboard migration in stage
   * 11, but new wallet work must use this decimal-string interface.
   */
  deferredClaims: protectedProcedure.input(tokenIdInput).query(async ({ ctx, input }) => {
    const execution = await getExecutionContext();
    const row = await findVault(ctx, input.tokenId, execution);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    if (!supportsDeferredClaims(row)) return { supported: false as const, claims: [] };
    if (!execution)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Execution unavailable" });
    const owner = getAddress(ctx.session.address);
    const vault = getAddress(row.vault);
    const meta = await constituentMeta(ctx, row.spec.constituents);
    // Pin every claim read to one fresh block. `deferredUnits` is required
    // state: a failed units call rejects the whole response, just as the old
    // direct read did. Balance and decimals are display enrichments and may
    // remain null when their individual calls fail.
    const blockNumber = await execution.publicClient.getBlockNumber({ cacheTime: 0 });
    const calls = row.spec.constituents.flatMap(
      (token, index) =>
        [
          {
            address: vault,
            abi: keylessVaultAbi,
            functionName: "deferredUnits",
            args: [owner, BigInt(index)],
          },
          {
            address: vault,
            abi: keylessVaultAbi,
            functionName: "deferredBalance",
            args: [owner, BigInt(index)],
          },
          { address: getAddress(token), abi: erc20Abi, functionName: "decimals" },
        ] as const,
    );
    const rawResults = await multicallRead(calls, {
      client: execution.publicClient,
      blockNumber,
    });
    const results = rawResults as unknown as MulticallItem<unknown>[];
    const claims = row.spec.constituents.flatMap((token, index) => {
      const base = index * 3;
      const units = decodeUint(results[base]);
      if (units === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The execution node returned an incomplete deferred-claim read.",
        });
      }
      if (units === 0n) return [];
      const amount = decodeUint(results[base + 1]);
      const decimals = decodeSmallUint(results[base + 2]);
      return [
        {
          index,
          token,
          symbol: meta.get(token.toLowerCase())?.symbol ?? shortAddress(token),
          units: units.toString(),
          amountRaw: amount?.toString() ?? null,
          amount: amount !== null && decimals !== null ? formatUnits(amount, decimals) : null,
        },
      ];
    });
    return { supported: true as const, claims };
  }),

  claimDeferredPlan: protectedProcedure
    .input(
      z.object({
        tokenId: z.string().min(1).max(100),
        index: z.number().int().min(0).max(15),
        recipient: z
          .string()
          .regex(/^0x[\da-fA-F]{40}$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await findVault(ctx, input.tokenId);
      const execution = await getExecutionContext();
      if (!row || !execution || !supportsDeferredClaims(row))
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This vault has no supported deferred-claim path.",
        });
      const owner = getAddress(ctx.session.address);
      const recipient = input.recipient ? getAddress(input.recipient) : owner;
      const vault = getAddress(row.vault);
      const args = [BigInt(input.index), recipient] as const;
      const simulated = await execution.publicClient.simulateContract({
        address: vault,
        abi: keylessVaultAbi,
        functionName: "claimDeferred",
        args,
        account: owner,
      });
      const data = encodeFunctionData({
        abi: keylessVaultAbi,
        functionName: "claimDeferred",
        args,
      });
      const gas = await execution.publicClient.estimateGas({ account: owner, to: vault, data });
      return {
        caller: owner,
        chainId: execution.manifest.chainId,
        manifestDigest: execution.manifestDigest,
        to: vault,
        data,
        value: "0" as const,
        gasEstimate: gas.toString(),
        amountRaw: simulated.result.toString(),
        recipient,
      };
    }),

  actionQuote: protectedProcedure.input(actionQuoteInput).mutation(async ({ ctx, input }) => {
    const row = await findVault(ctx, input.vaultId);
    if (!row) {
      return {
        status: "refused" as const,
        code: "UNKNOWN_VAULT",
        message: "This vault is not indexed under the active execution deployment.",
      };
    }
    return quoteVaultAction(row, getAddress(ctx.session.address), {
      action: input.action,
      amount: input.amount,
      denomination: input.denomination as AmountDenomination,
      slippageBps: input.slippageBps,
    });
  }),

  actionReceipt: publicProcedure
    .input(
      z.object({
        vaultId: z.string().min(1).max(100),
        hash: z.string().regex(/^0x[\da-fA-F]{64}$/),
      }),
    )
    .query(async ({ ctx, input }) => {
      const row = await findVault(ctx, input.vaultId);
      const execution = await getExecutionContext();
      if (!row || !execution) return { status: "unavailable" as const, indexed: false };
      const receipt = await execution.publicClient
        .getTransactionReceipt({ hash: input.hash as `0x${string}` })
        .catch(() => null);
      if (!receipt) return { status: "pending" as const, indexed: false };
      const targets = [row.vault, execution.manifest.usdg.address, ...row.spec.constituents].map(
        (a) => a.toLowerCase(),
      );
      if (!receipt.to || !targets.includes(receipt.to.toLowerCase()))
        return { status: "unrelated" as const, indexed: false };
      const block = await execution.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) return { status: "pending" as const, indexed: false };
      if (receipt.status !== "success") return { status: "reverted" as const, indexed: false };
      // Only a verified, canonical, successful receipt can advance the display
      // watermark. The cache compares this monotonic block with both completed
      // and in-flight summaries; repeated receipt polling is idempotent.
      // The allowlist above also recognizes approval receipts so the wallet
      // ticket can advance its allowance walk. Only a call whose target is the
      // backing vault changes NAV/holdings and may invalidate display state.
      if (receipt.to?.toLowerCase() === row.vault.toLowerCase()) {
        vaultDisplayCache.invalidate(
          vaultDisplayScope(displayIdentity(execution, row)),
          receipt.blockNumber,
        );
      }
      const rows = await ctx.db
        .select({ hash: flows.txHash })
        .from(flows)
        .where(
          and(
            eq(flows.tokenId, row.id),
            eq(flows.executionDeploymentId, execution.manifest.deploymentId),
            eq(flows.canonical, true),
            eq(flows.txHash, input.hash.toLowerCase()),
          ),
        )
        .limit(1);
      return { status: "mined" as const, indexed: rows.length > 0 };
    }),

  /** Rechecks the quote's caller and deployment, then performs the final
   * whole-call simulation with current balances and allowances. It only returns
   * unsigned calldata; no API or worker signer exists on this path. */
  actionPlan: protectedProcedure
    .input(actionPlanInput)
    .mutation(async ({ ctx, input }) =>
      planVaultAction(input.quoteId as `0x${string}`, getAddress(ctx.session.address)),
    ),

  /**
   * The unsigned transactions that mint `usdAmount` of this vault in kind: one
   * `approve` per constituent, then `mint(amountsIn, to, minSharesOut)`.
   *
   * ## The amounts are value-weighted, and that is the whole difficulty
   *
   * `mint` calls `_requireOnTargetWeight`, which prices every leg of the deposit
   * and reverts with `DepositOffTargetWeight(i)` unless each leg's VALUE sits
   * within `mintRedeemBandBps` of its target weight. Equal token counts across
   * names priced from $200 to $500 are nowhere near target, so the amounts are
   * `_valueOf` inverted, off the vault's own feeds and its own policy weights:
   *
   *     wholeTokenValueWad = answer · 1e18 / 10^feedDecimals · uiMultiplier / 1e18
   *     amount_i           = (usd · 1e18 · weightBps_i / 10000) · 10^decimals_i
   *                          / wholeTokenValueWad_i
   *
   * `contracts/script/SeedVault.s.sol` does exactly this on the local chain and
   * documents why. Integer truncation can leave a leg a few native units light,
   * which is fractions of a basis point against a band that is at minimum the
   * oracle deviation threshold plus the fee, so it never approaches the bound.
   *
   * ## Approvals are steps, not a precondition
   *
   * Each constituent's live `allowance(caller, vault)` is read in the same batch
   * and an approval whose allowance already covers the deposit comes back with
   * `required: false`, so a returning depositor is not asked to re-sign N
   * transactions. An allowance that could not be read at all is treated as
   * insufficient: a redundant approval costs gas, a missing one reverts the mint.
   *
   * Protected, because `ctx.session.address` is both the share recipient and the
   * allowance owner the plan is computed against. A plan built for one wallet is
   * meaningless to another.
   */
  mintTx: protectedProcedure
    .input(mintTxInput)
    .mutation(async ({ ctx, input }): Promise<VaultTxPlan> => {
      if (!(await isOfficialDepositVault(ctx, input.tokenId)))
        return txRefusal(
          "Deposits are restricted to official predefined vaults",
          "This address is not in the completed operator registry. Existing withdrawal and claim recovery remain available.",
        );
      const row = await findVault(ctx, input.tokenId);
      if (!row) {
        return txRefusal(
          "This vault is not one Cortex knows",
          "No deployed theme token matches this id, so there is no vault to mint into. It may have been deployed outside Cortex, or the indexer may not have seen it yet.",
        );
      }

      if (supportsDeferredClaims(row)) {
        return txRefusal(
          "Use the current deposit ticket",
          "Claim-preserving vaults require a simulated quote from the settlement ticket. This legacy planner cannot price fractional asset ownership safely. No transaction has been prepared.",
        );
      }

      const spec = row.spec;
      if (!ADDRESS_RE.test(row.vault) || spec.constituents.length === 0) {
        return txRefusal(
          "This vault is not configured to mint",
          "The indexed record for this theme token carries no usable vault address or no constituents, so there is nothing to encode a deposit against. Cortex will not substitute an address here: a mint moves real balances and a wrong target sends them somewhere unrecoverable.",
        );
      }

      if (input.usdAmount <= 0) {
        return txRefusal(
          "Enter an amount to deposit",
          "A mint of zero deposits nothing and mints nothing, and the vault rejects it outright. Enter a positive USD amount.",
        );
      }

      const owner = getAddress(ctx.session.address);
      const [read, meta] = await Promise.all([
        readMintChain(row, owner),
        constituentMeta(ctx, spec.constituents),
      ]);

      // Unlike the read paths there is no cache to fall back to: a deposit is
      // priced off the chain or it is not priced.
      if (!read) {
        return txRefusal(
          "The vault could not be read",
          "RHC Testnet did not answer the reads this deposit is sized from. Nothing has been sent and nothing has been signed. Try again in a moment.",
        );
      }

      const vault = checksum(row.vault);
      const totalWad = toUnits(input.usdAmount, 18);
      const amounts: bigint[] = [];
      let depositTotalWad = 0n;
      let navTotalBeforeWad = 0n;

      for (const [i, leg] of read.legs.entries()) {
        const symbol = meta.get(spec.constituents[i] ?? "")?.symbol ?? shortAddress(leg.address);
        const value = leg.wholeTokenValueWad;

        if (value === null || value === 0n) {
          return txRefusal(
            `${symbol} has no readable price`,
            `The Chainlink feed backing ${symbol} did not answer a usable round, so its share of the deposit cannot be sized. The vault prices the same feed and would revert on the deposit, which is the safe failure rather than a mint at a guessed price.`,
          );
        }

        const scale = 10n ** BigInt(leg.decimals);
        const targetValueWad = (totalWad * BigInt(spec.targetWeightsBps[i] ?? 0)) / BPS;
        const amount = (targetValueWad * scale) / value;

        // `mint` reverts with `ZeroAmount` on any empty leg, so a deposit too
        // small to buy one native unit of the priciest name is refused whole
        // rather than encoded as a transaction that cannot succeed.
        if (amount === 0n) {
          return txRefusal(
            "This deposit is too small to split",
            `At target weight, ${symbol} takes none of a deposit this size, and the vault requires every leg of a mint to be non-zero. Increase the amount.`,
          );
        }

        amounts.push(amount);
        depositTotalWad += (value * amount) / scale;
        navTotalBeforeWad += (value * (leg.vaultBalance ?? 0n)) / scale;
      }

      // The vault's own share maths, in the same integer arithmetic it uses.
      // The first mint prices at 1.00 by construction (`shares = depositTotal`
      // when supply is 0); after that it is pro rata against strict NAV.
      if (read.supply > 0n && navTotalBeforeWad === 0n) {
        return txRefusal(
          "This vault holds nothing to price against",
          "The vault has shares outstanding but none of its constituent balances priced, so there is no NAV to mint against. That is a feed problem rather than a deposit problem, and it clears when the feeds do.",
        );
      }

      const gross =
        read.supply === 0n ? depositTotalWad : (depositTotalWad * read.supply) / navTotalBeforeWad;
      const shares = (gross * (BPS - read.bandBps)) / BPS;

      if (shares === 0n) {
        return txRefusal(
          "This deposit is too small to mint a share",
          "After the mint / redeem band is retained, the deposit rounds to zero shares. Increase the amount.",
        );
      }

      // The floor the caller signs, not a prediction. NAV can move between this
      // read and the block that mines the mint, and `mint` reverts with
      // `SlippageExceeded` below it rather than filling at whatever it finds.
      const minSharesOut = (shares * (BPS - BigInt(input.slippageBps))) / BPS;

      const steps: VaultTxStep[] = read.legs.map((leg, i) => {
        const amount = amounts[i] ?? 0n;
        const symbol = meta.get(spec.constituents[i] ?? "")?.symbol ?? shortAddress(leg.address);
        return {
          key: `approve:${leg.address.toLowerCase()}`,
          caller: owner,
          label: `Approve ${symbol}`,
          to: leg.address,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [vault, amount],
          }),
          chainId: TESTNET_CHAIN_ID,
          // Stock Tokens are ordinary OpenZeppelin ERC-20s, so raising an
          // allowance from a non-zero value needs no reset to zero first.
          required: (leg.allowance ?? 0n) < amount,
        };
      });

      steps.push({
        key: "mint",
        caller: owner,
        label: `Mint ${spec.symbol}`,
        to: vault,
        data: encodeFunctionData({
          abi: keylessVaultAbi,
          functionName: "mint",
          args: [amounts, owner, minSharesOut],
        }),
        chainId: TESTNET_CHAIN_ID,
        required: true,
      });

      return { ok: true, steps, refusal: null };
    }),

  /**
   * The unsigned transaction that redeems `shares` in kind: `redeem(shares, to)`
   * and nothing else.
   *
   * One step, no approval. `redeem` burns the caller's own shares through
   * `ThemeToken.burn(msg.sender, shares)`, so there is nothing for the vault to
   * pull and nothing to approve. It also reads no oracle and touches no venue by
   * design, which is why it stays available when every feed is stale and why
   * `redeemToUsdg` is not offered beside it.
   *
   * The share count is the only thing checked, against the live supply. Anything
   * above it describes a basket the vault does not hold, and `burn` would revert
   * on the short balance after the caller had already paid for the attempt.
   */
  redeemTx: protectedProcedure
    .input(redeemTxInput)
    .mutation(async ({ ctx, input }): Promise<VaultTxPlan> => {
      const row = await findVault(ctx, input.tokenId);
      if (!row) {
        return txRefusal(
          "This vault is not one Cortex knows",
          "No deployed theme token matches this id, so there are no shares to redeem. It may have been deployed outside Cortex, or the indexer may not have seen it yet.",
        );
      }

      if (!ADDRESS_RE.test(row.vault)) {
        return txRefusal(
          "This vault is not configured to redeem",
          "The indexed record for this theme token carries no usable vault address, so there is nothing to encode a redeem against. Cortex will not substitute an address here: a redeem burns real shares and a wrong target burns them for nothing.",
        );
      }

      if (input.shares <= 0) {
        return txRefusal(
          "Enter an amount to redeem",
          "A redeem of zero burns nothing and returns nothing, and the vault rejects it outright. Enter a positive share count.",
        );
      }

      // One fact decides this plan, so one read. `redeem` needs no price, no
      // band and no allowance.
      let supply: bigint | null;
      try {
        const [item] = (await multicallRead(
          [{ address: checksum(row.id), abi: themeTokenAbi, functionName: "totalSupply" }] as const,
          { client: executionPublicClient },
        )) as unknown as MulticallItem<unknown>[];
        supply = decodeUint(item);
      } catch (err) {
        log.warn("redeem tx chain read failed", { tokenId: row.id, err });
        supply = null;
      }

      if (supply === null) {
        return txRefusal(
          "The vault could not be read",
          "RHC Testnet did not answer the share supply this redeem is checked against. Nothing has been sent and nothing has been signed. Try again in a moment.",
        );
      }

      if (supply === 0n) {
        return txRefusal(
          "This vault has no shares to redeem",
          "Nothing has been minted into this vault yet, so there is no basket to take a slice of. A redeem becomes possible after the first mint.",
        );
      }

      const sharesRaw = toUnits(input.shares, row.spec.decimals);
      if (sharesRaw === 0n) {
        return txRefusal(
          "This redeem is too small",
          "The share count rounds to zero at the token's own precision, and the vault rejects a zero redeem. Increase the amount.",
        );
      }

      if (sharesRaw > supply) {
        return txRefusal(
          "That is more shares than exist",
          "The redeem is larger than the vault's entire supply, so it describes a basket the vault does not hold. Reduce the amount.",
        );
      }

      return {
        ok: true,
        steps: [
          {
            key: "redeem",
            caller: ctx.session.address,
            label: `Redeem ${row.spec.symbol}`,
            to: checksum(row.vault),
            data: encodeFunctionData({
              abi: keylessVaultAbi,
              functionName: "redeem",
              args: [sharesRaw, getAddress(ctx.session.address)],
            }),
            chainId: TESTNET_CHAIN_ID,
            required: true,
          },
        ],
        refusal: null,
      };
    }),
});
