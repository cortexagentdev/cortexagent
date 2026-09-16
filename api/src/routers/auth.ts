import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getAddress, verifyMessage } from "viem";
import { z } from "zod";

import {
  NONCE_TTL_SEC,
  SESSION_TTL_SEC,
  clearedSessionCookie,
  sessionCookie,
} from "../auth/session.ts";
import { sessions } from "../db/schema.ts";
import { signSessionJwt } from "../lib/jwt.ts";
import { logger } from "../lib/logger.ts";
import { checkSiweFields, parseSiweMessage } from "../lib/siwe.ts";
import { publicProcedure, router } from "../trpc.ts";

/**
 * SIWE sign-in (BE-21). `spec/CortexBackend.md` PART 1: identity is a wallet
 * address proven by a signature, no passwords and no email.
 *
 * Flow: `nonce` issues a single-use challenge, the web app builds an EIP-4361
 * message around it, the wallet signs it, `verify` checks every field of the
 * message and the signature, and on success sets an httpOnly cookie carrying a
 * short-lived JWT. `me` reports the current session, `logout` revokes it.
 *
 * Every route is a `publicProcedure`: sign-in cannot require a session, and
 * `me` / `logout` must answer cleanly for an anonymous caller too.
 */

const log = logger.child({ module: "auth-router" });

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const nonceInput = z
  .object({ address: z.string().regex(ADDRESS, "Invalid wallet address") })
  .strict();

const verifyInput = z
  .object({
    message: z.string().min(1).max(4096),
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
  })
  .strict();

function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export const authRouter = router({
  /** Issues a fresh single-use nonce for `address` and stores it with a short TTL. */
  nonce: publicProcedure.input(nonceInput).mutation(async ({ ctx, input }) => {
    const address = input.address.toLowerCase();
    const nonce = newNonce();
    const expiresAt = new Date(Date.now() + NONCE_TTL_SEC * 1000);

    await ctx.db
      .insert(sessions)
      .values({ address, nonce, nonceExpiresAt: expiresAt })
      .onConflictDoUpdate({
        target: sessions.address,
        set: { nonce, nonceExpiresAt: expiresAt },
      });

    return { nonce, expiresAt };
  }),

  /**
   * Verifies a signed EIP-4361 message and, on success, issues the session
   * cookie. The nonce is consumed here, so a replay of the same message is
   * rejected at the "no sign-in in progress" check.
   */
  verify: publicProcedure.input(verifyInput).mutation(async ({ ctx, input }) => {
    const fields = parseSiweMessage(input.message);
    if (!fields) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Could not parse the sign-in message" });
    }

    const now = new Date();
    const fieldError = checkSiweFields(fields, now);
    if (fieldError) {
      log.warn("siwe field validation failed", { reason: fieldError, domain: fields.domain });
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign-in message failed validation" });
    }

    const address = fields.address.toLowerCase();
    const [row] = await ctx.db
      .select()
      .from(sessions)
      .where(eq(sessions.address, address))
      .limit(1);

    if (!row || !row.nonce || !row.nonceExpiresAt) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "No sign-in is in progress for this wallet",
      });
    }
    if (row.nonce !== fields.nonce) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign-in nonce does not match" });
    }
    if (row.nonceExpiresAt.getTime() <= now.getTime()) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign-in nonce has expired" });
    }

    let validSignature = false;
    try {
      validSignature = await verifyMessage({
        address: fields.address,
        message: input.message,
        signature: input.signature as `0x${string}`,
      });
    } catch (err) {
      log.warn("siwe signature verification threw", { err });
    }
    if (!validSignature) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Signature did not verify" });
    }

    const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1000);
    await ctx.db
      .update(sessions)
      .set({ nonce: null, nonceExpiresAt: null, issuedAt: now, expiresAt, revokedAt: null })
      .where(eq(sessions.address, address));

    const token = signSessionJwt({
      sub: address,
      sid: String(now.getTime()),
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
    ctx.resHeaders.append("Set-Cookie", sessionCookie(token));

    return { address: fields.address, tier: "open" as const };
  }),

  /** The current session, or null when the caller is anonymous. */
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.session) return null;
    return {
      address: getAddress(ctx.session.address),
      tier: ctx.session.tier,
      siweVerifiedAt: ctx.session.siweVerifiedAt.toISOString(),
    };
  }),

  /** Revokes the session server-side and clears the cookie. Safe to call anonymously. */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.session) {
      await ctx.db
        .update(sessions)
        .set({ revokedAt: new Date(), nonce: null, nonceExpiresAt: null })
        .where(eq(sessions.address, ctx.session.address));
    }
    ctx.resHeaders.append("Set-Cookie", clearedSessionCookie());
    return { ok: true as const };
  }),
});
