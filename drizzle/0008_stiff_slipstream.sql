CREATE TABLE "api_daily_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_daily_usage_ip_hash_day_idx" ON "api_daily_usage" USING btree ("ip_hash","day");