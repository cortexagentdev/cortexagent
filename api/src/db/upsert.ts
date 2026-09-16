import { getTableColumns, sql, type Column, type SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import type { PgTable } from "drizzle-orm/pg-core";

import { DB_CASING } from "./client.ts";

/**
 * Resolves a column's real SQL name.
 *
 * A column declared without an explicit name keeps its TypeScript key in
 * `column.name`; the `casing` option converts it at query-build time, not at
 * declaration time. Reading `column.name` directly therefore yields
 * `onchainUid` where Postgres has `onchain_uid`, and the resulting statement
 * fails with `column excluded.onchainUid does not exist`.
 *
 * Drizzle's own cache does the conversion, so this uses that rather than a
 * second snake_case implementation that could disagree with the one that
 * generated the DDL.
 */
const casing = new CasingCache(DB_CASING);

/**
 * Builds the `SET` clause of an upsert from a list of columns.
 *
 * Drizzle has no "update every column" shorthand, and writing one out by hand
 * for a 44-column table is how a column quietly stops being written. Listing
 * the columns explicitly is also the point: a worker that owns part of a row
 * must be able to say which part, so a 60s refresh cycle cannot blank a column
 * another task owns.
 *
 * `excluded` is the Postgres alias for the row that failed to insert, so each
 * column takes the value the insert would have written.
 */
export function conflictUpdateSet<T extends PgTable>(
  table: T,
  columns: readonly (keyof T["$inferInsert"] & string)[],
): Record<string, SQL> {
  const tableColumns = getTableColumns(table) as Record<string, Column | undefined>;
  const set: Record<string, SQL> = {};

  for (const column of columns) {
    const definition = tableColumns[column];
    if (!definition) throw new Error(`conflictUpdateSet: unknown column "${column}"`);
    set[column] = sql.raw(`excluded."${casing.getColumnCasing(definition)}"`);
  }

  return set;
}
