CREATE TABLE "alert_fires" (
	"id" text NOT NULL,
	"alert_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone,
	CONSTRAINT "alert_fires_id_ts_pk" PRIMARY KEY("id","ts"),
	CONSTRAINT "alert_fires_alert_id_signal_id_key" UNIQUE("alert_id","signal_id","ts")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ticker" text NOT NULL,
	"threshold" double precision NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_fires_alert_id_ts_idx" ON "alert_fires" USING btree ("alert_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alert_fires_seen_at_idx" ON "alert_fires" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "alerts_user_id_idx" ON "alerts" USING btree ("user_id");--> statement-breakpoint
-- Timescale conversion, in the same migration that creates the table. Never in a
-- later one: create_hypertable on a table that already holds rows rewrites it.
-- The unique key and the primary key both include ts because Timescale
-- partitions on it and cannot enforce a key that omits the partitioning column;
-- signal_id already determines ts, so the key stays unique on (alert_id, signal_id).
SELECT create_hypertable('alert_fires', by_range('ts'), if_not_exists => TRUE);