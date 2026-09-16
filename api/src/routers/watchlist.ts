import { TRPCError } from "@trpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { universe, watchlists } from "../db/schema.ts";
import { loadLenses } from "../lenses/load.ts";
import { protectedProcedure, router, type Context } from "../trpc.ts";

/**
 * The per-user watchlist (BE-22). `spec/CortexBackend.md` PART 5 owns the table,
 * PART 1 fixes the identity: a watchlist belongs to a proven wallet address.
 *
 * Both routes are `protectedProcedure` and every query is scoped to
 * `ctx.session.address`, the lowercased `0x…` address BE-21 verified. No route
 * accepts a `userId` or address as an input: taking one would let any caller
 * read or overwrite another user's watchlist.
 *
 * `get()` returns empty arrays for a user with no row rather than throwing.
 * `set()` upserts and validates that every ticker is a known `universe.symbol`
 * and every theme is a known lens slug, with both arrays capped so a client
 * cannot write unbounded data.
 */

/** Cap so a single write cannot store unbounded data (task requirement 5). */
const MAX_ITEMS = 200;

/** A ticker symbol. Normalised to upper case to match `universe.symbol`. */
const tickerSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .transform((value) => value.toUpperCase());

/** A lens slug. Normalised to lower case to match `data/lenses.json`. */
const themeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase());

const setInput = z
  .object({
    tickers: z.array(tickerSchema).max(MAX_ITEMS),
    themes: z.array(themeSchema).max(MAX_ITEMS),
  })
  .strict();

interface Watchlist {
  tickers: string[];
  themes: string[];
}

const EMPTY: Watchlist = { tickers: [], themes: [] };

/** Drop duplicates while preserving first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Reject any theme that is not a slug in `data/lenses.json`. The catalog is a
 * validated, memoised file read (BE-18), so this is a synchronous set lookup.
 */
function assertKnownThemes(themes: string[]): void {
  if (themes.length === 0) return;
  const known = new Set(loadLenses().map((lens) => lens.slug));
  const unknown = themes.filter((slug) => !known.has(slug));
  if (unknown.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown theme lens: ${unknown.join(", ")}`,
    });
  }
}

/**
 * Reject any ticker that is not a live `universe.symbol`. Cross-checked against
 * the table rather than a static list so the set tracks the refresher (BE-5).
 */
async function assertKnownTickers(ctx: Context, tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;
  const rows = await ctx.db
    .select({ symbol: sql<string>`upper(${universe.symbol})` })
    .from(universe)
    .where(inArray(sql`upper(${universe.symbol})`, tickers));

  const known = new Set(rows.map((row) => row.symbol));
  const unknown = tickers.filter((symbol) => !known.has(symbol));
  if (unknown.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown ticker: ${unknown.join(", ")}`,
    });
  }
}

export const watchlistRouter = router({
  /** The caller's watchlist. Empty arrays when no row exists yet. */
  get: protectedProcedure.query(async ({ ctx }): Promise<Watchlist> => {
    const [row] = await ctx.db
      .select({ tickers: watchlists.tickers, themes: watchlists.themes })
      .from(watchlists)
      .where(eq(watchlists.userId, ctx.session.address))
      .limit(1);

    if (!row) return EMPTY;
    return { tickers: row.tickers, themes: row.themes };
  }),

  /** Replace the caller's watchlist. Upserts on the address. */
  set: protectedProcedure
    .input(setInput)
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      const tickers = unique(input.tickers);
      const themes = unique(input.themes);

      assertKnownThemes(themes);
      await assertKnownTickers(ctx, tickers);

      const now = new Date();
      await ctx.db
        .insert(watchlists)
        .values({ userId: ctx.session.address, tickers, themes, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: watchlists.userId,
          set: { tickers, themes, updatedAt: now },
        });

      return { ok: true };
    }),
});
