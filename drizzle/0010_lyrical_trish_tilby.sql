CREATE TABLE "subscribe_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitter_ip_hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "subscribe_attempts_ip_created_idx" ON "subscribe_attempts" USING btree ("submitter_ip_hash","created_at");