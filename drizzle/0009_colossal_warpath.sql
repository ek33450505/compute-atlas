CREATE TABLE "discovery_heartbeat" (
	"id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"states" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
