CREATE TABLE "execution_bindings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"deployment_id" text NOT NULL,
	"mode" text NOT NULL,
	"chain_id" integer NOT NULL,
	"manifest_digest" text NOT NULL,
	"generation_fingerprint" text NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_bindings_deploymentId_unique" UNIQUE("deployment_id"),
	CONSTRAINT "execution_binding_singleton" CHECK ("execution_bindings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "execution_discovery_progress" (
	"deployment_id" text NOT NULL,
	"venue_name" text NOT NULL,
	"query_scope" text NOT NULL,
	"coverage_status" text NOT NULL,
	"reconciliation_position" text,
	"last_successful_block" bigint,
	"last_successful_block_hash" text,
	"last_successful_at" timestamp with time zone,
	CONSTRAINT "execution_discovery_progress_deployment_id_venue_name_query_scope_pk" PRIMARY KEY("deployment_id","venue_name","query_scope")
);
--> statement-breakpoint
CREATE TABLE "execution_pool_observations" (
	"deployment_id" text NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_timestamp" bigint NOT NULL,
	"status" text NOT NULL,
	"reserve0_raw" numeric(78, 0),
	"reserve1_raw" numeric(78, 0),
	"sqrt_price_x_96" numeric(78, 0),
	"tick" integer,
	"liquidity_raw" numeric(78, 0),
	"tvl_usd" numeric(38, 18),
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_pool_observations_deployment_id_pool_address_pk" PRIMARY KEY("deployment_id","pool_address")
);
--> statement-breakpoint
CREATE TABLE "execution_pools" (
	"deployment_id" text NOT NULL,
	"pool_address" text NOT NULL,
	"venue_name" text NOT NULL,
	"factory" text NOT NULL,
	"token0" text NOT NULL,
	"token1" text NOT NULL,
	"fee_pips" integer NOT NULL,
	"created_block" bigint,
	"created_block_hash" text,
	"first_seen_block" bigint NOT NULL,
	"first_seen_block_hash" text NOT NULL,
	"provenance" text NOT NULL,
	"authenticated" boolean DEFAULT false NOT NULL,
	"authenticated_at" timestamp with time zone,
	CONSTRAINT "execution_pools_deployment_id_pool_address_pk" PRIMARY KEY("deployment_id","pool_address")
);
--> statement-breakpoint
CREATE TABLE "execution_venues" (
	"deployment_id" text NOT NULL,
	"name" text NOT NULL,
	"seed_version" integer NOT NULL,
	"seed_digest" text NOT NULL,
	"protocol_variant" text NOT NULL,
	"factory" text NOT NULL,
	"router" text NOT NULL,
	"quoter" text,
	"deploy_block" bigint NOT NULL,
	"deploy_block_hash" text NOT NULL,
	"supported_fees" jsonb NOT NULL,
	"supported_intermediates" jsonb NOT NULL,
	"verification_status" text NOT NULL,
	"verified_source" text NOT NULL,
	CONSTRAINT "execution_venues_deployment_id_name_pk" PRIMARY KEY("deployment_id","name")
);
--> statement-breakpoint
CREATE INDEX "execution_pool_observations_status_idx" ON "execution_pool_observations" USING btree ("deployment_id","status");--> statement-breakpoint
CREATE INDEX "execution_pools_deployment_authenticated_idx" ON "execution_pools" USING btree ("deployment_id","authenticated");--> statement-breakpoint
CREATE INDEX "execution_pools_venue_idx" ON "execution_pools" USING btree ("deployment_id","venue_name");--> statement-breakpoint
CREATE INDEX "execution_venues_deployment_idx" ON "execution_venues" USING btree ("deployment_id");