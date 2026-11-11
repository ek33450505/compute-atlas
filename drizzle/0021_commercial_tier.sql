CREATE TABLE "commercial_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan" text NOT NULL,
	"email" text,
	"name" text,
	"organization" text,
	"terms_version" text NOT NULL,
	"paypal_subscription_id" text,
	"decision" text,
	"reason" text,
	"grant_id" uuid,
	"conflict_grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "commercial_checkouts_paypal_subscription_id_unique" UNIQUE("paypal_subscription_id"),
	CONSTRAINT "commercial_checkouts_plan_check" CHECK ("commercial_checkouts"."plan" IN ('monthly', 'annual')),
	CONSTRAINT "commercial_checkouts_decision_check" CHECK ("commercial_checkouts"."decision" IN ('activate', 'refuse')),
	CONSTRAINT "commercial_checkouts_reason_check" CHECK (("commercial_checkouts"."decision" IS NOT DISTINCT FROM 'refuse') = ("commercial_checkouts"."reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "paypal_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"grant_id" uuid
);
--> statement-breakpoint
DROP INDEX "dataset_access_grants_open_email_idx";--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "tier" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "paid_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "last_payment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "paypal_subscription_id" text;--> statement-breakpoint
ALTER TABLE "commercial_checkouts" ADD CONSTRAINT "commercial_checkouts_grant_id_dataset_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."dataset_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_checkouts" ADD CONSTRAINT "commercial_checkouts_conflict_grant_id_dataset_access_grants_id_fk" FOREIGN KEY ("conflict_grant_id") REFERENCES "public"."dataset_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_webhook_events" ADD CONSTRAINT "paypal_webhook_events_grant_id_dataset_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."dataset_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_checkouts_created_at_idx" ON "commercial_checkouts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "paypal_webhook_events_received_at_idx" ON "paypal_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_paypal_subscription_id_idx" ON "dataset_access_grants" USING btree ("paypal_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_open_email_tier_idx" ON "dataset_access_grants" USING btree ("email","tier") WHERE "dataset_access_grants"."status" in ('unverified', 'pending_review', 'active');--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD CONSTRAINT "dataset_access_grants_tier_check" CHECK ("dataset_access_grants"."tier" IN ('free', 'commercial'));