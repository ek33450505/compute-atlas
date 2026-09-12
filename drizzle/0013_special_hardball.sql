CREATE TABLE "state_digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"changes" integer,
	"groups" integer,
	"recipients" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "state_digest_runs_window_idx" ON "state_digest_runs" USING btree ("since","until");