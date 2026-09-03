CREATE TABLE "api_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirm_token" text NOT NULL,
	"access_token" text,
	"submitter_ip_hash" text,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "api_access_grants_status_idx" ON "api_access_grants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "api_access_grants_confirm_token_idx" ON "api_access_grants" USING btree ("confirm_token");--> statement-breakpoint
CREATE UNIQUE INDEX "api_access_grants_access_token_idx" ON "api_access_grants" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "api_access_grants_ip_idx" ON "api_access_grants" USING btree ("submitter_ip_hash");