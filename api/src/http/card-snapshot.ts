import { TRPCError } from "@trpc/server";

import type { LensDetail, ResearchCardSnapshot, Signal, UniverseAsset } from "@shared/contracts.ts";
import {
  formatAbsolute,
  formatMagnitude,
  formatPct,
  formatUsd,
  SIGNAL_KIND_COLOR,
  SIGNAL_KIND_LABEL,
} from "@shared/format.ts";

import { db } from "../db/client.ts";
import { redis } from "../lib/redis.ts";
import { appRouter } from "../routers/index.ts";
import { createCallerFactory, type Context } from "../trpc.ts";

/* The snapshot half of Shareable Research Cards: one canonical id in, one
   `ResearchCardSnapshot` out.

   All subjects are read through the ordinary tRPC routers rather than through
   fresh queries. A card that disagreed with the terminal would be worse than no
   card at all, and the only way it cannot disagree is to read the same code. */

const createCaller = createCallerFactory(appRouter);

/** A context for a caller that has no request behind it. Cards are public, so
 *  there is no session to read and nothing may write a response header. */
function publicContext(): Context {
  return { db, redis, session: null, resHeaders: new Headers() };
}

export type CardSubject = "signal" | "asset" | "lens";

/** Thrown when the id is well-formed but names nothing. The routes turn this
 *  into a 404; anything else is a 503, because it means we failed, not them. */
export class CardNotFound extends Error {
  constructor(subject: CardSubject, id: string) {
    super(`no ${subject} with id ${id}`);
    this.name = "CardNotFound";
  }
}

const RESEARCH_NOT_ADVICE =
  "Research evidence, not financial advice. Cortex does not take custody and no value here is an executable price.";

/** Cards are cited from outside the terminal, so every card carries this line
 *  with it. Exported for the card page, which prints the same words. */
export const CARD_DISCLAIMER = RESEARCH_NOT_ADVICE;

const TOKEN_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function assetGate(asset: UniverseAsset): string {
  if (asset.vaultEligible) return "VAULT ELIGIBLE";
  if (asset.signalEligible) return "RESEARCH ONLY";
  return "INELIGIBLE";
}

function assetCard(asset: UniverseAsset, generatedAt: string): ResearchCardSnapshot {
  const id = asset.tokenAddress.toLowerCase();
  const gate = assetGate(asset);
  const feedRead =
    asset.chainlinkFeed === null
      ? "has no Chainlink feed"
      : asset.feedAgreesWithQuote
        ? "agrees with independent quotes"
        : "diverges from independent quotes";
  const venueLabel = `${asset.venues.length} verified venue${asset.venues.length === 1 ? "" : "s"}`;

  const unavailable: string[] = [];
  if (asset.priceUsd === null) unavailable.push("No independent price is available right now.");
  if (asset.chainlinkFeed === null) {
    unavailable.push("No Chainlink feed is attached to this asset.");
  }
  if (asset.quoteBid === null || asset.quoteAsk === null) {
    unavailable.push("An independent bid/ask quote is unavailable.");
  }
  if (asset.venues.length === 0) unavailable.push("No verified liquidity venues are attached.");
  unavailable.push(...asset.ineligibleReasons);

  const sourceCandidates: Array<string | null> = [asset.chainlinkFeed, ...asset.venues];
  const sources = Array.from(
    new Set(sourceCandidates.filter((value): value is string => value !== null)),
  );

  return {
    kind: "asset",
    id,
    path: `/card/asset/${id}`,
    headline: `${asset.symbol} · ASSET QUALITY`,
    summary:
      asset.priceUsd === null
        ? `${asset.name} has no usable price from the current research sources.`
        : `${asset.name} is ${gate.toLowerCase()}; its Chainlink feed ${feedRead}.`,
    accent: "#4A6FFF",
    badge: gate,
    stats: [
      { label: "Price", value: formatUsd(asset.priceUsd), mono: true },
      { label: "24h", value: formatPct(asset.change24hPct, { sign: true }), mono: true },
      { label: "Pool depth", value: formatUsd(asset.poolDepthUsd, { compact: true }), mono: true },
      {
        label: "Feed vs quote",
        value:
          asset.chainlinkFeed === null
            ? "NO FEED"
            : asset.feedAgreesWithQuote
              ? "AGREE"
              : "DIVERGENT",
        mono: true,
      },
      { label: "Gate", value: gate, mono: true },
    ],
    evidenceLine:
      `${feedRead}; ${venueLabel}; ` +
      `pool depth ${formatUsd(asset.poolDepthUsd, { compact: true })}.`,
    sources,
    asOf: asset.refreshedAt,
    generatedAt,
    immutable: false,
    unavailable,
  };
}

// --- Signal -----------------------------------------------------------------

/* A signal is immutable. Its id is `hash(kind|ticker|windowEnd)`, so the same
   id always names the same computed observation; when the underlying reading
   changes the worker writes a new row and points `supersededBy` at it rather
   than editing this one. That is what makes a signal card a permanent record
   and lets its image be cached hard. */
function signalCard(signal: Signal): ResearchCardSnapshot {
  const { kind, evidence } = signal;

  const unavailable: string[] = [];
  if (signal.sources.length === 0) {
    unavailable.push("No source records were attached to this signal");
  }

  return {
    kind: "signal",
    id: signal.id,
    path: `/card/signal/${signal.id}`,
    headline: `${signal.ticker} · ${SIGNAL_KIND_LABEL[kind]}`,
    summary: signal.explanation,
    accent: SIGNAL_KIND_COLOR[kind],
    badge: `${signal.confidence} CONFIDENCE`,
    stats: [
      { label: "Magnitude", value: formatMagnitude(kind, signal.magnitude), mono: true },
      { label: "Z-score", value: signal.zScore.toFixed(2), mono: true },
      { label: "Window", value: signal.window, mono: true },
      { label: "Sample size", value: `${evidence.sampleSize}`, mono: true },
    ],
    evidenceLine:
      `Observed ${formatMagnitude(kind, evidence.observed)} against a ` +
      `${formatMagnitude(kind, evidence.baseline, { sign: false })} baseline, ` +
      `over blocks ${evidence.fromBlock.toLocaleString("en-US")} – ${evidence.toBlock.toLocaleString("en-US")}.`,
    sources: signal.sources,
    asOf: signal.ts,
    generatedAt: new Date().toISOString(),
    // Superseded or not, this row's own values never change again.
    immutable: true,
    unavailable,
  };
}

// --- Lens -------------------------------------------------------------------

/* A lens is the opposite case: a live aggregate that is recomputed every few
   minutes. The card is explicitly a reading taken at an instant, never a
   permanent record, and `immutable: false` is what tells the routes not to let
   a CDN hold the image the way it holds a signal's. */
function lensCard(detail: LensDetail, generatedAt: string): ResearchCardSnapshot {
  // BE-19: an empty series means the aggregate could not be computed this cycle.
  // The summary numbers are coalesced to 0 at the API boundary, so without this
  // check a lens that could not be read would render as a confident "0.0%".
  const computable = detail.series.length > 0;

  const unavailable: string[] = [];
  if (!computable) {
    unavailable.push(
      "This theme could not be computed for the latest cycle. too few of its constituents are liquid enough to read as a whole.",
    );
  }

  const green = detail.members.filter((member) => (member.change24hPct ?? 0) > 0).length;
  const unpriced = detail.members.filter((member) => member.change24hPct === null).length;
  if (unpriced > 0) {
    unavailable.push(
      `${unpriced} of ${detail.memberCount} constituents are unpriceable right now and are counted in neither direction.`,
    );
  }

  const stats: ResearchCardSnapshot["stats"] = computable
    ? [
        { label: "Move", value: formatPct(detail.movePct, { sign: true }), mono: true },
        {
          label: "Net flow · 7d",
          value: formatUsd(detail.netFlowUsd, { compact: true, sign: true }),
          mono: true,
        },
        { label: "Constituents", value: `${detail.memberCount}`, mono: true },
        { label: "Green", value: `${green} of ${detail.memberCount}`, mono: true },
        { label: "Signals · 24h", value: `${detail.signalCount24h}`, mono: true },
      ]
    : [
        { label: "Constituents", value: `${detail.memberCount}`, mono: true },
        { label: "Signals · 24h", value: `${detail.signalCount24h}`, mono: true },
      ];

  return {
    kind: "lens",
    id: detail.slug,
    path: `/card/lens/${detail.slug}`,
    headline: detail.name,
    summary: detail.thesis,
    accent: detail.color,
    badge: computable ? `${detail.memberCount} NAMES` : "NOT COMPUTABLE",
    stats,
    // A lens read is the aggregate itself; there is no observed-against-expected
    // pair underneath it the way a signal has one.
    evidenceLine: computable
      ? `${green} of ${detail.memberCount} constituents green over 24h, weighted by the lens's own allocation.`
      : null,
    sources: [],
    // A lens has no computation timestamp of its own on the contract, so the
    // reading is as of when it was taken. Stated rather than implied.
    asOf: generatedAt,
    generatedAt,
    immutable: false,
    unavailable,
  };
}

// --- Entry points -----------------------------------------------------------

export async function signalSnapshot(id: string): Promise<ResearchCardSnapshot> {
  const caller = createCaller(publicContext());
  try {
    return signalCard(await caller.signal.byId({ id }));
  } catch (err) {
    if (err instanceof TRPCError && err.code === "NOT_FOUND") {
      throw new CardNotFound("signal", id);
    }
    throw err;
  }
}

export async function assetSnapshot(tokenAddress: string): Promise<ResearchCardSnapshot> {
  if (!TOKEN_ADDRESS.test(tokenAddress)) throw new CardNotFound("asset", tokenAddress);

  const caller = createCaller(publicContext());
  try {
    const asset = await caller.universe.byAddress({ tokenAddress });
    return assetCard(asset, new Date().toISOString());
  } catch (err) {
    if (err instanceof TRPCError && err.code === "NOT_FOUND") {
      throw new CardNotFound("asset", tokenAddress);
    }
    throw err;
  }
}

export async function lensSnapshot(slug: string): Promise<ResearchCardSnapshot> {
  const caller = createCaller(publicContext());
  try {
    const detail = await caller.lens.byTheme({ slug });
    return lensCard(detail, new Date().toISOString());
  } catch (err) {
    if (err instanceof TRPCError && err.code === "NOT_FOUND") {
      throw new CardNotFound("lens", slug);
    }
    throw err;
  }
}

/** The "as of" line every rendered card carries, in the one UTC format the
 *  terminal also prints. */
export function asOfLabel(snapshot: ResearchCardSnapshot): string {
  return formatAbsolute(snapshot.asOf);
}
