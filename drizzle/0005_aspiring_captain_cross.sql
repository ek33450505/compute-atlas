CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text NOT NULL,
	"note" text,
	"attribution" text,
	"submitter_ip_hash" text,
	"status" text DEFAULT 'new' NOT NULL,
	"triage" jsonb,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"promoted_submission_id" uuid
);
--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_created_at_idx" ON "leads" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_submitter_ip_hash_idx" ON "leads" USING btree ("submitter_ip_hash");