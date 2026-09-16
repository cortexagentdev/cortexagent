-- Durable execution-scoped cursors, canonical event identity, and reorg-safe
-- projections. Existing rows are adopted into the singleton execution binding
-- so this migration is safe for the stage-12 local database.
CREATE TABLE "execution_events" (
	"deployment_id" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"address" text NOT NULL,
	"event_name" text NOT NULL,
	"scope" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"canonical_reason" text,
	"payload" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_events_deployment_id_transaction_hash_log_index_pk" PRIMARY KEY("deployment_id","transaction_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "execution_indexer_checkpoints" (
	"deployment_id" text NOT NULL,
	"scope" text NOT NULL,
	"factory_address" text NOT NULL,
	"factory_version" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_indexer_checkpoints_deployment_id_scope_factory_address_factory_version_block_number_pk" PRIMARY KEY("deployment_id","scope","factory_address","factory_version","block_number")
);
--> statement-breakpoint
CREATE TABLE "execution_indexer_state" (
	"deployment_id" text NOT NULL,
	"scope" text NOT NULL,
	"factory_address" text NOT NULL,
	"factory_version" text NOT NULL,
	"start_block" bigint NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" text,
	"status" text DEFAULT 'healthy' NOT NULL,
	"degraded_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_indexer_state_deployment_id_scope_factory_address_factory_version_pk" PRIMARY KEY("deployment_id","scope","factory_address","factory_version")
);
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "failed_legs" integer;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "failed_leg_tokens" jsonb;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "nav_reason" text;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "block_hash" text;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "execution_deployment_id" text;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "nav_granularity" text DEFAULT 'block_end' NOT NULL;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "canonical" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "canonical_reason" text;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "execution_deployment_id" text;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "block_number" bigint;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "block_hash" text;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "valuation_status" text DEFAULT 'unavailable' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "valuation_reason" text;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "nav_granularity" text DEFAULT 'block_end' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "canonical" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "nav_history" ADD COLUMN "canonical_reason" text;
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "block_hash" text;
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "log_index" integer;
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "execution_deployment_id" text;
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "reimbursement_skipped_wei" numeric(78, 0);
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "reimbursement_skip_reason" integer;
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "canonical" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "rebalances" ADD COLUMN "canonical_reason" text;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "execution_deployment_id" text;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "deploy_block_hash" text;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "deploy_log_index" integer;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "factory_address" text;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "factory_version" text;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "canonical" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "canonical_reason" text;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "execution_compatibility" text DEFAULT 'unverified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ADD COLUMN "execution_compatibility_reason" text;
--> statement-breakpoint
UPDATE "theme_tokens"
SET "execution_deployment_id" = COALESCE((SELECT "deployment_id" FROM "execution_bindings" WHERE "id" = 1), 'legacy-unbound')
WHERE "execution_deployment_id" IS NULL;
--> statement-breakpoint
UPDATE "flows"
SET "execution_deployment_id" = COALESCE((SELECT "deployment_id" FROM "execution_bindings" WHERE "id" = 1), 'legacy-unbound')
WHERE "execution_deployment_id" IS NULL;
--> statement-breakpoint
UPDATE "nav_history"
SET "execution_deployment_id" = COALESCE((SELECT "deployment_id" FROM "execution_bindings" WHERE "id" = 1), 'legacy-unbound')
WHERE "execution_deployment_id" IS NULL;
--> statement-breakpoint
UPDATE "rebalances"
SET "execution_deployment_id" = COALESCE((SELECT "deployment_id" FROM "execution_bindings" WHERE "id" = 1), 'legacy-unbound')
WHERE "execution_deployment_id" IS NULL;
--> statement-breakpoint
UPDATE "theme_proposals"
SET "execution_deployment_id" = COALESCE((SELECT "deployment_id" FROM "execution_bindings" WHERE "id" = 1), 'legacy-unbound')
WHERE "execution_deployment_id" IS NULL;
--> statement-breakpoint
UPDATE "rebalances"
SET "log_index" = substring("id" FROM ':(\\d+)$')::integer
WHERE "log_index" IS NULL AND "id" ~ ':(\\d+)$';
--> statement-breakpoint
ALTER TABLE "flows" ALTER COLUMN "execution_deployment_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "nav_history" ALTER COLUMN "execution_deployment_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "rebalances" ALTER COLUMN "execution_deployment_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "theme_tokens" ALTER COLUMN "execution_deployment_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "flows" DROP CONSTRAINT "flows_tx_hash_log_index_ts_pk";
--> statement-breakpoint
ALTER TABLE "nav_history" DROP CONSTRAINT "nav_history_token_id_ts_pk";
--> statement-breakpoint
ALTER TABLE "rebalances" DROP CONSTRAINT "rebalances_pkey";
--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_execution_deployment_id_tx_hash_log_index_ts_pk" PRIMARY KEY("execution_deployment_id","tx_hash","log_index","ts");
--> statement-breakpoint
ALTER TABLE "nav_history" ADD CONSTRAINT "nav_history_execution_deployment_id_token_id_ts_pk" PRIMARY KEY("execution_deployment_id","token_id","ts");
--> statement-breakpoint
ALTER TABLE "rebalances" ADD CONSTRAINT "rebalances_execution_deployment_id_id_pk" PRIMARY KEY("execution_deployment_id","id");
--> statement-breakpoint
CREATE INDEX "execution_events_canonical_block_idx" ON "execution_events" USING btree ("deployment_id","canonical","block_number");
--> statement-breakpoint
CREATE INDEX "execution_indexer_checkpoints_lookup_idx" ON "execution_indexer_checkpoints" USING btree ("deployment_id","scope","block_number");
--> statement-breakpoint
CREATE INDEX "execution_indexer_state_deployment_idx" ON "execution_indexer_state" USING btree ("deployment_id","scope");
