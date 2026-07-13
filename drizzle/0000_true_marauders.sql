CREATE TABLE "facilities" (
	"id" text PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"name" text NOT NULL,
	"operator" text NOT NULL,
	"state" text NOT NULL,
	"status" text NOT NULL,
	"facility_type" text NOT NULL,
	"confidence" text NOT NULL,
	"capacity_operational_mw" double precision,
	"capacity_planned_mw" double precision,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"announced_date" text,
	"last_updated" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "facilities_state_idx" ON "facilities" USING btree ("state");--> statement-breakpoint
CREATE INDEX "facilities_operator_idx" ON "facilities" USING btree ("operator");--> statement-breakpoint
CREATE INDEX "facilities_status_idx" ON "facilities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "facilities_facility_type_idx" ON "facilities" USING btree ("facility_type");