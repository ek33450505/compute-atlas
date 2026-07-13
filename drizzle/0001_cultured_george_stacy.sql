CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"kind" text NOT NULL,
	"target_facility_id" text,
	"payload" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "submissions_status_idx" ON "submissions" USING btree ("status");