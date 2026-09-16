-- BE-29. Pre-deploy theme proposals.
--
-- theme_tokens.status is typed draft | proposed | deployed | deprecated in
-- CortexBackend.md PART 5, but theme_tokens.id is the theme token address and
-- that address does not exist until the deploy transaction lands, so a draft has
-- no primary key under that schema. Three of the four states were therefore
-- unreachable: the BE-26 indexer is the only writer of theme_tokens and it only
-- ever learns that a theme is deployed.
--
-- This is the recommended separate table, keyed by a generated id, carrying the
-- frozen basket and policy plus its basketHash. It leaves theme_tokens entirely
-- to the indexer, which stays its sole owner, and links to it by deploy_tx once
-- a proposal is broadcast. Not a hypertable: proposals are a small mutable set
-- read by creator, not a time series.
CREATE TABLE "theme_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"theme" text NOT NULL,
	"status" text NOT NULL,
	"basket_hash" text NOT NULL,
	"basket" jsonb NOT NULL,
	"chain_id" integer NOT NULL,
	"deploy_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "theme_proposals_creator_idx" ON "theme_proposals" USING btree ("creator","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "theme_proposals_deploy_tx_idx" ON "theme_proposals" USING btree ("deploy_tx");