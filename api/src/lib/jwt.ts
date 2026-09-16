import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../env.ts";

/**
 * Minimal HS256 JSON Web Token, sign and verify only (BE-21).
 *
 * The session token is a short-lived bearer credential carried in an httpOnly
 * cookie. It needs exactly one algorithm and one claim set, so it is a keyed
 * HMAC over two base64url segments rather than a JWT library and its algorithm
 * negotiation. `alg` is pinned to HS256 and a token naming any other algorithm
 * is rejected, which closes the "alg: none" and RS/HS confusion classes by
 * construction.
 */

export interface SessionClaims {
  /** Lowercased wallet address. */
  sub: string;
  /**
   * The `sessions.issuedAt` epoch millis of the row this token belongs to. A
   * token from a superseded sign-in no longer matches its row and is rejected.
   */
  sid: string;
  /** Seconds since the epoch. */
  iat: number;
  /** Seconds since the epoch. */
  exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

const HEADER_SEGMENT = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function sign(signingInput: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(signingInput).digest("base64url");
}

export function signSessionJwt(claims: Omit<SessionClaims, "iat"> & { iat?: number }): string {
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const payloadSegment = base64url(JSON.stringify({ ...claims, iat }));
  const signingInput = `${HEADER_SEGMENT}.${payloadSegment}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/** Returns the claims when the signature and expiry check out, null otherwise. */
export function verifySessionJwt(token: string): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER_SEGMENT) return null;

  const provided = Buffer.from(signature);
  const expected = Buffer.from(sign(`${header}.${payload}`));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }

  if (
    typeof claims.sub !== "string" ||
    typeof claims.sid !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;

  return claims;
}
