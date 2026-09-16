/**
 * The gate every signal passes before it is persisted (BE-10 scope section 4).
 *
 * Design Law 5 and PART 7 acceptance criterion 2: a signal must carry
 * `explanation`, `sources`, `evidence`, `window`, `confidence` and `ts`. A
 * processor that cannot populate all of them must not emit the signal. This
 * schema is where "must not" is enforced rather than trusted: the computer runs
 * every candidate through `validateSignal` and drops, with a log line, anything
 * that fails.
 *
 * A signal without sources is worse than no signal, because the UI presents it
 * as evidence. That is why `sources` is `.min(1)` and not merely an array.
 */

import { z } from "zod";

import type { Signal } from "@shared/contracts.ts";

const TOKEN_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
/** ISO-8601 duration, the subset the processors emit: PT<n>H, PT<n>M, P<n>D. */
const ISO_DURATION = /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

const evidenceSchema = z
  .object({
    fromBlock: z.number().int().nonnegative(),
    toBlock: z.number().int().nonnegative(),
    observed: z.number().finite(),
    baseline: z.number().finite(),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();

export const signalSchema = z
  .object({
    id: z.string().min(1),
    ts: z.iso.datetime({ offset: true }),
    ticker: z.string().min(1),
    tokenAddress: z.string().regex(TOKEN_ADDRESS),
    kind: z.enum([
      "FLOW",
      "LIQUIDITY_SHIFT",
      "HOLDER_CONCENTRATION",
      "PEG_DRIFT",
      "AFTER_HOURS_DISLOCATION",
      "CORPORATE_ACTION",
    ]),
    magnitude: z.number().finite(),
    zScore: z.number().finite(),
    rank: z.number().finite(),
    confidence: z.enum(["HIGH", "MED", "LOW"]),
    // Mandatory and non-empty. A blank explanation renders as an empty evidence
    // card.
    explanation: z.string().trim().min(1),
    evidence: evidenceSchema,
    // The load-bearing constraint: never empty.
    sources: z.array(z.string().trim().min(1)).min(1),
    window: z.string().regex(ISO_DURATION),
    afterHours: z.boolean(),
    supersededBy: z.string().min(1).nullable(),
  })
  .strict();

export type ValidationResult = { ok: true; signal: Signal } | { ok: false; errors: string[] };

/**
 * Validates one normalised signal. `ok: false` carries a flat list of
 * `path: message` strings for the log line; the caller drops the signal.
 */
export function validateSignal(input: unknown): ValidationResult {
  const parsed = signalSchema.safeParse(input);
  if (parsed.success) return { ok: true, signal: parsed.data as Signal };

  return {
    ok: false,
    errors: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}
