CREATE TABLE "signals" (
	"id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"ticker" text NOT NULL,
	"token_address" text NOT NULL,
	"kind" text NOT NULL,
	"magnitude" double precision NOT NULL,
	"z_score" double precision NOT NULL,
	"rank" double precision NOT NULL,
	"confidence" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"window" text NOT NULL,
	"after_hours" boolean NOT NULL,
	"superseded_by" text,
	CONSTRAINT "signals_id_ts_pk" PRIMARY KEY("id","ts")
);
--> statement-breakpoint
CREATE INDEX "signals_kind_ts_idx" ON "signals" USING btree ("kind","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "signals_ticker_ts_idx" ON "signals" USING btree ("ticker","ts" DESC NULLS LAST);--> statement-breakpoint
-- Timescale conversion, in the same migration that creates the table. Never in
-- a later one: create_hypertable on a table that already holds rows rewrites it.
-- The primary key includes ts because Timescale partitions on it and cannot
-- enforce a key that omits the partitioning column.
SELECT create_hypertable('signals', by_range('ts'), if_not_exists => TRUE);