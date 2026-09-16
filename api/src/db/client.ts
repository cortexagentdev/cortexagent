import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

// Sized for a single VPS (locked decision 12), not a cloud fleet. Both the api
// and the worker open a pool of this size, so the ceiling is 2x max against a
// Postgres that defaults to 100 connections.
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
});

// `casing` must match the `casing` in drizzle.config.ts, or generated DDL and
// runtime queries disagree about column names. Exported because raw SQL that
// names a column (see db/upsert.ts) has to resolve it the same way drizzle does.
export const DB_CASING = "snake_case" as const;

export const db = drizzle(sql, { schema, casing: DB_CASING });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
