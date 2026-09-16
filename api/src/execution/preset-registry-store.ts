import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Db } from "../db/client.ts";
import { themeTokens } from "../db/schema.ts";
import { conflictUpdateSet } from "../db/upsert.ts";
import { env } from "../env.ts";
import type { ExecutionContext } from "./context.ts";
import { registeredPresetReceipts } from "./preset-receipts.ts";

export async function loadVerifiedPresetReceipts(context: ExecutionContext, database: Db = db) {
  try {
    return await registeredPresetReceipts(context, env.VAULT_INDEXER_CONFIRMATIONS);
  } catch (error) {
    // Bootstrap rows can exist ahead of the indexer's cursor. Do not rely only
    // on cursor-based reorg detection to withdraw an orphaned official listing.
    const entries = context.manifest.presets?.entries ?? [];
    if (entries.length)
      await database
        .update(themeTokens)
        .set({
          canonical: false,
          canonicalReason: "preset-receipt-verification-failed",
        })
        .where(
          and(
            eq(themeTokens.executionDeploymentId, context.manifest.deploymentId),
            inArray(
              themeTokens.id,
              entries.map((entry) => entry.token.toLowerCase()),
            ),
          ),
        );
    throw error;
  }
}

/** Rebuild all official DB records atomically from exact, verified receipts.
 * No chain writer or private key; safe on startup, restart and canonical replay.
 * NAV/status ownership stays with its existing worker/operator. */
export async function syncPresetRecords(
  context: ExecutionContext,
  database: Db = db,
  verified?: Awaited<ReturnType<typeof registeredPresetReceipts>>,
): Promise<number> {
  const receipts = verified ?? (await loadVerifiedPresetReceipts(context, database));
  if (!receipts.length) return 0;
  const rows = receipts.map((receipt) => receipt.row);
  await database.transaction(async (tx) => {
    // API, worker and bootstrap may all start together. Serialize registration
    // checks and writes instead of relying on a racy check-then-upsert.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cortex-preset-registration'))`);
    const existing = await tx
      .select()
      .from(themeTokens)
      .where(
        inArray(
          themeTokens.id,
          rows.map((row) => row.id),
        ),
      );
    for (const prior of existing) {
      const row = rows.find((candidate) => candidate.id === prior.id)!;
      if (
        prior.executionDeploymentId !== row.executionDeploymentId ||
        prior.vault !== row.vault ||
        prior.factoryAddress !== row.factoryAddress ||
        prior.spec.policyHash !== row.spec.policyHash
      )
        throw new Error(`Refusing to overwrite a different deployment at ${prior.id}`);
    }
    const saved = await tx
      .insert(themeTokens)
      .values(rows)
      .onConflictDoUpdate({
        target: themeTokens.id,
        set: {
          ...conflictUpdateSet(themeTokens, [
            "creator",
            "theme",
            "token",
            "vault",
            "spec",
            "creatorFeeBps",
            "chainId",
            "deployTx",
            "deployedAt",
            "deployBlock",
            "executionDeploymentId",
            "deployBlockHash",
            "deployLogIndex",
            "factoryAddress",
            "factoryVersion",
            "executionCompatibility",
            "executionCompatibilityReason",
          ]),
          canonical: true,
          canonicalReason: null,
        },
        // Cross-generation concurrent registration must never overwrite history.
        setWhere: eq(themeTokens.executionDeploymentId, context.manifest.deploymentId),
      })
      .returning({ id: themeTokens.id });
    if (saved.length !== rows.length)
      throw new Error("Incomplete preset DB registration; rolling back catalog");
  });
  return rows.length;
}
