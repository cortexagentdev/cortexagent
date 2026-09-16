CREATE TABLE "flows" (
	"token_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"user" text NOT NULL,
	"usd" numeric(38, 18),
	"shares" numeric(38, 18) NOT NULL,
	"nav_per_share" numeric(38, 18),
	"tx_hash" text NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "flows_tx_hash_log_index_ts_pk" PRIMARY KEY("tx_hash","log_index","ts")
);
--> statement-breakpoint
CREATE TABLE "nav_history" (
	"token_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"nav_per_share" numeric(38, 18),
	"aum_usd" numeric(38, 18),
	"indicative" boolean DEFAULT false NOT NULL,
	CONSTRAINT "nav_history_token_id_ts_pk" PRIMARY KEY("token_id","ts")
);
--> statement-breakpoint
CREATE TABLE "rebalances" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"keeper" text NOT NULL,
	"drift_before_pct" double precision NOT NULL,
	"drift_after_pct" double precision NOT NULL,
	"gas_reimbursed_wei" numeric(78, 0) NOT NULL,
	"gas_reimbursed_usd" numeric(38, 18),
	"block_number" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "theme_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"theme" text NOT NULL,
	"token" text NOT NULL,
	"vault" text NOT NULL,
	"spec" jsonb NOT NULL,
	"aum_usd" numeric(38, 18),
	"creator_fee_bps" integer NOT NULL,
	"status" text NOT NULL,
	"chain_id" integer NOT NULL,
	"deploy_tx" text NOT NULL,
	"deployed_at" timestamp with time zone NOT NULL,
	"deploy_block" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "flows_token_ts_idx" ON "flows" USING btree ("token_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nav_history_token_ts_idx" ON "nav_history" USING btree ("token_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rebalances_token_ts_idx" ON "rebalances" USING btree ("token_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "theme_tokens_vault_idx" ON "theme_tokens" USING btree ("vault");--> statement-breakpoint
CREATE INDEX "theme_tokens_status_idx" ON "theme_tokens" USING btree ("status");--> statement-breakpoint
-- Timescale conversion, in the same migration that creates the tables. Never in
-- a later one: create_hypertable on a table that already holds rows rewrites it.
-- The primary key includes ts because Timescale partitions on it and cannot
-- enforce a key that omits the partitioning column. nav_history keys on
-- (token_id, ts); flows keys on (tx_hash, log_index, ts), which the block
-- already determines, so it stays unique on (tx_hash, log_index) in practice.
SELECT create_hypertable('nav_history', by_range('ts'), if_not_exists => TRUE);--> statement-breakpoint
SELECT create_hypertable('flows', by_range('ts'), if_not_exists => TRUE);