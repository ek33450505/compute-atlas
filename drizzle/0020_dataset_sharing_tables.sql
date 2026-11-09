CREATE TABLE "dataset_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"organization" text,
	"role" text,
	"category" text NOT NULL,
	"intended_use" text NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attribution_ack_at" timestamp with time zone NOT NULL,
	"terms_version" text NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"verify_token_hash" text NOT NULL,
	"verified_at" timestamp with time zone,
	"access_token_hash" text,
	"renew_token_hash" text,
	"unsubscribe_token" text,
	"approved_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"rejection_note" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"expires_at" timestamp with time zone,
	"renewal_reminded_at" timestamp with time zone,
	"renewal_requested_at" timestamp with time zone,
	"last_download_at" timestamp with time zone,
	"last_notice_edition_id" uuid,
	"download_count" integer DEFAULT 0 NOT NULL,
	"submitter_ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "dataset_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"edition_id" uuid,
	"file" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"outcome" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_date" text NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"record_count" integer,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changelog_summary" jsonb,
	"notice_sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dataset_downloads" ADD CONSTRAINT "dataset_downloads_grant_id_dataset_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."dataset_access_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_downloads" ADD CONSTRAINT "dataset_downloads_edition_id_dataset_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."dataset_editions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dataset_access_grants_status_idx" ON "dataset_access_grants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dataset_access_grants_email_idx" ON "dataset_access_grants" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_open_email_idx" ON "dataset_access_grants" USING btree ("email") WHERE "dataset_access_grants"."status" in ('unverified', 'pending_review', 'active');--> statement-breakpoint
CREATE INDEX "dataset_access_grants_expires_at_idx" ON "dataset_access_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_verify_token_hash_idx" ON "dataset_access_grants" USING btree ("verify_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_access_token_hash_idx" ON "dataset_access_grants" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_renew_token_hash_idx" ON "dataset_access_grants" USING btree ("renew_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_access_grants_unsubscribe_token_idx" ON "dataset_access_grants" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "dataset_downloads_grant_created_idx" ON "dataset_downloads" USING btree ("grant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dataset_downloads_edition_idx" ON "dataset_downloads" USING btree ("edition_id");--> statement-breakpoint
CREATE INDEX "dataset_downloads_created_idx" ON "dataset_downloads" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_editions_edition_date_idx" ON "dataset_editions" USING btree ("edition_date");