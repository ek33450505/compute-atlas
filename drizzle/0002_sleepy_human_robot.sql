CREATE TABLE "facility_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_type" text NOT NULL,
	"diff" jsonb NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "facility_history_facility_id_changed_at_idx" ON "facility_history" USING btree ("facility_id","changed_at" DESC NULLS LAST);