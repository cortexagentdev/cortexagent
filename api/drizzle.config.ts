import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app, so it must not import src/env.ts: that would
// demand JWT_SECRET and the RPC urls just to generate a migration file.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is required by drizzle-kit. Copy api/.env.example to api/.env first.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  // Column names are derived from the field name as snake_case. This must stay in
  // step with the `casing` option passed to drizzle() in src/db/client.ts, or the
  // generated DDL and the runtime queries disagree about column names.
  casing: "snake_case",
  strict: true,
  verbose: true,
});
