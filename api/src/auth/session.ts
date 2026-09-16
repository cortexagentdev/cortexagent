import { eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { sessions } from "../db/schema.ts";
import { env } from "../env.ts";
import { verifySessionJwt } from "../lib/jwt.ts";

/**
 * The cookie side of BE-21: the name and attributes of the session cookie, and
 * the function that turns an incoming `Cookie` header back into a `Session`.
 *
 * `trpc.ts` calls `readSession` once per request to populate `ctx.session`.
 * `authRouter` calls `sessionCookie` / `clearedSessionCookie` to set and clear
 * the credential. Nothing writes the token anywhere a page script can read it:
 * it is httpOnly, so `document.cookie` never sees it (task acceptance criteria).
 */

/** A signed-in caller. Identity is a wallet address proven by a SIWE signature. */
export interface Session {
  address: `0x${string}`;
  /** Tier stays "open" until C4 (locked decision 10). */
  tier: "open";
  /** When the wallet last completed a SIWE verification. */
  siweVerifiedAt: Date;
  expiresAt: Date;
}

export const SESSION_COOKIE = "cortex_session";

/** JWT and session-row lifetime. Short-lived, and there is no refresh: a lapsed
 *  session is re-established with a fresh signature (PART 1). */
export const SESSION_TTL_SEC = 24 * 60 * 60;

/** Nonce lifetime. Long enough to sign a message, short enough to bound replay. */
export const NONCE_TTL_SEC = 5 * 60;

/**
 * `Secure` is set whenever the deployment origin is https, which is every real
 * deployment. It is dropped only on a plain-http localhost origin, where the
 * browser would otherwise discard the cookie during development (task: Secure
 * may be relaxed on localhost only).
 */
const COOKIE_SECURE = new URL(env.WEB_ORIGIN).protocol === "https:";

function serializeCookie(value: string, maxAgeSec: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

export function sessionCookie(token: string): string {
  return serializeCookie(token, SESSION_TTL_SEC);
}

export function clearedSessionCookie(): string {
  return serializeCookie("", 0);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eqAt = part.indexOf("=");
    if (eqAt === -1) continue;
    if (part.slice(0, eqAt).trim() === name) return part.slice(eqAt + 1).trim();
  }
  return null;
}

/**
 * Resolves the session for a request, or null when there is no valid one. Every
 * failure path returns null rather than throwing, so a public router stays
 * reachable with a missing, malformed or expired cookie (locked decision 1).
 */
export async function readSession(cookieHeader: string | null): Promise<Session | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;

  const claims = verifySessionJwt(token);
  if (!claims) return null;

  const [row] = await db.select().from(sessions).where(eq(sessions.address, claims.sub)).limit(1);

  if (!row || !row.issuedAt || !row.expiresAt) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (String(row.issuedAt.getTime()) !== claims.sid) return null;

  return {
    address: claims.sub as `0x${string}`,
    tier: "open",
    siweVerifiedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  };
}
