CREATE TABLE "watchlists" (
	"user_id" text PRIMARY KEY NOT NULL,
	"tickers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"themes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
