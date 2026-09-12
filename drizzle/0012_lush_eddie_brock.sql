CREATE TABLE "submission_notify_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "submission_notify_sends_hash_created_idx" ON "submission_notify_sends" USING btree ("email_hash","created_at");