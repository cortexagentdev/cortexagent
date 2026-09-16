CREATE TABLE "sessions" (
	"address" text PRIMARY KEY NOT NULL,
	"nonce" text,
	"nonce_expires_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
