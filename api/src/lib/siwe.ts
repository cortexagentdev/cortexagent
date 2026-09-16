import { getAddress, isAddress } from "viem";

import { env } from "../env.ts";

/**
 * EIP-4361 (Sign-In with Ethereum) message construction, parsing and field
 * validation for BE-21.
 *
 * Cortex controls both ends of this exchange: `buildSiweMessage` here is the
 * exact string the web app (W-6) presents to the wallet, and `parseSiweMessage`
 * plus `checkSiweFields` are what `authRouter.verify` reads back. Keeping both in
 * one file is deliberate. A signature is authentication only if the fields
 * inside the signed message are the ones Cortex issued, so verify checks the
 * domain, the chain id and the expiry, not just the ECDSA recovery. A valid
 * signature over an attacker-chosen message is not a sign-in.
 */

export const SIWE_STATEMENT =
  "Sign in to Cortex. this signature proves you control this wallet and authorizes no transactions.";

/** Forward clock skew tolerated on the message's Issued At, in milliseconds. */
const ISSUED_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * Host (with port, if any) the message must name. Derived from `WEB_ORIGIN` so a
 * signature captured for another site cannot be replayed against this API.
 */
export function expectedDomain(): string {
  return new URL(env.WEB_ORIGIN).host;
}

/**
 * The chain id the message must carry. Terminal data reads target RHC mainnet
 * (locked decision 6) and the sign-in is bound to the same id. It is context in
 * an off-chain `personal_sign`, so W-6 sets it to this value regardless of the
 * chain the wallet happens to be on.
 */
export function expectedChainId(): number {
  return env.RHC_CHAIN_ID;
}

export interface SiweFields {
  domain: string;
  address: `0x${string}`;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string | null;
}

export interface BuildSiweParams {
  address: `0x${string}`;
  nonce: string;
  /** Absolute URI of the page requesting the sign-in. */
  uri: string;
  expiresAt: Date;
  issuedAt?: Date;
  chainId?: number;
  domain?: string;
}

export function buildSiweMessage(params: BuildSiweParams): string {
  const domain = params.domain ?? expectedDomain();
  const chainId = params.chainId ?? expectedChainId();
  const issuedAt = (params.issuedAt ?? new Date()).toISOString();

  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    getAddress(params.address),
    "",
    SIWE_STATEMENT,
    "",
    `URI: ${params.uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${params.expiresAt.toISOString()}`,
  ].join("\n");
}

function scalarField(message: string, label: string): string | null {
  const match = message.match(new RegExp(`^${label}: (.+)$`, "m"));
  return match ? match[1]!.trim() : null;
}

export function parseSiweMessage(message: string): SiweFields | null {
  const lines = message.split("\n");
  if (lines.length < 2) return null;

  const header = lines[0]!.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!header) return null;
  const domain = header[1]!.trim();

  const address = lines[1]!.trim();
  if (!isAddress(address)) return null;

  const uri = scalarField(message, "URI");
  const version = scalarField(message, "Version");
  const chainIdRaw = scalarField(message, "Chain ID");
  const nonce = scalarField(message, "Nonce");
  const issuedAt = scalarField(message, "Issued At");
  const expirationTime = scalarField(message, "Expiration Time");

  if (!uri || !version || !chainIdRaw || !nonce || !issuedAt) return null;

  const chainId = Number.parseInt(chainIdRaw, 10);
  if (!Number.isInteger(chainId)) return null;

  return {
    domain,
    address: getAddress(address),
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime: expirationTime ?? null,
  };
}

/**
 * Validates every field the signature does not cover on its own. Returns a short
 * reason string on the first failure, or null when the fields are acceptable.
 * The nonce is checked against the database by the caller, not here.
 */
export function checkSiweFields(fields: SiweFields, now: Date): string | null {
  if (fields.domain !== expectedDomain()) return "domain does not match";
  if (fields.version !== "1") return "unsupported SIWE version";
  if (fields.chainId !== expectedChainId()) return "unexpected chain id";

  let uriHost: string;
  try {
    uriHost = new URL(fields.uri).host;
  } catch {
    return "malformed URI";
  }
  if (uriHost !== expectedDomain()) return "URI host does not match the domain";

  if (!fields.expirationTime) return "missing expiration time";
  const expiry = new Date(fields.expirationTime);
  if (Number.isNaN(expiry.getTime())) return "malformed expiration time";
  if (expiry.getTime() <= now.getTime()) return "message has expired";

  const issued = new Date(fields.issuedAt);
  if (Number.isNaN(issued.getTime())) return "malformed issued-at time";
  if (issued.getTime() > now.getTime() + ISSUED_AT_SKEW_MS) return "issued-at is in the future";

  return null;
}
