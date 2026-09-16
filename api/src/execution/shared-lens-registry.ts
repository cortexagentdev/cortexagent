import { and, eq, inArray } from "drizzle-orm";
import { themeTokens, type ThemeTokenRecord } from "../db/schema.ts";
import type { Context } from "../trpc.ts";
import {
  getExecutionContext,
  getExecutionMetadata,
  isExecutionMetadataCurrent,
} from "./context.ts";
import { matchesRegisteredPreset } from "./preset-manifest.ts";

/** Official identity comes ONLY from the operator's complete fixed registry.
 * No earliest/newest/same-slug query, and no browser proposal can endorse it. */
export async function officialVaults(ctx: Pick<Context, "db">): Promise<ThemeTokenRecord[]> {
  const execution = await getExecutionContext();
  const registry = execution?.manifest.presets;
  if (!execution || !registry?.entries.length) return [];
  const rows = await ctx.db
    .select()
    .from(themeTokens)
    .where(
      and(
        eq(themeTokens.executionDeploymentId, execution.manifest.deploymentId),
        inArray(
          themeTokens.id,
          registry.entries.map((entry) => entry.token.toLowerCase()),
        ),
      ),
    );
  return registry.entries.flatMap((entry) => {
    const row = rows.find((candidate) =>
      matchesRegisteredPreset(
        candidate,
        entry,
        registry,
        execution.manifest.chainId,
        execution.manifest.deploymentId,
      ),
    );
    return row ? [row] : [];
  });
}

/**
 * Public catalog metadata does not need a live RPC identity check. It still
 * requires a structurally valid, current manifest and matches every indexed
 * row against that manifest's fixed registry. Keep this path separate from
 * `officialVaults`: the latter is used by deposit authorization and remains
 * fully execution-verified.
 */
export async function officialVaultsMetadata(
  ctx: Pick<Context, "db">,
): Promise<ThemeTokenRecord[]> {
  const metadata = getExecutionMetadata();
  const registry = metadata?.manifest.presets;
  if (!metadata || !registry?.entries.length) return [];

  const rows = await ctx.db
    .select()
    .from(themeTokens)
    .where(
      and(
        eq(themeTokens.executionDeploymentId, metadata.manifest.deploymentId),
        inArray(
          themeTokens.id,
          registry.entries.map((entry) => entry.token.toLowerCase()),
        ),
      ),
    );

  // A manifest replacement at the same path can happen while the DB query is
  // waiting. Do not publish rows selected under the old deployment identity.
  if (!isExecutionMetadataCurrent(metadata)) return [];
  return registry.entries.flatMap((entry) => {
    const row = rows.find((candidate) =>
      matchesRegisteredPreset(
        candidate,
        entry,
        registry,
        metadata.manifest.chainId,
        metadata.manifest.deploymentId,
      ),
    );
    return row ? [row] : [];
  });
}

export async function deployedTokenIdFor(
  ctx: Pick<Context, "db">,
  slug: string,
): Promise<string | null> {
  return (await officialVaultsMetadata(ctx)).find((row) => row.theme === slug)?.id ?? null;
}

/** Only minting is gated by official registration. Recovery of existing shares
 * and deferred claims remains possible for retired/legacy vaults. */
export async function isOfficialDepositVault(ctx: Pick<Context, "db">, tokenId: string) {
  return (await officialVaults(ctx)).some((row) => row.id === tokenId.toLowerCase());
}
