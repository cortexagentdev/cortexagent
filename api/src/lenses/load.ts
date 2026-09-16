/**
 * BE-18: classification and lens definition files, plus boot validation.
 *
 * `spec/CortexBackend.md` PART 2, "Classification: `sector` and `factors`":
 * theme grouping comes from a hand-curated file in the repo, keyed by
 * `tokenAddress`, versioned in git. No classification API, so no recurring cost
 * in an otherwise-free C1 (locked decision 7). The universe is ~96 names and
 * changes a few at a time, so a file is the right shape.
 *
 * Two files:
 *
 * - `api/data/classification.json` — `{ [tokenAddress]: { symbol, sector,
 *   factors[] } }`. The address is the key because authenticity is an address
 *   match, never a symbol match (global do-not 3). `symbol` is carried for human
 *   readability and is what the lens file references.
 * - `api/data/lenses.json` — the lens catalog. Each lens has a URL-safe `slug`,
 *   a `name`, a `thesis`, a `color` (from `src/components/dash/data.ts`) and a
 *   `members` list of `{ symbol, weightPct }`. Weights are curated in this file
 *   and must sum to 100 per lens: equal-weight and liquidity-weight were the
 *   alternatives and were not chosen.
 *
 * ## Why this validates at boot
 *
 * Theme Lenses are the product's second surface and a wrong row silently
 * corrupts a whole lens. `assertLensDefinitionsValid()` runs at API startup and
 * throws with a message naming the problem, so a broken file fails the process
 * rather than shipping a lens built on a typo. It checks:
 *
 * - every `classification.json` key is a 20-byte address;
 * - every lens slug is unique and URL-safe;
 * - weights per lens sum to 100 within a small float tolerance;
 * - every lens member symbol resolves to a classified universe asset.
 *
 * ## The unclassified list is not silent
 *
 * Per PART 2, an unclassified name still appears in signals, is excluded from
 * lenses, and is listed so the gap is visible. `findUnclassifiedAssets()` reads
 * the live `universe` table and returns every row whose address has no
 * classification entry; `logUnclassifiedAssets()` writes that list to the boot
 * log and `GET /admin/unclassified` serves it on demand.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { universe } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../lib/logger.ts";

const log = logger.child({ module: "lenses/load" });

const CLASSIFICATION_PATH = fileURLToPath(
  new URL("../../data/classification.json", import.meta.url),
);
const LENSES_PATH = fileURLToPath(new URL("../../data/lenses.json", import.meta.url));

/** A 20-byte hex address. Same shape the rest of the api matches on. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Lowercase, digits and single interior hyphens. Safe as a path segment. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** #RRGGBB. The dashboard palette is all six-digit literal hex. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Curated weights are allowed to miss 100 by this much (rounding headroom). */
const WEIGHT_TOLERANCE = 0.01;

const classificationEntrySchema = z
  .object({
    symbol: z.string().trim().min(1),
    sector: z.string().trim().min(1),
    factors: z.array(z.string().trim().min(1)),
  })
  .strict();

const classificationSchema = z
  .record(z.string(), classificationEntrySchema)
  .superRefine((map, ctx) => {
    for (const key of Object.keys(map)) {
      if (!ADDRESS_RE.test(key)) {
        ctx.addIssue({
          code: "custom",
          message: `classification key "${key}" is not a 20-byte token address`,
          path: [key],
        });
      }
    }
  });

const lensMemberSchema = z
  .object({
    symbol: z.string().trim().min(1),
    weightPct: z.number().positive().max(100),
  })
  .strict();

const lensSchema = z
  .object({
    slug: z.string(),
    name: z.string().trim().min(1),
    thesis: z.string().trim().min(1),
    color: z.string().regex(HEX_COLOR_RE, "color must be #RRGGBB"),
    members: z.array(lensMemberSchema).min(1),
  })
  .strict();

export type ClassificationEntry = z.infer<typeof classificationEntrySchema>;
export type LensDefinition = z.infer<typeof lensSchema>;

export interface ClassifiedAsset extends ClassificationEntry {
  /** Lowercased token address, the classification key. */
  tokenAddress: string;
}

interface LoadedDefinitions {
  /** Keyed by lowercased token address. */
  byAddress: Map<string, ClassifiedAsset>;
  /** Keyed by uppercased symbol. */
  bySymbol: Map<string, ClassifiedAsset>;
  lenses: LensDefinition[];
}

let cache: LoadedDefinitions | null = null;

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
}

function formatZodError(file: string, error: z.ZodError): string {
  const detail = error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
  return `${file} failed validation: ${detail}`;
}

function buildDefinitions(): LoadedDefinitions {
  const classificationParsed = classificationSchema.safeParse(readJson(CLASSIFICATION_PATH));
  if (!classificationParsed.success) {
    throw new Error(formatZodError("data/classification.json", classificationParsed.error));
  }

  const byAddress = new Map<string, ClassifiedAsset>();
  const bySymbol = new Map<string, ClassifiedAsset>();
  for (const [address, entry] of Object.entries(classificationParsed.data)) {
    const asset: ClassifiedAsset = { ...entry, tokenAddress: address.toLowerCase() };
    byAddress.set(asset.tokenAddress, asset);

    const symbolKey = asset.symbol.toUpperCase();
    if (bySymbol.has(symbolKey)) {
      throw new Error(
        `data/classification.json failed validation: symbol "${asset.symbol}" is classified at two addresses`,
      );
    }
    bySymbol.set(symbolKey, asset);
  }

  const lensesParsed = z.array(lensSchema).min(1).safeParse(readJson(LENSES_PATH));
  if (!lensesParsed.success) {
    throw new Error(formatZodError("data/lenses.json", lensesParsed.error));
  }

  const seenSlugs = new Set<string>();
  for (const lens of lensesParsed.data) {
    if (!SLUG_RE.test(lens.slug)) {
      throw new Error(
        `data/lenses.json failed validation: slug "${lens.slug}" is not URL-safe (lowercase, digits, single hyphens)`,
      );
    }
    if (seenSlugs.has(lens.slug)) {
      throw new Error(
        `data/lenses.json failed validation: slug "${lens.slug}" is defined more than once`,
      );
    }
    seenSlugs.add(lens.slug);

    const seenMembers = new Set<string>();
    let total = 0;
    for (const member of lens.members) {
      const symbolKey = member.symbol.toUpperCase();
      if (seenMembers.has(symbolKey)) {
        throw new Error(
          `data/lenses.json failed validation: lens "${lens.slug}" lists "${member.symbol}" twice`,
        );
      }
      seenMembers.add(symbolKey);

      if (!bySymbol.has(symbolKey)) {
        throw new Error(
          `data/lenses.json failed validation: lens "${lens.slug}" member "${member.symbol}" does not resolve to a classified universe asset`,
        );
      }
      total += member.weightPct;
    }

    if (Math.abs(total - 100) > WEIGHT_TOLERANCE) {
      throw new Error(
        `data/lenses.json failed validation: lens "${lens.slug}" weights sum to ${total}, expected 100`,
      );
    }
  }

  return { byAddress, bySymbol, lenses: lensesParsed.data };
}

/** Parse and validate both files, memoizing on success. Throws on any defect. */
export function assertLensDefinitionsValid(): void {
  cache = buildDefinitions();
}

function definitions(): LoadedDefinitions {
  if (cache === null) cache = buildDefinitions();
  return cache;
}

/** Classification keyed by lowercased token address. */
export function loadClassification(): Map<string, ClassifiedAsset> {
  return definitions().byAddress;
}

/** Classification keyed by uppercased symbol. */
export function classificationBySymbol(): Map<string, ClassifiedAsset> {
  return definitions().bySymbol;
}

/** The validated lens catalog, in file order. */
export function loadLenses(): LensDefinition[] {
  return definitions().lenses;
}

export interface UnclassifiedAsset {
  symbol: string;
  tokenAddress: string;
}

/**
 * Universe rows with no classification entry. Read live from the `universe`
 * table so the list reflects whatever the refresher last discovered. An empty
 * or unreachable table is not an error here: it means "nothing to report yet".
 */
export async function findUnclassifiedAssets(db: Db): Promise<UnclassifiedAsset[]> {
  const classified = loadClassification();
  const rows = await db
    .select({ symbol: universe.symbol, tokenAddress: universe.tokenAddress })
    .from(universe);

  return rows
    .filter((row) => !classified.has(row.tokenAddress.toLowerCase()))
    .map((row) => ({ symbol: row.symbol, tokenAddress: row.tokenAddress }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Write the unclassified list to the boot log. Never throws. */
export async function logUnclassifiedAssets(db: Db): Promise<void> {
  try {
    const unclassified = await findUnclassifiedAssets(db);
    if (unclassified.length === 0) {
      log.info("every universe asset is classified");
      return;
    }
    log.warn("universe assets missing a classification entry, excluded from lenses", {
      count: unclassified.length,
      symbols: unclassified.map((asset) => asset.symbol),
    });
  } catch (err) {
    log.warn("could not compute the unclassified list at boot", { err });
  }
}
