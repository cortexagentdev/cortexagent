CREATE TABLE "price_history" (
	"token_address" text NOT NULL,
	"ticker" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"after_hours" boolean,
	"stale" boolean DEFAULT false NOT NULL,
	"is_trading_halt" boolean DEFAULT false NOT NULL,
	CONSTRAINT "price_history_token_address_ts_pk" PRIMARY KEY("token_address","ts")
);
--> statement-breakpoint
CREATE INDEX "price_history_ticker_ts_idx" ON "price_history" USING btree ("ticker","ts" DESC NULLS LAST);--> statement-breakpoint
-- Timescale conversion, in the same migration that creates the table. Never in
-- a later one: create_hypertable on a table that already holds rows rewrites it.
-- The primary key includes ts because Timescale partitions on it and cannot
-- enforce a key that omits the partitioning column.
SELECT create_hypertable('price_history', by_range('ts'), if_not_exists => TRUE);
