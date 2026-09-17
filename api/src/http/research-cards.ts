import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import type { ResearchCardSnapshot } from "@shared/contracts.ts";

import { logger } from "../lib/logger.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { renderCardPng, renderUnavailablePng } from "./card-image.ts";
import { assetSnapshot, CardNotFound, lensSnapshot, signalSnapshot } from "./card-snapshot.ts";

/* Shareable Research Cards: the public, keyless surface a Cortex insight travels
   on once it leaves the terminal.

   Two documents per subject. `/api/card/<subject>/<id>.json` is the snapshot
   itself, with its canonical id, its evidence, its sources and its "as of".
   `/card/<subject>/<id>.png` is the same snapshot rendered as an Open Graph
   image, which is what a chat client or a timeline actually unfurls.

   Outside tRPC for the same reason the badges are: a link preview crawler will
   issue one plain GET and speaks neither superjson nor POST. */

const log = logger.child({ module: "research-cards" });

/* Rendering a card costs a layout pass and a rasterise, so this bucket is
   tighter than the stats one and separate from both it and the terminal's: a
   crawler storm on one viral card must not slow the terminal or the badges. */
const takeToken = createRateLimiter({
  capacity: 60,
  refillPerSec: 10,
  prefix: "ratelimit:research-cards",
});

function clientIp(headers: Headers): string {
  // The tunnel gives the visitor address to the origin in this header. Use it
  // first so a caller cannot rotate the bucket by adding its own X-Forwarded-For.
  const cloudflare = headers.get("cf-connecting-ip");
  if (cloudflare) return cloudflare.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}

const rateLimit: MiddlewareHandler = async (c, next) => {
  const ip = clientIp(c.req.raw.headers);
  if (!(await takeToken(ip))) {
    log.warn("research card rate limit exceeded", { ip, path: c.req.path });
    return c.json({ error: "Too many requests" }, 429, { "Retry-After": "1" });
  }
  return next();
};

/* An immutable subject may be cached by anyone for a long time: a signal's id
   names one computed observation that can never change, so re-fetching it is
   pure waste. A live subject gets the same short window the lens read itself is
   cached for, and `stale-while-revalidate` keeps a preview rendering through a
   cold refresh. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const LIVE_CACHE = "public, max-age=30, stale-while-revalidate=60";

function cacheControl(snapshot: ResearchCardSnapshot): string {
  return snapshot.immutable ? IMMUTABLE_CACHE : LIVE_CACHE;
}

/** Strip a known extension so `/card/signal/abc.png` and `/card/signal/abc`
 *  both resolve. Ids are opaque, so only the exact suffix comes off. */
function withoutExtension(value: string, extension: string): string {
  return value.endsWith(extension) ? value.slice(0, -extension.length) : value;
}

type Loader = (id: string) => Promise<ResearchCardSnapshot>;

const LOADER: Record<string, Loader> = {
  signal: signalSnapshot,
  asset: assetSnapshot,
  lens: lensSnapshot,
};

function loaderFor(subject: string): Loader | null {
  return Object.hasOwn(LOADER, subject) ? LOADER[subject]! : null;
}

export const researchCards = new Hono();

// Open CORS, no credentials. A card is meant to be read from anywhere, and
// nothing on it is per-caller, so there is no cookie to leak.
researchCards.use(
  "/api/card/*",
  cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }),
  rateLimit,
);
researchCards.use("/card/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }), rateLimit);

/** What can be shared, so the surface is discoverable without the docs. */
researchCards.get("/api/card", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    subjects: [
      {
        subject: "signal",
        describes: "One computed signal, with its evidence, sources and confidence",
        idIs: "The signal's deterministic id, as returned by signal.feed and signal.byId",
        snapshot: `${origin}/api/card/signal/{id}.json`,
        image: `${origin}/card/signal/{id}.png`,
        immutable: true,
      },
      {
        subject: "asset",
        describes: "An asset-quality read with price, oracle agreement and eligibility state",
        idIs: "The canonical lower-case token address, as returned by universe.byAddress",
        snapshot: `${origin}/api/card/asset/{tokenAddress}.json`,
        image: `${origin}/card/asset/{tokenAddress}.png`,
        immutable: false,
      },
      {
        subject: "lens",
        describes: "A theme lens as read at an instant, with its constituents and flow",
        idIs: "The lens slug, as returned by lens.themes",
        snapshot: `${origin}/api/card/lens/{slug}.json`,
        image: `${origin}/card/lens/{slug}.png`,
        immutable: false,
      },
    ],
  });
});

researchCards.get("/api/card/:subject/:file", async (c) => {
  const subject = c.req.param("subject");
  const load = loaderFor(subject);
  if (!load) {
    return c.json({ error: "unknown card subject", subjects: Object.keys(LOADER) }, 404, {
      "Cache-Control": "no-store",
    });
  }

  const id = withoutExtension(c.req.param("file"), ".json");

  try {
    const snapshot = await load(id);
    return c.json(snapshot, 200, { "Cache-Control": cacheControl(snapshot) });
  } catch (err) {
    if (err instanceof CardNotFound) {
      return c.json({ error: `no such ${subject}`, id }, 404, { "Cache-Control": "no-store" });
    }
    log.error("card snapshot unavailable", { err, subject, id });
    // 503 and no document. A partial snapshot would be cited as though the
    // missing halves were genuinely absent from the research.
    return c.json({ error: "card unavailable" }, 503, { "Cache-Control": "no-store" });
  }
});

researchCards.get("/card/:subject/:file", async (c) => {
  const subject = c.req.param("subject");
  const load = loaderFor(subject);
  const id = withoutExtension(c.req.param("file"), ".png");

  const png = async (body: Uint8Array, status: 200, cache: string) =>
    c.body(body as unknown as ArrayBuffer, status, {
      "Content-Type": "image/png",
      "Cache-Control": cache,
    });

  if (!load) {
    return png(await renderUnavailablePng(`Cortex has no "${subject}" card.`), 200, "no-store");
  }

  try {
    const snapshot = await load(id);
    return png(await renderCardPng(snapshot), 200, cacheControl(snapshot));
  } catch (err) {
    const missing = err instanceof CardNotFound;
    if (!missing) log.error("card image could not be rendered", { err, subject, id });

    // Always a PNG and always 200, for the same reason the badges are: a preview
    // that 404s renders as a broken image in somebody else's chat. It says what
    // is wrong and is told not to cache, so the next unfurl can recover.
    return png(
      await renderUnavailablePng(
        missing
          ? `This ${subject} is no longer available at that link.`
          : "This card could not be rendered right now.",
      ),
      200,
      "no-store",
    );
  }
});
