import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * One-shot migration runner. `bun run db:migrate`, and the `migrate` service in
 * the production stack (OPS-4).
 *
 * Not `drizzle-kit migrate`: that swallows the Postgres error and exits 1 with an
 * empty spinner, which is worthless in a container log. It is also a devDependency,
 * and the production image installs production dependencies only.
 *
 * Env is read directly rather than through src/env.ts. A migration job has no
 * business demanding JWT_SECRET and the RPC urls to run DDL.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required to run migrations\n");
  process.exit(1);
}

// max: 1 because migrations run in order on one connection, and the advisory
// lock drizzle takes has to be held by the session doing the work.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await migrate(drizzle(sql), {
    migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
  });
  process.stdout.write("migrations applied\n");
} catch (err) {
  process.stderr.write(
    `migration failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  await sql.end({ timeout: 5 });
  process.exit(1);
}

await sql.end({ timeout: 5 });
