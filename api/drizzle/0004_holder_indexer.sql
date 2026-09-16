CREATE TABLE "holder_balances" (
	"token_address" text NOT NULL,
	"address" text NOT NULL,
	"balance" numeric(78, 0) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "holder_balances_token_address_address_pk" PRIMARY KEY("token_address","address")
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"indexer" text PRIMARY KEY NOT NULL,
	"start_block" bigint NOT NULL,
	"last_block" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "holder_balances_token_balance_idx" ON "holder_balances" USING btree ("token_address","balance" DESC NULLS LAST);