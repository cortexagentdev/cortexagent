CREATE TABLE "lens_metrics" (
	"theme" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"index_value" numeric(18, 6),
	"move_pct" numeric(18, 6),
	"net_flow_usd" numeric(38, 18),
	"signal_count24h" integer DEFAULT 0 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"green_member_count" integer DEFAULT 0 NOT NULL,
	"priced_member_count" integer DEFAULT 0 NOT NULL,
	"flow_member_count" integer DEFAULT 0 NOT NULL,
	"series" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lens_metrics_theme_ts_pk" PRIMARY KEY("theme","ts")
);
--> statement-breakpoint
CREATE INDEX "lens_metrics_theme_ts_idx" ON "lens_metrics" USING btree ("theme","ts" DESC NULLS LAST);--> statement-breakpoint
-- Timescale conversion, in the same migration that creates the table. Never in
-- a later one: create_hypertable on a table that already holds rows rewrites it.
-- The primary key includes ts because Timescale partitions on it and cannot
-- enforce a key that omits the partitioning column.
SELECT create_hypertable('lens_metrics', by_range('ts'), if_not_exists => TRUE);