DROP INDEX "events_organization_idx";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "tx_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
CREATE INDEX "events_feed_idx" ON "events" USING btree ("organization_id","tx_id","id");--> statement-breakpoint
ALTER TABLE "resources" DROP COLUMN "availability_version";