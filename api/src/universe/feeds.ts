/**
 * Chainlink feed discovery for Robinhood Chain.
 *
 * Only 35 of the 96 active Stock Tokens have an AggregatorV3 feed, and that
 * split is the whole reason `UniverseAsset` carries two eligibility flags: a
 * vault contract cannot read a REST quote, so the 61 feedless names can appear
 * in signals but can never be a constituent.
 *
 * The mapping lives in Chainlink's public `feeds-robinhood-mainnet` reference
 * directory. It is free and unauthenticated (locked decision 7), it changes
 * only when Chainlink lists a feed, and it is the same file the BE-3 dev script
 * discovers against, so nothing here is hardcoded and new listings are picked up
 * without a deploy.
 *
 * **The symbol join here is a pricing join, never an authenticity join.** The
 * directory has no token address, so a feed is matched to an asset by ticker.
 * That is safe only because the asset on the other side of the join was already
 * address-verified against `StockFactory` (Gate 1). A wrong match would give an
 * authentic asset a wrong price, which the agreement test against `/rhj/prices`
 * then catches. It could never make a spoof authentic.
 */

import { getAddress, type Address } from "viem";
import { z } from "zod";

import { resultOrUndefined, type MulticallItem } from "../chain/multicall.ts";
import { logger } from "../lib/logger.ts";
import { redis } from "../lib/redis.ts";

const log = logger.child({ module: "universe/feeds" });

/** Chainlink's public reference directory for RHC mainnet. */
export const CHAINLINK_DIRECTORY_URL =
  "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

/**
 * The directory also carries crypto and stablecoin feeds (BTC, LINK, USDG).
 * Only the "Robinhood " names are equity feeds over a Stock Token.
 */
const EQUITY_FEED_PREFIX = "Robinhood ";

/**
 * 86400 on every equity feed observed. Read from the directory anyway; this is
 * only the fallback when the field is missing.
 *
 * Note what the heartbeat is and is not. It bounds liveness: a working feed
 * posts at least daily even with zero movement. It says nothing about accuracy,
 * which comes from the 0.5% deviation threshold instead, and it is never used
 * off-chain as a staleness budget (global do-not 1).
 */
export const CHAINLINK_EQUITY_HEARTBEAT_SEC = 86_400;

const CACHE_KEY = "universe:chainlink-directory:v1";
/** The directory changes when Chainlink lists a feed, which is rare. */
const CACHE_TTL_SEC = 6 * 60 * 60;
const FETCH_TIMEOUT_MS = 8_000;

const directoryEntryWire = z.looseObject({
  name: z.string(),
  proxyAddress: z.string().nullable().optional(),
  heartbeat: z.number().nullable().optional(),
  decimals: z.number().nullable().optional(),
});

const directoryWire = z.array(directoryEntryWire);

export interface ChainlinkFeed {
  /** Ticker as it appears in `/rhj/assets`, uppercased. */
  symbol: string;
  /** The directory's own label, e.g. `Robinhood AAPL / USD`. */
  name: string;
  proxyAddress: Address;
  /** From the directory. The on-chain `decimals()` read is still authoritative. */
  decimals: number | null;
  heartbeatSec: number;
}

export interface FeedDirectory {
  /** Keyed by uppercase ticker. */
  feeds: Map<string, ChainlinkFeed>;
  /** False when the directory could not be read and no earlier copy exists. In
   *  that state no asset can be shown to have a feed, which is a different fact
   *  from an asset having no feed, and the two get different reason strings. */
  available: boolean;
  /** Served from a previous copy because this fetch failed. */
  stale: boolean;
}

/**
 * Ticker out of a directory label.
 *
 * Two forms are in the live directory: `Robinhood AAPL / USD` and
 * `Robinhood SGOV-USD`. Both end in the quote currency, so the quote is
 * stripped rather than the base being parsed positionally, which keeps a hyphen
 * inside a ticker (a class-B share, say) intact.
 */
export function symbolFromFeedName(name: string): string | null {
  if (!name.startsWith(EQUITY_FEED_PREFIX)) return null;

  const withoutPrefix = name.slice(EQUITY_FEED_PREFIX.length).trim();
  const base = (withoutPrefix.split("/")[0] ?? "").trim().replace(/-USD$/i, "").trim();

  return base === "" ? null : base.toUpperCase();
}

function parseDirectory(body: string): Map<string, ChainlinkFeed> {
  const parsed = directoryWire.parse(JSON.parse(body));
  const feeds = new Map<string, ChainlinkFeed>();

  for (const entry of parsed) {
    if (!entry.proxyAddress) continue;

    const symbol = symbolFromFeedName(entry.name);
    if (symbol === null) continue;

    // A duplicate ticker would make the join ambiguous, and an ambiguous
    // pricing source is worse than none. Keep the first and say so.
    if (feeds.has(symbol)) {
      log.warn("duplicate Chainlink feed for a ticker, keeping the first", {
        symbol,
        name: entry.name,
      });
      continue;
    }

    feeds.set(symbol, {
      symbol,
      name: entry.name,
      proxyAddress: getAddress(entry.proxyAddress),
      decimals: entry.decimals ?? null,
      heartbeatSec: entry.heartbeat ?? CHAINLINK_EQUITY_HEARTBEAT_SEC,
    });
  }

  return feeds;
}

/**
 * Last successful parse, kept in the process.
 *
 * Redis is the shared cache; this is the second line so that a Redis outage and
 * a directory outage landing together do not silently strip 35 assets of their
 * feed. Feed addresses do not go bad between deploys, so serving a slightly old
 * copy is strictly better than serving none.
 */
let lastGood: Map<string, ChainlinkFeed> | null = null;

async function readCache(): Promise<string | null> {
  try {
    return await redis.get(CACHE_KEY);
  } catch (err) {
    log.warn("feed directory cache read failed", { err });
    return null;
  }
}

async function writeCache(body: string): Promise<void> {
  try {
    await redis.set(CACHE_KEY, body, "EX", CACHE_TTL_SEC);
  } catch (err) {
    log.warn("feed directory cache write failed", { err });
  }
}

/**
 * The ticker to feed mapping, from Redis when warm and the network when not.
 *
 * Never throws. A directory outage returns `available: false` rather than an
 * empty map that reads as "these assets have no feed", and the caller turns that
 * into its own reason string.
 */
export async function loadFeedDirectory(): Promise<FeedDirectory> {
  const cached = await readCache();
  if (cached !== null) {
    try {
      const feeds = parseDirectory(cached);
      lastGood = feeds;
      return { feeds, available: true, stale: false };
    } catch (err) {
      log.warn("cached feed directory failed to parse, refetching", { err });
    }
  }

  try {
    const response = await fetch(CHAINLINK_DIRECTORY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`directory responded ${response.status}`);

    const body = await response.text();
    const feeds = parseDirectory(body);
    await writeCache(body);
    lastGood = feeds;

    return { feeds, available: true, stale: false };
  } catch (err) {
    log.error("Chainlink feed directory unreachable", { err, url: CHAINLINK_DIRECTORY_URL });

    if (lastGood !== null) {
      return { feeds: lastGood, available: true, stale: true };
    }

    return { feeds: new Map(), available: false, stale: false };
  }
}

/** Drops the in-process copy. Exists for dev scripts, not for shipped paths. */
export function resetFeedDirectoryCache(): void {
  lastGood = null;
}

/**
 * `latestRoundData()` out of a Multicall3 batch entry.
 *
 * Returned as `[roundId, answer, startedAt, updatedAt, answeredInRound]`. A
 * reverted or malformed entry is `null` and never a substituted zero: a feed
 * that did not answer and a feed that answered zero lead to opposite pricing
 * decisions (global do-not 2).
 *
 * Lives here rather than in either worker because both the universe refresher
 * and the price poller read the same 35 feeds and must decode them the same way.
 */
export function asRoundData(
  item: MulticallItem<unknown> | undefined,
): { answer: bigint; updatedAt: number } | null {
  if (!item) return null;
  const value = resultOrUndefined(item);
  if (!Array.isArray(value) || value.length < 4) return null;
  const answer = value[1];
  const updatedAt = value[3];
  if (typeof answer !== "bigint" || typeof updatedAt !== "bigint") return null;
  return { answer, updatedAt: Number(updatedAt) };
}
