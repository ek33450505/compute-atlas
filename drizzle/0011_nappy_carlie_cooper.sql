CREATE TABLE "submission_notify_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"email" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "submission_notify_submission_idx" ON "submission_notify_requests" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submission_notify_email_created_idx" ON "submission_notify_requests" USING btree ("email","created_at");