import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  keccak256,
  numberToHex,
  zeroAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
} from "viem";
import { z } from "zod";

import { themeFactoryAbi } from "../chain/abis/index.ts";
import { executionChain, executionPublicClient } from "../chain/client.ts";
import { executionReadiness, getExecutionContext } from "../execution/context.ts";
import { adapterConfiguration } from "../execution/adapter-routes.ts";
import { PRESET_RELEASE } from "../execution/vault-accounting.ts";
import { PRESET_SLUGS } from "../execution/preset-catalog.ts";
import { deployedTokenIdFor } from "../execution/shared-lens-registry.ts";
import {
  BAND_HEADROOM_BPS,
  BPS,
  capBpsFor,
  DEVIATION_THRESHOLD_BPS,
  MAX_FEE_BPS,
  SLIPPAGE_CAP_BPS,
  THEME_DECIMALS,
} from "../chain/theme-policy.ts";
import {
  themeProposals,
  themeTokens,
  universe,
  type ThemeProposalBasket,
  type ThemeProposalRecord,
} from "../db/schema.ts";
import { classificationBySymbol, loadLenses, type LensDefinition } from "../lenses/load.ts";
import { logger } from "../lib/logger.ts";
import { executionEligibility } from "../execution/theme-eligibility.ts";
import { publicProcedure, protectedProcedure, router, type Context } from "../trpc.ts";

/**
 * `themeRouter` (FE-5, hardened by BE-29). The construction half of "Act On It":
 * turn a theme lens into a basket a keyless vault can actually hold, or refuse
 * and say why.
 *
 * `CortexBackend.md` PART 4 spells the sequence out:
 *
 *   eligible theme names -> propose weights -> redeemability gate (simulate full
 *   redeem vs depth; drop/reduce names that break NAV redeem) -> human approves
 *   -> factory deploys token + vault + fee controller
 *
 * `construct` is the first arrow, `preview` the second and third, `deploy` the
 * fourth. The human approval is the client's; nothing here deploys on its own.
 *
 * ## Why every figure is computed here and not in the browser
 *
 * The redeemability gate reads the verified execution quote capacity, while
 * `universe.poolDepthUsd` remains a research disclosure. A depth simulation run
 * client-side would be a second, unverifiable answer to a question this service
 * already answers, and PART 6's requirement that the engine "refuses
 * constituents that break NAV redeem and says so" is a claim about the engine.
 * So the per-name capacity figures, the adjustments and the basket's
 * `maxRedeemUsd` all originate here and the UI only renders them.
 *
 * ## The approval is bound to the basket, by hash
 *
 * `deployTheme()` deploys an immutable vault with no rescue function: a basket
 * that is wrong when it is signed is wrong forever. Between the preview a human
 * read and the signature they give, `universe` can move underneath them (the
 * refresher runs every 60s), so `deploy` cannot simply recompute and encode
 * whatever comes out.
 *
 * `preview` therefore returns a `basketHash` over exactly the bytes that would
 * enter calldata, and `deploy` requires it. On a mismatch it refuses AND returns
 * the recomputed preview, so the UI can re-present the changed basket for a
 * second approval. It deploys neither version. See `basketHashFor`.
 *
 * ## A caller may steer the weights, and is never trusted with them
 *
 * `preview` accepts an optional weight vector. Every entry is revalidated here
 * against the live universe before it is used, and the redeemability gate then
 * runs on the caller's weights rather than the curated ones, so `adjustments[]`
 * describes what the gate did to THEIR proposal. A caller cannot add a name the
 * lens does not contain, resurrect an excluded one, or leave an eligible one
 * unweighted.
 *
 * ## Refusals are values, errors are failures
 *
 * Every procedure that can decline for a reason a human should read returns a
 * structured `refusal` (BE-27 requirement 3, the house precedent in
 * `vaultRouter.redeemQuote`). Thrown errors are reserved for genuine failures:
 * an unreachable RPC, a missing session, malformed input.
 *
 * ## The API never signs and never sends
 *
 * `deploy` returns an UNSIGNED transaction request (chain 46630, the factory,
 * encoded calldata) and the user's own wallet broadcasts it. Cortex holds no key
 * that can deploy a vault, which is the same reason the vault has no rescue
 * function.
 *
 * ## Testnet 46630, always
 *
 * Locked decision 5. Every response stamps the chain id, `deploy` refuses to
 * encode anything without a configured testnet factory, and there is no mainnet
 * branch to fall through to.
 */

const log = logger.child({ module: "theme-router" });

// --- Policy constants -------------------------------------------------------
//
// The numbers that end up in calldata live in `chain/theme-policy.ts`, checked
// against the compiled artifacts by `bun run contracts:check` (BE-29 scope 8).
// Only the router's own behaviour is configured here.

/** C2's only deploy target (locked decision 5). No mainnet branch exists. */
const TESTNET_CHAIN_ID = executionChain.id;

/** Stage-08's active factory accepts only immutable zero-fee themes. */
const DEFAULT_CREATOR_FEE_BPS = 0;

/**
 * How long a preview may be held before `deploy` treats it as stale on its face,
 * whether or not the basket actually changed.
 *
 * Five minutes. `universe-refresher` runs on a 60s cycle
 * (`UNIVERSE_REFRESH_INTERVAL_MS`), so this is at most five refresher passes:
 * five chances for a price to move, a `paused` flag to flip or a depth sample to
 * land under a preview a human is still reading. Longer and the numbers on
 * screen stop being a description of anything current; much shorter and an
 * ordinary read of the basket and the disclosures would expire mid-approval.
 *
 * This is belt to `basketHash`'s braces, not a substitute for it. The hash is
 * what actually binds the approval, and it is checked server-side against a
 * fresh recomputation; `previewedAt` is a client-supplied timestamp and a client
 * that lies about it only refuses itself a deploy it could otherwise have had.
 */
const PREVIEW_MAX_AGE_MS = 5 * 60_000;

/**
 * How long after a broadcast a transaction the testnet knows nothing about is
 * reported as dropped rather than pending.
 *
 * Two minutes. RHC is an Orbit L2 with sub-second blocks, so a transaction the
 * node has neither mined nor queued after two minutes is not slow, it never
 * arrived. Reported as "unknown" rather than "failed": Cortex cannot prove a
 * transaction does not exist, only that this endpoint has not seen it.
 */
const DROPPED_AFTER_MS = 2 * 60_000;

// --- Redeemability gate constants -------------------------------------------

/**
 * Fewest constituents a theme token may hold.
 *
 * `CortexFrontend.md` section 6: "a lens with too few liquid names says so;
 * /act refuses to build an unredeemable token and explains why." Two names is a
 * pair trade and one is a wrapper; neither is a theme, and both concentrate the
 * whole basket's exit into one or two order books, which is precisely the
 * failure the redeemability gate exists to prevent.
 */
const MIN_CONSTITUENTS = 3;

/**
 * How much of the basket's total redeem depth a single name may consume,
 * relative to its fair share.
 *
 * A basket's routed-redeem capacity is `min_i(maxRedeem_i / weight_i)`, which is
 * maximised when weights match each name's share of total depth. Forcing exactly
 * that would throw the curated lens weights away, so a name is allowed to carry
 * up to 1.5x its depth share and is reduced only past that. Scale-free: no USD
 * threshold to go stale as venues deepen.
 */
const CONCENTRATION_ALLOWANCE = 1.5;

/** Below this the name is not carrying the theme, it is rounding error. Its
 *  weight is returned to the names that can actually absorb it. */
const MIN_WEIGHT_FRACTION = 0.005;

/** The same floor in bps, which is the unit a caller supplies weights in. */
const MIN_WEIGHT_BPS = Math.round(MIN_WEIGHT_FRACTION * BPS);

/** The cap pass is a fixed point; this only bounds a pathological input. */
const MAX_GATE_PASSES = 8;

const EPS = 1e-12;

// --- Input ------------------------------------------------------------------

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const BASKET_HASH_RE = /^0x[a-f0-9]{64}$/;

const slugInput = z.object({ slug: z.string().trim().min(1) }).strict();

/**
 * A caller-supplied weight for one name. Address-keyed, never index-keyed: an
 * index would silently re-target if the eligible set changed between the preview
 * that produced the vector and the request that carries it.
 */
const callerWeightSchema = z
  .object({
    tokenAddress: z
      .string()
      .trim()
      .regex(ADDRESS_RE, "Invalid constituent address")
      .transform((value) => value.toLowerCase()),
    weightBps: z.number().int().positive().max(BPS),
  })
  .strict();

/** Zod bounds only. Every semantic rule (right set, still vault-eligible, above
 *  the floor, sums to 10000) is re-checked in `applyCallerWeights`. */
const weightsInput = z.array(callerWeightSchema).min(MIN_CONSTITUENTS).max(64);

const previewInput = slugInput
  .extend({
    /** Streaming fee, bps of AUM per year. Capped by policy at `MAX_FEE_BPS` and
     *  unchangeable after deploy, so it is quoted before approval, never after. */
    creatorFeeBps: z.number().int().min(0).max(MAX_FEE_BPS).optional(),
    /** The caller's proposed weights, before the redeemability gate. Omitted
     *  means the curated lens weights, renormalised over the eligible subset. */
    weights: weightsInput.optional(),
  })
  .strict();

const deployInput = previewInput.extend({
  /** The hash of the basket the human actually approved. Required: without it a
   *  deploy is an instruction to encode whatever the universe happens to say
   *  right now, which is not what anyone ticked a box for. */
  basketHash: z.string().trim().toLowerCase().pipe(z.string().regex(BASKET_HASH_RE)),
  /** `ThemePreview.previewedAt`, echoed back. Advisory (see `PREVIEW_MAX_AGE_MS`). */
  previewedAt: z.iso.datetime({ offset: true }),
  /** An existing draft to promote, instead of recording a new proposal. */
  proposalId: z.uuid().optional(),
});

const saveInput = previewInput.extend({
  /** Update this draft instead of creating one. Must belong to the caller. */
  proposalId: z.uuid().optional(),
});

const proposalIdInput = z.object({ proposalId: z.uuid() }).strict();

const txHashSchema = z
  .string()
  .trim()
  .regex(TX_HASH_RE, "Invalid transaction hash")
  .transform((value) => value.toLowerCase());

const recordBroadcastInput = z.object({ proposalId: z.uuid(), txHash: txHashSchema }).strict();

const deployStatusInput = z
  .object({
    txHash: txHashSchema,
    /** When the client broadcast it. Only used to decide when silence from the
     *  node stops meaning "pending" and starts meaning "dropped". */
    broadcastAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

// --- Response shapes (FE consumes these through tRPC inference) --------------

/** A lens member that cannot enter a basket, with the universe gate's own
 *  words for why. Never hidden: a silent exclusion is a bug (global do-not 5). */
export interface ExcludedName {
  symbol: string;
  /** Null when the symbol resolves to no universe row at all. */
  tokenAddress: `0x${string}` | null;
  /** The curated lens weight this name was carrying. */
  lensWeightPct: number;
  /** Still signal-eligible, so the terminal reads it as "research-only" rather
   *  than "ineligible". The two are different claims (FE-3) and the surface has
   *  to be able to tell them apart. False when no universe row resolved at all. */
  signalEligible: boolean;
  /** `universe.ineligibleReasons`, verbatim. Never empty. */
  reasons: string[];
}

/** One name in the proposed basket. */
export interface ProposedConstituent {
  symbol: string;
  tokenAddress: `0x${string}`;
  /** The Chainlink AggregatorV3 proxy that prices it on chain. A constituent
   *  without one cannot be here at all: a contract cannot read a REST quote. */
  feed: `0x${string}`;
  /** Curated lens weight, renormalised over the eligible subset, or the
   *  caller's own weight when they supplied one. */
  weightPct: number;
  weightBps: number;
  /** The immutable per-constituent cap that goes into calldata beside the
   *  weight. The vault requires `capBps >= weightBps`. */
  capBps: number;
  /** Conservative demonstrated exit capacity from a pinned execution quote. */
  maxRedeemUsd: number;
  /** Legacy display field. It is never used to determine execution eligibility. */
  poolDepthUsd: number;
  measuredExitCapacityUsdWad: string;
  priceUsd: number | null;
}

export type RefusalCode =
  | "unknown-lens"
  | "too-few-eligible"
  | "too-few-after-gate"
  | "no-redeem-depth"
  | "weights-rejected"
  | "config-missing"
  | "preview-stale"
  | "shared-vault-exists"
  | "predefined-only"
  | "basket-changed";

/**
 * A structured refusal, never a thrown error: the UI has to render the excluded
 * names and the reason beside it. There is deliberately no field that lets a
 * caller proceed anyway.
 */
export interface ThemeRefusal {
  code: RefusalCode;
  headline: string;
  detail: string;
  /** Only on `config-missing`: the deploy-config values that are unset, by name,
   *  so the UI can name them instead of saying "not configured". */
  missingConfig?: string[];
  /** Exact shared token to open instead of deploying; never a symbol lookup. */
  existingTokenId?: string;
}

export interface ThemeConstruction {
  slug: string;
  name: string;
  thesis: string;
  color: string;
  /** Members in the lens definition, eligible or not. */
  lensMemberCount: number;
  /** The proposed basket. Empty when the theme is refused. */
  constituents: ProposedConstituent[];
  excluded: ExcludedName[];
  buildable: boolean;
  refusal: ThemeRefusal | null;
  /** Verified predefined shared token in the active execution generation.
   * Historical/custom same-slug deployments are not endorsements. */
  deployedTokenId: string | null;
  chainId: number;
}

export interface RedeemabilityAdjustment {
  symbol: string;
  tokenAddress: `0x${string}`;
  action: "dropped" | "reduced";
  fromWeightPct: number;
  /** 0 when dropped. */
  toWeightPct: number;
  /** Plain language, safe to show as-is, and it carries the depth figure. */
  reason: string;
  maxRedeemUsd: number;
  poolDepthUsd: number;
}

export interface ThemePreview extends ThemeConstruction {
  /** Every name the redeemability gate dropped or reduced, with its reason. */
  adjustments: RedeemabilityAdjustment[];
  /** The largest routed redeem of the WHOLE basket that holds the NAV band
   *  against every leg's sampled depth: `min_i(maxRedeem_i / weight_i)`. Null
   *  when the theme is refused and there is no basket to size. */
  maxRedeemUsd: number | null;
  /** Exact immutable WAD ceiling encoded into the vault. */
  maxRedeemUsdWad: string | null;
  creatorFeeBps: number;
  /** `ThemeFactory.MAX_FEE_BPS`. The fee cannot exceed it, and cannot be raised
   *  after deploy at any value. */
  maxFeeBps: number;
  mintRedeemBandBps: number;
  /** Swap slippage cap per routed deposit/exit leg. Frozen with the rest of the policy. */
  slippageCapBps: number;
  /** ERC-20 metadata the factory would mint the share with. */
  tokenName: string;
  tokenSymbol: string;
  /** Whose weights the gate ran against. `caller` when a weight vector was
   *  supplied and accepted. */
  weightsSource: "curated" | "caller";
  /**
   * Content hash over exactly the bytes that would enter `deployTheme` calldata,
   * plus the chain id and the factory address. Null when the theme is refused
   * and there is nothing to approve. `deploy` requires it back.
   *
   * A NAV or price tick does not move it: prices are not in calldata. A weight,
   * a cap, a policy number, the settlement token, the venue allowlist or the
   * `maxRedeemUsd` ceiling all do.
   */
  basketHash: string | null;
  /** When this preview was computed, ISO-8601. Echo it back to `deploy`. */
  previewedAt: string;
  /** How long it is treated as fresh. See `PREVIEW_MAX_AGE_MS`. */
  staleAfterSec: number;
}

/** An unsigned transaction for the user's wallet to sign and send. */
export interface ThemeDeployRequest {
  chainId: number;
  manifestDigest: string;
  /** The `ThemeFactory` on 46630. */
  to: `0x${string}`;
  data: `0x${string}`;
  /** The creator recorded in the policy: the caller's own signed-in address. */
  creator: `0x${string}`;
  /** The hash this transaction encodes, equal to the one the caller approved. */
  basketHash: string;
  /** The proposal row recording the approval. Pass it to `recordBroadcast`
   *  once the wallet returns a transaction hash. */
  proposalId: string;
  /** The preview this transaction encodes, recomputed server-side. The client
   *  cannot hand in a basket of its own. */
  preview: ThemePreview;
}

/**
 * `deploy`'s answer. A discriminated result rather than a throw: an unbuildable
 * theme, a missing venue list and a basket that moved under an approval are all
 * facts a human has to read, and a thrown `PRECONDITION_FAILED` renders as a
 * generic red toast (BE-27 requirement 3).
 */
export type ThemeDeployResult =
  | { ok: true; tx: ThemeDeployRequest }
  | {
      ok: false;
      refusal: ThemeRefusal;
      /** The recomputed preview, so a `basket-changed` refusal can be
       *  re-presented for a second approval. Null for refusals before construction,
       *  including reuse of an existing shared vault. */
      preview: ThemePreview | null;
    };

/** What `deployTheme()` cannot be encoded without, and what is missing. */
export interface ThemeDeployReadiness {
  /** Public wallet endpoint, which differs from the container RPC on Anvil. */
  walletRpcUrl: string | null;
  ready: boolean;
  chainId: number;
  /** The `ThemeFactory` on 46630, or null. */
  factory: string | null;
  /** The USDG settlement token on 46630, or null. */
  usdg: string | null;
  /** Swap venues on the allowlist. An empty list is not a permissive
   *  default, it is an unbuildable policy. */
  venues: string[];
  /** Each unset value, named, with what it is for. Empty when `ready`. */
  missing: { name: string; detail: string }[];
  /**
   * USD of redeem depth credited to names that sampled no venue, or 0 when off.
   *
   * Non-zero means a basket's depth figures are a local-chain substitute rather
   * than a measurement, which is the difference between "this theme is
   * buildable" and "this theme is buildable here". Reported so that difference
   * is never invisible.
   */
}

export interface ThemeDeployStatus {
  /**
   * - `pending`: broadcast or mined, and the indexer has not written the row yet.
   * - `deployed`: the execution indexer saw a canonical `ThemeDeployed` log.
   * - `orphaned`: the log was once mined but was removed by a local reorg.
   * - `failed`: the receipt says the transaction reverted. There is no vault.
   * - `unknown`: the testnet knows nothing about this hash past a bounded wait.
   */
  status: "pending" | "deployed" | "orphaned" | "failed" | "unknown";
  txHash: string;
  chainId: number;
  tokenId: string | null;
  vault: string | null;
  feeController: string | null;
  deployedAt: string | null;
  /** Plain language, safe to show as-is. Null once deployed. */
  detail: string | null;
}

/** A saved proposal, as a list row. */
export interface ThemeProposalSummary {
  id: string;
  slug: string;
  status: "draft" | "proposed" | "deployed" | "deprecated";
  basketHash: string;
  chainId: number;
  deployTx: string | null;
  createdAt: string;
  updatedAt: string;
  /** Denormalised from the frozen basket so a list row needs no rehydration. */
  tokenName: string;
  tokenSymbol: string;
  constituentCount: number;
  creatorFeeBps: number;
}

export interface ThemeProposalDetail extends ThemeProposalSummary {
  /** The frozen policy, exactly as it would be encoded. */
  basket: ThemeProposalBasket;
}

/** `save`'s answer, in the same discriminated shape as `deploy`'s. */
export type ThemeSaveResult =
  | { ok: true; proposal: ThemeProposalSummary; preview: ThemePreview }
  | { ok: false; refusal: ThemeRefusal; preview: ThemePreview | null };

// --- Weight maths -----------------------------------------------------------

/** Fractions summing to 1 from any set of positive weights. */
function normalise(weights: number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return weights.map(() => 0);
  return weights.map((w) => w / total);
}

/**
 * Integer bps summing to EXACTLY 10000, by largest remainder.
 *
 * The factory reverts unless the weights sum to 10000, and the UI has to show a
 * column that adds to 100. Rounding each weight independently satisfies neither.
 */
function toBps(fractions: number[]): number[] {
  const scaled = fractions.map((f) => f * BPS);
  const floors = scaled.map((s) => Math.floor(s));
  let remainder = BPS - floors.reduce((sum, f) => sum + f, 0);

  const order = scaled
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const bps = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    bps[i] = (bps[i] ?? 0) + 1;
    remainder -= 1;
  }
  return bps;
}

/**
 * Water-fill: pull every over-cap weight down to its cap and hand the freed
 * weight to the names with headroom, in proportion to that headroom.
 *
 * One pass is enough. `sum(caps) - 1 = CONCENTRATION_ALLOWANCE - 1 > 0`, so the
 * freed weight is strictly less than the available headroom and no name can be
 * pushed back over its own cap by the redistribution.
 */
function waterFill(weights: number[], caps: number[]): number[] {
  const out = [...weights];
  let excess = 0;
  const headroom = out.map((w, i) => {
    const cap = caps[i] ?? 0;
    if (w > cap) {
      excess += w - cap;
      out[i] = cap;
      return 0;
    }
    return cap - w;
  });

  const totalHeadroom = headroom.reduce((sum, h) => sum + h, 0);
  if (excess <= EPS || totalHeadroom <= EPS) return out;

  for (let i = 0; i < out.length; i += 1) {
    out[i] = (out[i] ?? 0) + (excess * (headroom[i] ?? 0)) / totalHeadroom;
  }
  return out;
}

// --- Universe join ----------------------------------------------------------

interface UniverseFacts {
  symbol: string;
  tokenAddress: string;
  chainlinkFeed: string | null;
  poolDepthUsd: number;
  priceUsd: number | null;
  signalEligible: boolean;
  vaultEligible: boolean;
  ineligibleReasons: string[];
}

async function universeByAddress(
  ctx: Pick<Context, "db">,
  addresses: string[],
): Promise<Map<string, UniverseFacts>> {
  if (addresses.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      address: sql<string>`lower(${universe.tokenAddress})`,
      symbol: universe.symbol,
      chainlinkFeed: universe.chainlinkFeed,
      poolDepthUsd: universe.poolDepthUsd,
      priceUsd: universe.priceUsd,
      signalEligible: universe.signalEligible,
      vaultEligible: universe.vaultEligible,
      ineligibleReasons: universe.ineligibleReasons,
    })
    .from(universe)
    .where(inArray(sql`lower(${universe.tokenAddress})`, addresses));

  return new Map(
    rows.map((row) => [
      row.address,
      {
        symbol: row.symbol,
        tokenAddress: row.address,
        chainlinkFeed: row.chainlinkFeed,
        poolDepthUsd: row.poolDepthUsd,
        priceUsd: row.priceUsd,
        signalEligible: row.signalEligible,
        vaultEligible: row.vaultEligible,
        ineligibleReasons: row.ineligibleReasons,
      },
    ]),
  );
}

function findLens(slug: string): LensDefinition | undefined {
  return loadLenses().find((lens) => lens.slug === slug);
}

// --- Share metadata ---------------------------------------------------------

/**
 * A deterministic ticker for the share: `ctx` plus the initials of the slug's
 * words, or its first three letters when that would be too short to read.
 */
function shareSymbol(slug: string): string {
  const parts = slug.split("-").filter((part) => part.length > 0);
  const initials = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  const core = initials.length >= 3 ? initials : (parts[0] ?? slug).slice(0, 3).toUpperCase();
  return `ctx${core.slice(0, 5)}`;
}

// --- Construction -----------------------------------------------------------

interface Candidate {
  facts: UniverseFacts;
  lensWeightPct: number;
  /** Largest full redeem of this name that holds the theme's band. */
  maxRedeemUsd: number;
  measuredExitCapacityUsdWad: string;
  /** The fraction of the basket this name is proposed to carry BEFORE the gate:
   *  the renormalised curated weight, or the caller's own. */
  proposed: number;
}

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Step 1: split the lens into what a vault can hold and what it cannot. */
async function splitLens(
  lens: LensDefinition,
  facts: Map<string, UniverseFacts>,
): Promise<{ candidates: Candidate[]; excluded: ExcludedName[] }> {
  const bySymbol = classificationBySymbol();
  const candidates: Candidate[] = [];
  const excluded: ExcludedName[] = [];

  for (const member of lens.members) {
    const classified = bySymbol.get(member.symbol.toUpperCase());
    const row = classified ? facts.get(classified.tokenAddress) : undefined;

    if (!row) {
      excluded.push({
        symbol: member.symbol,
        tokenAddress: classified ? getAddress(classified.tokenAddress) : null,
        lensWeightPct: member.weightPct,
        signalEligible: false,
        reasons: ["not in the live universe. the gate has not cleared this address"],
      });
      continue;
    }

    const execution = await executionEligibility(row.symbol);
    if (!execution.eligible) {
      excluded.push({
        symbol: row.symbol,
        tokenAddress: getAddress(row.tokenAddress),
        lensWeightPct: member.weightPct,
        signalEligible: row.signalEligible,
        // Never re-mapped to friendlier copy: these strings are the audit trail.
        reasons: [`execution ${execution.code}: ${execution.reason}`],
      });
      continue;
    }

    candidates.push({
      facts: { ...row, tokenAddress: execution.tokenAddress, chainlinkFeed: execution.feed },
      lensWeightPct: member.weightPct,
      maxRedeemUsd: Number(BigInt(execution.measuredExitCapacityUsdWad) / 10n ** 18n),
      measuredExitCapacityUsdWad: execution.measuredExitCapacityUsdWad,
      // Overwritten below, once the whole eligible set is known.
      proposed: 0,
    });
  }

  const curated = normalise(candidates.map((c) => c.lensWeightPct));
  candidates.forEach((candidate, i) => {
    candidate.proposed = curated[i] ?? 0;
  });

  return { candidates, excluded };
}

type CallerWeight = z.infer<typeof callerWeightSchema>;

/**
 * Revalidates a caller-supplied weight vector against the live eligible set and
 * writes it onto the candidates.
 *
 * Nothing here trusts the input. The vector has to name exactly the eligible
 * set (no additions, no resurrections, no omissions), every weight has to clear
 * the same `MIN_WEIGHT_FRACTION` floor the gate applies, and the whole thing has
 * to sum to 10000 bps, which is what `ThemeFactory._validate` requires and what
 * `toBps` would otherwise silently repair. Returns a refusal detail on any
 * failure, never a throw: a rejected weight vector is something a human typed.
 */
function applyCallerWeights(
  candidates: Candidate[],
  excluded: ExcludedName[],
  weights: CallerWeight[],
): string | null {
  const byAddress = new Map(candidates.map((c) => [c.facts.tokenAddress.toLowerCase(), c]));
  const excludedByAddress = new Map(
    excluded
      .filter((name) => name.tokenAddress !== null)
      .map((name) => [name.tokenAddress!.toLowerCase(), name]),
  );

  const seen = new Set<string>();
  let sum = 0;

  for (const entry of weights) {
    const tokenAddress = entry.tokenAddress.toLowerCase();
    if (seen.has(tokenAddress)) {
      return `${entry.tokenAddress} is weighted twice. Each constituent carries exactly one weight.`;
    }
    seen.add(tokenAddress);

    const candidate = byAddress.get(tokenAddress);
    if (!candidate) {
      const wasExcluded = excludedByAddress.get(tokenAddress);
      if (wasExcluded) {
        return `${wasExcluded.symbol} was excluded from this basket and cannot be weighted back in: ${wasExcluded.reasons.join("; ")}.`;
      }
      return `${entry.tokenAddress} is not a vault-eligible member of this lens. A basket is drawn from the lens, and names cannot be added to it here.`;
    }

    if (entry.weightBps < MIN_WEIGHT_BPS) {
      return `${candidate.facts.symbol} is weighted at ${entry.weightBps} bps, under the ${MIN_WEIGHT_BPS} bps floor. Below that a name is not carrying the theme, it is rounding error.`;
    }

    sum += entry.weightBps;
  }

  const unweighted = candidates.filter((c) => !seen.has(c.facts.tokenAddress.toLowerCase()));
  if (unweighted.length > 0) {
    return `${unweighted.map((c) => c.facts.symbol).join(", ")} ${unweighted.length === 1 ? "is" : "are"} vault-eligible in this lens but carries no weight. Drop a name by refusing the theme, not by omitting it from the vector.`;
  }

  if (sum !== BPS) {
    return `The weights sum to ${sum} bps, not ${BPS}. The factory reverts on anything else, so this is not something the server rounds away.`;
  }

  for (const entry of weights) {
    const candidate = byAddress.get(entry.tokenAddress.toLowerCase());
    if (candidate) candidate.proposed = entry.weightBps / BPS;
  }
  return null;
}

interface GateResult {
  kept: Candidate[];
  /** Final weight fractions, parallel to `kept`. */
  weights: number[];
  adjustments: RedeemabilityAdjustment[];
}

/**
 * Step 2, PART 4's redeemability gate: simulate a full redeem against sampled
 * depth and drop or reduce the names that break NAV redeem.
 *
 * Two ways a name fails. It carries no routed exit at all (`maxRedeemUsd` of 0,
 * which on RHC today means no venue was sampled), and it is dropped. Or it
 * demands more of the basket than its depth share supports, and it is reduced to
 * `CONCENTRATION_ALLOWANCE x` that share with the freed weight handed to the
 * names that can absorb it.
 *
 * The gate runs against `candidate.proposed`, which is the caller's vector when
 * they supplied one. That is the whole point of accepting weights: `adjustments`
 * then describes what the gate did to THEIR proposal, not to the curated one.
 */
function redeemabilityGate(candidates: Candidate[]): GateResult {
  const adjustments: RedeemabilityAdjustment[] = [];

  const drop = (candidate: Candidate, reason: string) => {
    adjustments.push({
      symbol: candidate.facts.symbol,
      tokenAddress: getAddress(candidate.facts.tokenAddress),
      action: "dropped",
      fromWeightPct: candidate.proposed * 100,
      toWeightPct: 0,
      reason,
      maxRedeemUsd: candidate.maxRedeemUsd,
      poolDepthUsd: candidate.facts.poolDepthUsd,
    });
  };

  let active: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.maxRedeemUsd > 0) {
      active.push(candidate);
      continue;
    }
    drop(
      candidate,
      `a full redeem clears ${usd(candidate.maxRedeemUsd)} against ${usd(candidate.facts.poolDepthUsd)} of sampled depth, so this leg breaks NAV redeem at any weight`,
    );
  }

  let weights: number[] = [];
  for (let pass = 0; pass < MAX_GATE_PASSES; pass += 1) {
    if (active.length === 0) {
      weights = [];
      break;
    }

    const depthTotal = active.reduce((sum, c) => sum + c.maxRedeemUsd, 0);
    const caps = active.map((c) => (CONCENTRATION_ALLOWANCE * c.maxRedeemUsd) / depthTotal);
    weights = waterFill(normalise(active.map((c) => c.proposed)), caps);

    const tiny = active.filter((_, i) => (weights[i] ?? 0) < MIN_WEIGHT_FRACTION);
    if (tiny.length === 0) break;

    for (const candidate of tiny) {
      drop(
        candidate,
        `depth supports only ${usd(candidate.maxRedeemUsd)} of redeem, which caps this leg under ${pct(MIN_WEIGHT_FRACTION)} of the basket and leaves nothing to hold`,
      );
    }
    const dropped = new Set(tiny.map((candidate) => candidate.facts.tokenAddress));
    active = active.filter((c) => !dropped.has(c.facts.tokenAddress));
  }

  // Names that survived but at a smaller weight than the proposal gave them.
  active.forEach((candidate, i) => {
    const before = candidate.proposed;
    const after = weights[i] ?? 0;
    if (after >= before - 1e-9) return;
    const depthTotal = active.reduce((sum, c) => sum + c.maxRedeemUsd, 0);
    const share = depthTotal > 0 ? candidate.maxRedeemUsd / depthTotal : 0;
    adjustments.push({
      symbol: candidate.facts.symbol,
      tokenAddress: getAddress(candidate.facts.tokenAddress),
      action: "reduced",
      fromWeightPct: before * 100,
      toWeightPct: after * 100,
      reason: `weight reduced from ${pct(before)}: ${usd(candidate.maxRedeemUsd)} of redeem depth is ${pct(share)} of the basket's ${usd(depthTotal)}, and no leg may carry more than ${CONCENTRATION_ALLOWANCE.toFixed(1)}x its depth share`,
      maxRedeemUsd: candidate.maxRedeemUsd,
      poolDepthUsd: candidate.facts.poolDepthUsd,
    });
  });

  return { kept: active, weights, adjustments };
}

function refusalFor(
  code: RefusalCode,
  eligibleCount: number,
  lensName: string,
  excludedCount: number,
): ThemeRefusal {
  const shortfall = `${eligibleCount} of the ${eligibleCount + excludedCount} names in ${lensName} can back a vault, and a theme token needs at least ${MIN_CONSTITUENTS}.`;
  switch (code) {
    case "too-few-eligible":
      return {
        code,
        headline: "This theme is too thin to build",
        detail: `${shortfall} A vault holds only names with a Chainlink feed, because a contract cannot read a REST quote. The excluded names and the reason for each are listed below.`,
      };
    case "too-few-after-gate":
      return {
        code,
        headline: "This theme is too thin to redeem",
        detail: `${shortfall} The redeemability gate simulated a full redeem of every candidate against its sampled venue depth and too few survived. Building anyway would produce a token that cannot be exited, so Cortex does not offer that.`,
      };
    case "no-redeem-depth":
      return {
        code,
        headline: "No routed redeem depth for this basket",
        detail:
          "Every candidate in this lens simulates a full redeem of $0.00 against sampled venue depth, so the basket has no exit to size. That is a gap in Cortex's venue coverage as much as a fact about the assets, and either way it is not a token worth deploying.",
      };
    case "unknown-lens":
      return {
        code,
        headline: "Unknown theme lens",
        detail: "No lens is defined for this slug.",
      };
    // The remaining codes always carry a computed detail and never fall here.
    case "weights-rejected":
    case "config-missing":
    case "preview-stale":
    case "shared-vault-exists":
    case "predefined-only":
    case "basket-changed":
      return { code, headline: "This basket was not accepted", detail: "" };
  }
}

/** Candidates plus a parallel weight vector, projected onto the wire shape with
 *  weights expressed as integer bps that sum to exactly 10000. */
function toConstituents(candidates: Candidate[], weights: number[]): ProposedConstituent[] {
  const bps = toBps(weights);
  return candidates.map((candidate, i) => ({
    symbol: candidate.facts.symbol,
    tokenAddress: getAddress(candidate.facts.tokenAddress),
    // `splitLens` excludes a null feed, so this is always present here.
    feed: getAddress(candidate.facts.chainlinkFeed ?? candidate.facts.tokenAddress),
    weightBps: bps[i] ?? 0,
    weightPct: (bps[i] ?? 0) / 100,
    capBps: capBpsFor(bps[i] ?? 0),
    maxRedeemUsd: candidate.maxRedeemUsd,
    poolDepthUsd: 0,
    measuredExitCapacityUsdWad: candidate.measuredExitCapacityUsdWad,
    priceUsd: candidate.facts.priceUsd,
  }));
}

/** The largest redeem of the whole basket whose pro-rata slice of every leg
 *  still clears that leg's own simulated capacity. Null for an empty basket. */
function basketMaxRedeemUsd(constituents: ProposedConstituent[]): number | null {
  const limit = constituents.reduce((min, c) => {
    if (c.weightBps <= 0) return min;
    return Math.min(min, c.maxRedeemUsd / (c.weightBps / BPS));
  }, Number.POSITIVE_INFINITY);
  return Number.isFinite(limit) ? limit : null;
}

/** Exact integer policy ceiling: min(exitCapacityWad * 10000 / weightBps). */
function basketMaxRedeemUsdWad(constituents: ProposedConstituent[]): string | null {
  if (!constituents.length) return null;
  let limit: bigint | null = null;
  for (const constituent of constituents) {
    if (constituent.weightBps <= 0) return null;
    const bound =
      (BigInt(constituent.measuredExitCapacityUsdWad) * BigInt(BPS)) /
      BigInt(constituent.weightBps);
    limit = limit === null || bound < limit ? bound : limit;
  }
  return limit?.toString() ?? null;
}

interface BuiltTheme {
  /** Step 1: the eligible subset at renormalised curated weights, before the
   *  redeemability gate has touched anything. What `construct` answers. */
  proposal: ThemeConstruction;
  /** Steps 2 and 3: the same basket after the gate, with the policy numbers a
   *  deploy would freeze. What `preview` answers. */
  preview: ThemePreview;
}

interface BuildOptions {
  creatorFeeBps: number;
  /** The caller's weight vector, or undefined for the curated weights. */
  weights?: CallerWeight[];
}

/** The shared body of `construct`, `preview`, `save` and `deploy`. */
async function build(
  ctx: Pick<Context, "db">,
  slug: string,
  options: BuildOptions,
): Promise<BuiltTheme> {
  const lens = findLens(slug);
  if (!lens) {
    // Genuinely malformed input: there is no lens to describe, so there is
    // nothing structured to refuse with.
    throw new TRPCError({ code: "NOT_FOUND", message: "Unknown lens" });
  }

  const creatorFeeBps = options.creatorFeeBps;
  if (creatorFeeBps !== 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "New execution themes use the settlement-v2 zero-fee release and require creatorFeeBps 0.",
    });
  }

  // Both the factory and the vault constructor require the band to be STRICTLY
  // above the oracle's deviation threshold plus the fee, so the oracle's bounded
  // error cannot be arbitraged out of the vault (PART 4).
  const mintRedeemBandBps = DEVIATION_THRESHOLD_BPS + creatorFeeBps + BAND_HEADROOM_BPS;

  const bySymbol = classificationBySymbol();
  const addresses = lens.members
    .map((member) => bySymbol.get(member.symbol.toUpperCase())?.tokenAddress)
    .filter((address): address is string => address !== undefined);

  const [facts, deployedTokenId] = await Promise.all([
    universeByAddress(ctx, [...new Set(addresses)]),
    deployedTokenIdFor(ctx, lens.slug),
  ]);

  const { candidates, excluded } = await splitLens(lens, facts);

  const shared = {
    slug: lens.slug,
    name: lens.name,
    thesis: lens.thesis,
    color: lens.color,
    lensMemberCount: lens.members.length,
    excluded,
    deployedTokenId,
    chainId: TESTNET_CHAIN_ID,
  };

  const policy = {
    creatorFeeBps,
    maxFeeBps: MAX_FEE_BPS,
    mintRedeemBandBps,
    slippageCapBps: SLIPPAGE_CAP_BPS,
    tokenName: `Cortex ${lens.name}`,
    tokenSymbol: shareSymbol(lens.slug),
    previewedAt: new Date().toISOString(),
    staleAfterSec: Math.round(PREVIEW_MAX_AGE_MS / 1000),
  };

  const refusal = (code: RefusalCode): ThemeRefusal =>
    refusalFor(code, candidates.length, lens.name, excluded.length);

  const tooFewEligible = candidates.length < MIN_CONSTITUENTS;

  // The eligible subset is listed even when it is too small to build. Which one
  // or two names did qualify is part of the explanation for the refusal, and
  // hiding them would leave the reader with the exclusions alone.
  const proposal: ThemeConstruction = {
    ...shared,
    constituents: toConstituents(
      candidates,
      candidates.map((c) => c.proposed),
    ),
    buildable: !tooFewEligible,
    refusal: tooFewEligible ? refusal("too-few-eligible") : null,
  };

  const refuse = (
    themeRefusal: ThemeRefusal,
    adjustments: RedeemabilityAdjustment[],
    weightsSource: "curated" | "caller",
  ): BuiltTheme => ({
    proposal,
    preview: {
      ...shared,
      ...policy,
      adjustments,
      constituents: [],
      maxRedeemUsd: null,
      maxRedeemUsdWad: null,
      buildable: false,
      refusal: themeRefusal,
      weightsSource,
      basketHash: null,
    },
  });

  if (tooFewEligible) return refuse(refusal("too-few-eligible"), [], "curated");

  // The caller's vector, revalidated. A rejection is a refusal a human reads,
  // not a 400: they proposed a basket and the reason it was not accepted is the
  // whole answer.
  if (options.weights) {
    const problem = applyCallerWeights(candidates, excluded, options.weights);
    if (problem) {
      return refuse(
        {
          code: "weights-rejected",
          headline: "These weights were not accepted",
          detail: problem,
        },
        [],
        "caller",
      );
    }
  }
  const weightsSource: "curated" | "caller" = options.weights ? "caller" : "curated";

  const { kept, weights, adjustments } = redeemabilityGate(candidates);

  if (kept.length === 0) return refuse(refusal("no-redeem-depth"), adjustments, weightsSource);
  if (kept.length < MIN_CONSTITUENTS) {
    return refuse(refusal("too-few-after-gate"), adjustments, weightsSource);
  }

  const constituents = toConstituents(kept, weights);

  const preview: ThemePreview = {
    ...shared,
    ...policy,
    adjustments,
    constituents,
    maxRedeemUsd: basketMaxRedeemUsd(constituents),
    maxRedeemUsdWad: null,
    buildable: true,
    refusal: null,
    weightsSource,
    basketHash: null,
  };

  // Hashed last, over the finished basket. `resolveDeployConfig` never throws,
  // so an unconfigured testnet still produces a stable hash: it is the hash of a
  // basket with no settlement token and no venues, which is a different basket
  // from the one that deploys once those are set, and `deploy` will say so.
  preview.maxRedeemUsdWad = basketMaxRedeemUsdWad(constituents);
  preview.basketHash = basketHashFor(preview, (await resolveDeployConfig()).config);

  return { proposal, preview };
}

// --- Deploy config ----------------------------------------------------------

/** USD to 18-dp fixed point, via micro-dollars so a large figure never leaves
 *  float range mid-conversion. */
function toWad(value: number): bigint {
  return BigInt(Math.max(0, Math.round(value * 1e6))) * 10n ** 12n;
}

interface DeployConfig {
  factory: Address;
  usdg: Address;
  venues: Address[];
}

interface ResolvedDeployConfig {
  config: DeployConfig | null;
  missing: { name: string; detail: string }[];
}

/**
 * The three testnet addresses `deployTheme()` cannot be called without.
 *
 * All three are configuration, not data: the C1 universe describes mainnet 4663
 * and a theme deploys to 46630. This never throws and never invents a value. An
 * invented `usdg` or venue would deploy a permanently broken immutable vault and
 * there is no rescue function to undo it, so the missing names are returned and
 * `readiness` puts them in front of the user before the button, rather than
 * failing at click time (BE-29 scope 5).
 */
async function resolveDeployConfig(): Promise<ResolvedDeployConfig> {
  const context = await getExecutionContext();
  const factory = context?.manifest.factories[0];
  const adapter = context?.manifest.adapters.find(
    (entry) => entry.routeHash === adapterConfiguration().routeHash,
  );
  if (
    !context ||
    !factory ||
    factory.version !== PRESET_RELEASE ||
    factory.capabilities?.feeMode !== "zero" ||
    !adapter
  )
    return {
      config: null,
      missing: [
        {
          name: "EXECUTION_MANIFEST",
          detail:
            "A verified preset-v6 operator-only factory and reviewed swap routes are required. Users cannot create vaults in this release.",
        },
      ],
    };
  return {
    config: {
      factory: getAddress(factory.address),
      usdg: getAddress(context.manifest.usdg.address),
      venues: [getAddress(adapter.address)],
    },
    missing: [],
  };
}

// --- Calldata and the basket hash -------------------------------------------

/**
 * The `ThemeFactory.ThemeParams` tuple for a preview.
 *
 * One function builds it for both the hash and the transaction, so the two can
 * never describe different baskets. `creator` is the only field that differs:
 * the hash is taken with the zero address, because a preview is public and has
 * no session, and the real creator is bound from `ctx.session.address` at deploy.
 * That is deliberate. The creator is the caller's own address either way, so it
 * is not something the universe can change under an approval, and folding it in
 * would make an approval non-transferable between a preview and the deploy of
 * the person who read it.
 */
function deployParams(preview: ThemePreview, config: DeployConfig | null, creator: Address) {
  return {
    slug: preview.slug,
    name: preview.tokenName,
    symbol: preview.tokenSymbol,
    decimals: THEME_DECIMALS,
    creator,
    usdg: config?.usdg ?? zeroAddress,
    constituents: preview.constituents.map((c) => c.tokenAddress),
    feeds: preview.constituents.map((c) => c.feed),
    targetWeightsBps: preview.constituents.map((c) => BigInt(c.weightBps)),
    capsBps: preview.constituents.map((c) => BigInt(c.capBps)),
    creatorFeeBps: BigInt(preview.creatorFeeBps),
    mintRedeemBandBps: BigInt(preview.mintRedeemBandBps),
    slippageCapBps: BigInt(preview.slippageCapBps),
    maxRedeemUsd: BigInt(preview.maxRedeemUsdWad ?? "0"),
    allowedVenues: config?.venues ?? [],
  };
}

function encodeDeployCalldata(
  preview: ThemePreview,
  config: DeployConfig | null,
  creator: Address,
): `0x${string}` {
  return encodeFunctionData({
    abi: themeFactoryAbi,
    functionName: "deployTheme",
    args: [deployParams(preview, config, creator)],
  });
}

/**
 * The content hash an approval is bound to.
 *
 * Taken over the ENCODED CALLDATA rather than over a hand-written projection of
 * the preview, so there is no second serialisation to drift: whatever
 * `encodeFunctionData` puts in the transaction is what was hashed, field for
 * field, padding included. The chain id and the factory address are prefixed
 * because they are equally part of "what this approval authorises" and neither
 * appears inside the tuple.
 *
 * What is deliberately NOT in here: `priceUsd`, `poolDepthUsd`, NAV, the
 * adjustments list, the excluded list, `previewedAt`. A price tick must not
 * invalidate an approval. `maxRedeemUsd` IS in here, because it is a permanent
 * ceiling written into the vault, not a display figure.
 */
function basketHashFor(preview: ThemePreview, config: DeployConfig | null): `0x${string}` {
  return keccak256(
    concatHex([
      numberToHex(TESTNET_CHAIN_ID, { size: 32 }),
      config?.factory ?? zeroAddress,
      encodeDeployCalldata(preview, config, zeroAddress),
    ]),
  );
}

/** The approved policy, frozen for persistence. Mirrors `deployParams` minus
 *  `creator`, which a stored document must never carry (see `ThemeProposalBasket`). */
function frozenBasket(preview: ThemePreview, config: DeployConfig | null): ThemeProposalBasket {
  return {
    slug: preview.slug,
    tokenName: preview.tokenName,
    tokenSymbol: preview.tokenSymbol,
    decimals: THEME_DECIMALS,
    constituents: preview.constituents.map((c) => ({
      symbol: c.symbol,
      tokenAddress: c.tokenAddress.toLowerCase(),
      feed: c.feed.toLowerCase(),
      weightBps: c.weightBps,
      capBps: c.capBps,
    })),
    creatorFeeBps: preview.creatorFeeBps,
    mintRedeemBandBps: preview.mintRedeemBandBps,
    slippageCapBps: preview.slippageCapBps,
    maxRedeemUsdWad: preview.maxRedeemUsdWad ?? "0",
    factory: config?.factory.toLowerCase() ?? null,
    usdg: config?.usdg.toLowerCase() ?? null,
    venues: (config?.venues ?? []).map((venue) => venue.toLowerCase()),
  };
}

/** Operator tooling only; this is not an HTTP procedure and never signs. All
 * presets retain the same live eligibility and redeemability checks. */
export async function preparePresetBasket(
  ctx: Pick<Context, "db">,
  slug: string,
): Promise<ThemeProposalBasket> {
  if (!PRESET_SLUGS.includes(slug)) throw new Error(`Unknown predefined lens: ${slug}`);
  const { config } = await resolveDeployConfig();
  if (!config) throw new Error("Preset factory and execution routes are not ready");
  const { preview } = await build(ctx, slug, { creatorFeeBps: 0 });
  if (!preview.buildable || !preview.maxRedeemUsdWad || !preview.basketHash)
    throw new Error(`${slug}: ${preview.refusal?.detail ?? "No deployable basket"}`);
  return frozenBasket(preview, config);
}

// --- Proposals --------------------------------------------------------------

function toProposalSummary(row: ThemeProposalRecord): ThemeProposalSummary {
  return {
    id: row.id,
    slug: row.theme,
    status: row.status,
    basketHash: row.basketHash,
    chainId: row.chainId,
    deployTx: row.deployTx,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tokenName: row.basket.tokenName,
    tokenSymbol: row.basket.tokenSymbol,
    constituentCount: row.basket.constituents.length,
    creatorFeeBps: row.basket.creatorFeeBps,
  };
}

/** One proposal belonging to the caller, or a 404. Proposals are private to
 *  their creator; there is deliberately no read-by-id for anyone else. */
async function ownedProposal(
  ctx: Context,
  creator: string,
  proposalId: string,
): Promise<ThemeProposalRecord> {
  const [row] = await ctx.db
    .select()
    .from(themeProposals)
    .where(and(eq(themeProposals.id, proposalId), eq(themeProposals.creator, creator)))
    .limit(1);

  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such proposal for this wallet" });
  }
  return row;
}

/** Deployed themes are counted in single digits on testnet. The cap only stops
 *  an unbounded scan. */
const PROPOSAL_LIST_LIMIT = 50;

// --- Router -----------------------------------------------------------------

export const themeRouter = router({
  /** Separate from construction: reuse must work even if current depth or feed
   * gates would refuse a NEW deployment. No private proposal is returned. */
  sharedVault: publicProcedure.input(slugInput).query(async ({ ctx, input }) => {
    if (!findLens(input.slug)) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown lens" });
    return { tokenId: await deployedTokenIdFor(ctx, input.slug) };
  }),
  /**
   * Step 1. The candidate basket drawn from a lens, restricted to
   * `vaultEligible` names, with every excluded member listed beside it and the
   * curated weights renormalised over the survivors.
   *
   * Public: proposing a basket reads nothing user-scoped and the research
   * surfaces are wallet-free (locked decision 1). Only `deploy` needs an
   * identity, because the creator is a party to the policy.
   */
  construct: publicProcedure
    .input(slugInput)
    .query(async ({ ctx, input }): Promise<ThemeConstruction> => {
      const built = await build(ctx, input.slug, { creatorFeeBps: DEFAULT_CREATOR_FEE_BPS });
      return built.proposal;
    }),

  /**
   * Steps 2 and 3. The same basket after the redeemability gate, with every
   * dropped or reduced name and its depth figure, the basket's routed-redeem
   * ceiling, the streaming fee the policy would freeze forever, and the
   * `basketHash` a deploy has to quote back.
   *
   * A caller may supply `weights`. Those are revalidated against the live
   * universe before anything is done with them and the gate then runs on them,
   * so `adjustments` describes what it did to the caller's proposal. Everything
   * else is rederived from the lens file and the universe: an approval approves
   * what the engine computed, not what a browser posted.
   */
  preview: publicProcedure
    .input(previewInput)
    .query(async ({ ctx, input }): Promise<ThemePreview> => {
      const built = await build(ctx, input.slug, {
        creatorFeeBps: input.creatorFeeBps ?? DEFAULT_CREATOR_FEE_BPS,
        weights: input.weights,
      });
      return built.preview;
    }),

  /** Execution readiness for deposits, exits and claim recovery; not creation permission. */
  readiness: publicProcedure.query(
    async (): Promise<
      ThemeDeployReadiness & {
        mode: string | null;
        deploymentId: string | null;
        manifestDigest: string | null;
        explorerUrl: string | null;
        reasons: string[];
        walletVerification: { address: Address; codeSha256: string } | null;
        publicDeploymentEnabled: false;
      }
    > => {
      const execution = await executionReadiness();
      return {
        publicDeploymentEnabled: false,
        // Creation being disabled must never disable legacy exits or claims.
        ready: execution.ready,
        walletRpcUrl: execution.walletRpcUrl,
        chainId: execution.chainId ?? TESTNET_CHAIN_ID,
        factory: execution.factory,
        usdg: execution.usdg,
        venues: execution.adapters,
        missing: execution.reasons.map((name) => ({
          name,
          detail: "Execution identity is not verified; no transaction plan can be issued.",
        })),
        mode: execution.mode,
        deploymentId: execution.deploymentId,
        manifestDigest: execution.manifestDigest,
        explorerUrl: execution.explorerUrl,
        reasons: execution.reasons,
        walletVerification: execution.walletVerification,
      };
    },
  ),

  /** Compatibility tombstone: public proposal creation is disabled; historical reads remain. */
  save: protectedProcedure.input(saveInput).mutation((): ThemeSaveResult => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Public vault creation and registration are disabled. Use the registered predefined vault.",
    });
  }),

  /** The caller's own proposals, newest first. Private by design: see the
   *  `theme_proposals` docblock in `db/schema.ts`. */
  list: protectedProcedure.query(async ({ ctx }): Promise<ThemeProposalSummary[]> => {
    const rows = await ctx.db
      .select()
      .from(themeProposals)
      .where(eq(themeProposals.creator, ctx.session.address))
      .orderBy(desc(themeProposals.updatedAt))
      .limit(PROPOSAL_LIST_LIMIT);
    return rows.map(toProposalSummary);
  }),

  /** One saved proposal with its frozen basket, for returning to a draft. */
  load: protectedProcedure
    .input(proposalIdInput)
    .query(async ({ ctx, input }): Promise<ThemeProposalDetail> => {
      const row = await ownedProposal(ctx, ctx.session.address, input.proposalId);
      return { ...toProposalSummary(row), basket: row.basket };
    }),

  /** Retire a proposal the creator no longer wants: `status = "deprecated"`.
   *  Kept rather than deleted, because a policy someone approved and then
   *  abandoned is part of the record of what was approved. */
  discard: protectedProcedure
    .input(proposalIdInput)
    .mutation(async ({ ctx, input }): Promise<ThemeProposalSummary> => {
      await ownedProposal(ctx, ctx.session.address, input.proposalId);
      const [row] = await ctx.db
        .update(themeProposals)
        .set({ status: "deprecated", updatedAt: new Date() })
        .where(
          and(
            eq(themeProposals.id, input.proposalId),
            eq(themeProposals.creator, ctx.session.address),
          ),
        )
        .returning();

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such proposal for this wallet" });
      }
      return toProposalSummary(row);
    }),

  /** Compatibility tombstone: only the separate operator bootstrap prepares deployments. */
  deploy: protectedProcedure.input(deployInput).mutation((): ThemeDeployResult => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Public vault creation and registration are disabled. Use the registered predefined vault.",
    });
  }),

  /** Compatibility tombstone: browser-supplied receipts cannot register official vaults. */
  recordBroadcast: protectedProcedure
    .input(recordBroadcastInput)
    .mutation((): ThemeProposalSummary => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Public vault creation and registration are disabled. Use the registered predefined vault.",
      });
    }),

  /**
   * What a broadcast deploy became.
   *
   * The addresses come from `theme_tokens`, which the BE-26 vault indexer writes
   * when it sees the `ThemeDeployed` log, so they are indexed facts rather than
   * a decode of an unconfirmed receipt. Until that row exists the receipt itself
   * is read, because "pending forever" is the wrong answer to a reverted or
   * dropped transaction and the client is polling this to learn whether its own
   * vault exists.
   *
   * The one write here is a reconciliation, not a decision: when the indexer has
   * confirmed a deploy, the proposal that authorised it is moved to `deployed`.
   * It is idempotent, derived entirely from an indexed on-chain fact, and it is
   * the only way that status is ever reached.
   */
  deployStatus: publicProcedure
    .input(deployStatusInput)
    .query(async ({ ctx, input }): Promise<ThemeDeployStatus> => {
      const [row] = await ctx.db
        .select({
          id: themeTokens.id,
          vault: themeTokens.vault,
          spec: themeTokens.spec,
          deployedAt: themeTokens.deployedAt,
          chainId: themeTokens.chainId,
          canonical: themeTokens.canonical,
          canonicalReason: themeTokens.canonicalReason,
        })
        .from(themeTokens)
        .where(eq(sql`lower(${themeTokens.deployTx})`, input.txHash))
        .limit(1);

      if (row) {
        // No write here. The proposal is reconciled to `deployed` by the vault
        // indexer, in the same transaction as the `theme_tokens` row that proves
        // the deploy, so the transition does not depend on anyone polling this.
        return {
          status: row.canonical ? "deployed" : "orphaned",
          txHash: input.txHash,
          chainId: row.chainId,
          tokenId: row.id,
          vault: row.vault,
          feeController: row.spec.feeController,
          deployedAt: row.deployedAt.toISOString(),
          detail: row.canonical
            ? null
            : `The deployment was once indexed but is no longer canonical on the execution chain (${row.canonicalReason ?? "reorg"}). Reconcile the execution history before retrying.`,
        };
      }

      const pending = {
        txHash: input.txHash,
        chainId: TESTNET_CHAIN_ID,
        tokenId: null,
        vault: null,
        feeController: null,
        deployedAt: null,
      } as const;

      const receipt = await readDeployReceipt(input.txHash);

      switch (receipt) {
        case "reverted":
          return {
            ...pending,
            status: "failed",
            detail:
              "The deploy transaction reverted on chain, so no vault was created and nothing was spent beyond gas. The basket is unchanged; preview it again and re-approve to retry.",
          };
        case "mined":
          return {
            ...pending,
            status: "pending",
            detail:
              "Mined on testnet 46630. Waiting for the vault indexer to read the ThemeDeployed log, which is where the addresses come from.",
          };
        case "queued":
          return {
            ...pending,
            status: "pending",
            detail: "Broadcast and accepted by the node, not mined yet.",
          };
        case "unreachable":
          return {
            ...pending,
            status: "pending",
            detail:
              "The testnet RPC could not be reached to check this transaction. That is a gap in what Cortex can see, not a statement about the transaction.",
          };
        case "absent": {
          const broadcastAgeMs = input.broadcastAt
            ? Date.now() - new Date(input.broadcastAt).getTime()
            : 0;
          if (broadcastAgeMs > DROPPED_AFTER_MS) {
            return {
              ...pending,
              status: "unknown",
              detail: `Testnet 46630 has neither mined nor queued this transaction ${Math.round(broadcastAgeMs / 1000)}s after it was broadcast, so it was most likely dropped. Cortex cannot prove a transaction does not exist, only that it has not seen this one. Re-approving and sending again is safe: nothing was deployed.`,
            };
          }
          return {
            ...pending,
            status: "pending",
            detail: "Broadcast. The node has not reported this transaction yet.",
          };
        }
      }
    }),
});

/**
 * What testnet 46630 knows about a transaction hash.
 *
 * Split from the procedure because the five answers are the whole substance of
 * the failure state and they read better named than as nested try/catch. An RPC
 * that cannot be reached is `unreachable`, never `absent`: those are opposite
 * claims and collapsing them would report a healthy transaction as dropped every
 * time the node hiccuped.
 */
async function readDeployReceipt(
  txHash: string,
): Promise<"reverted" | "mined" | "queued" | "absent" | "unreachable"> {
  const hash = txHash as `0x${string}`;

  try {
    const receipt = await executionPublicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? "mined" : "reverted";
  } catch (err) {
    if (!(err instanceof TransactionReceiptNotFoundError)) {
      log.warn("testnet receipt read failed", { txHash, err });
      return "unreachable";
    }
  }

  // No receipt. Either it is sitting in the node's pool, or the node has never
  // heard of it.
  try {
    await executionPublicClient.getTransaction({ hash });
    return "queued";
  } catch (err) {
    if (err instanceof TransactionNotFoundError) return "absent";
    log.warn("testnet transaction read failed", { txHash, err });
    return "unreachable";
  }
}
