CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirm_token" text NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"submitter_ip_hash" text,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscriptions_target_idx" ON "subscriptions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_confirm_token_idx" ON "subscriptions" USING btree ("confirm_token");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_unsub_token_idx" ON "subscriptions" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "subscriptions_ip_idx" ON "subscriptions" USING btree ("submitter_ip_hash");--> statement-breakpoint
-- Hand-added (not Drizzle-modeled — mirrors the 0003 tsvector GIN index): a PARTIAL
-- UNIQUE index enforcing at most one ACTIVE (pending|confirmed) subscription per
-- (email, target). Makes app-code dedup race-free + prevents duplicate alert emails;
-- still allows re-subscribe after unsubscribe (status='unsubscribed' rows excluded).
-- COALESCE(target_id,'') so two target_type='all' (NULL target_id) rows for the same
-- email collide instead of both being allowed.
CREATE UNIQUE INDEX "subscriptions_active_target_idx" ON "subscriptions" USING btree ("email","target_type",(COALESCE("target_id", ''))) WHERE "status" <> 'unsubscribed';