import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import type { MarketSession } from "@shared/contracts.ts";

import { db } from "../db/client.ts";
import { logger } from "../lib/logger.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { redis } from "../lib/redis.ts";
import { OVERVIEW_CACHE_TTL_SEC, overviewReading, type OverviewReading } from "../routers/stats.ts";

/* The public, keyless read of the network's own numbers: the JSON document and
   the embeddable badges. Both read `overviewReading`, the same reading the
   terminal renders, so a badge in somebody's README and the Network view can
   never disagree.

   Deliberately outside tRPC. A README, a monitor or a curl pipeline should not
   have to speak superjson-over-POST to read a number we already publish. */

const log = logger.child({ module: "public-stats" });

/** `{ db, redis }`, module-level. These routes have no session and no context. */
const deps = { db, redis };

/* Badges are embedded, so one page view can fan out to several requests and a
   GitHub README is fetched through a caching proxy on one address. The budget is
   separate from the tRPC bucket: a hot badge must not spend the terminal's. */
const takeToken = createRateLimiter({
  capacity: 240,
  refillPerSec: 60,
  prefix: "ratelimit:public-stats",
});

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("cf-connecting-ip") ?? headers.get("x-real-ip") ?? "unknown";
}

/** Served from a 30s cache, so the browser and any CDN may hold it just as long.
 *  `stale-while-revalidate` keeps a badge rendering through a cold refresh. */
const CACHE_CONTROL = `public, max-age=${OVERVIEW_CACHE_TTL_SEC}, stale-while-revalidate=60`;

// --- Badges -----------------------------------------------------------------

const SESSION_LABEL: Record<MarketSession, string> = {
  pre: "pre-market",
  rth: "open",
  after: "after-hours",
  closed: "closed",
};

function round(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

interface BadgeMetric {
  /** The grey left half. */
  label: string;
  /** The coloured right half, read off one overview reading. */
  value: (reading: OverviewReading) => string;
  /** What the badge is for, listed at `/badge`. */
  describes: string;
}

/* The published badge set. Adding a metric here is the whole change: the index,
   the route and the Network view's copy blocks all read this map. */
export const BADGE_METRICS = {
  signals: {
    label: "cortex",
    value: (r) => `${r.stats.signals24h.toLocaleString("en-US")} signals · 24h`,
    describes: "Signals published in the last 24 hours",
  },
  feeds: {
    label: "feed agreement",
    value: (r) => `${round(r.stats.feedAgreementPct, 1)}% of ${r.stats.feedsTotal}`,
    describes: "Chainlink feeds agreeing with the market quote",
  },
  universe: {
    label: "stock tokens",
    value: (r) => `${r.stats.assetsActive} tracked`,
    describes: "Factory-deployed Stock Tokens with supply",
  },
  vault: {
    label: "vault-eligible",
    value: (r) => `${r.stats.vaultEligibleCount} of ${r.stats.assetsActive}`,
    describes: "Assets a vault contract can actually price",
  },
  session: {
    label: "market",
    value: (r) => SESSION_LABEL[r.stats.session],
    describes: "The current market session",
  },
  mismatches: {
    label: "mismatches today",
    value: (r) => `${r.stats.multiplierMismatchesToday}`,
    describes: "Multiplier mismatches caught today",
  },
} as const satisfies Record<string, BadgeMetric>;

export type BadgeMetricName = keyof typeof BADGE_METRICS;

function isBadgeMetric(name: string): name is BadgeMetricName {
  return Object.hasOwn(BADGE_METRICS, name);
}

const BRAND_INK = "#0D0D12";
const BRAND_BLUE = "#4A6FFF";
/** The one state that is not a number: the reading failed. Never a zero. */
const UNAVAILABLE_GREY = "#9A9CAD";

/* An 11px sans label is about 6.2px per character across mixed case, and the
   digits and lowercase that make up every value here sit close to that mean.
   Measuring properly would mean shipping font metrics for a two-word string. */
const CHAR_PX = 6.2;
const SIDE_PAD = 10;

function textWidth(text: string): number {
  return Math.ceil(text.length * CHAR_PX);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A flat two-part badge, drawn here rather than proxied through shields.io: an
 * embedded badge is a link back on somebody else's page, and it should not make
 * that page depend on a third party or hand a third party its traffic.
 */
function badgeSvg(label: string, value: string, valueColor: string): string {
  const labelWidth = textWidth(label) + SIDE_PAD * 2;
  const valueWidth = textWidth(value) + SIDE_PAD * 2;
  const width = labelWidth + valueWidth;
  const height = 20;
  const alt = `${label}: ${value}`;

  // Text is drawn twice: a black copy at 30% under the white one, which is how a
  // flat badge stays legible against both halves without a stroke.
  const text = (content: string, x: number): string => `
    <text x="${x}" y="15" fill="#000" fill-opacity=".3" textLength="${textWidth(content)}">${escapeXml(content)}</text>
    <text x="${x}" y="14" fill="#fff" textLength="${textWidth(content)}">${escapeXml(content)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${escapeXml(alt)}">
  <title>${escapeXml(alt)}</title>
  <rect width="${width}" height="${height}" rx="3" fill="${BRAND_INK}"/>
  <path fill="${valueColor}" d="M${labelWidth} 0h${valueWidth - 3}a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H${labelWidth}z"/>
  <g font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">${text(label, SIDE_PAD)}${text(value, labelWidth + SIDE_PAD)}
  </g>
</svg>`;
}

// --- Routes -----------------------------------------------------------------

const rateLimit: MiddlewareHandler = async (c, next) => {
  const ip = clientIp(c.req.raw.headers);
  if (!(await takeToken(ip))) {
    log.warn("public stats rate limit exceeded", { ip, path: c.req.path });
    return c.json({ error: "Too many requests" }, 429, { "Retry-After": "1" });
  }
  return next();
};

export const publicStats = new Hono();

// Open CORS, no credentials: the point of this surface is that anyone may read
// it from anywhere. Nothing here is per-caller, so there is no cookie to leak.
publicStats.use(
  "/api/stats.json",
  cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }),
  rateLimit,
);
publicStats.use("/badge/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }), rateLimit);

publicStats.get("/api/stats.json", async (c) => {
  try {
    const reading = await overviewReading(deps);
    return c.json(
      {
        generatedAt: reading.generatedAt,
        cacheTtlSec: OVERVIEW_CACHE_TTL_SEC,
        ...reading.stats,
      },
      200,
      { "Cache-Control": CACHE_CONTROL },
    );
  } catch (err) {
    log.error("public stats document unavailable", { err });
    // 503 and no numbers. A partial document here would be read as the network
    // being empty rather than as us being unable to answer.
    return c.json({ error: "stats unavailable" }, 503);
  }
});

/** What can be embedded, so the badge set is discoverable without the docs. */
publicStats.get("/badge", (c) =>
  c.json({
    metrics: Object.entries(BADGE_METRICS).map(([name, metric]) => ({
      name,
      describes: metric.describes,
      url: `${new URL(c.req.url).origin}/badge/${name}.svg`,
    })),
  }),
);

publicStats.get("/badge/:file", async (c) => {
  const file = c.req.param("file");
  const name = file.endsWith(".svg") ? file.slice(0, -".svg".length) : file;

  if (!isBadgeMetric(name)) {
    return c.json({ error: "unknown metric", metrics: Object.keys(BADGE_METRICS) }, 404, {
      "Cache-Control": "no-store",
    });
  }

  const metric = BADGE_METRICS[name];

  try {
    const reading = await overviewReading(deps);
    return c.body(badgeSvg(metric.label, metric.value(reading), BRAND_BLUE), 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": CACHE_CONTROL,
    });
  } catch (err) {
    log.error("badge could not be rendered", { err, metric: name });
    // Still an SVG, still 200: an embedded badge that 404s renders as a broken
    // image on someone else's page. It says "unavailable", which is the truth,
    // and it is told not to cache so the next view can recover.
    return c.body(badgeSvg(metric.label, "unavailable", UNAVAILABLE_GREY), 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
  }
});
