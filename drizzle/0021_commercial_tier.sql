CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"grant_id" uuid
);
--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "tier" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "paid_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "dataset_access_grants" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_grant_id_dataset_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."dataset_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_events_received_at_idx" ON "stripe_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_stripe_subscription_id_idx" ON "dataset_access_grants" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_stripe_checkout_session_id_idx" ON "dataset_access_grants" USING btree ("stripe_checkout_session_id");