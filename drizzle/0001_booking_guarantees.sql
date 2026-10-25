-- The guarantee at the heart of Slotlock: a resource never holds two confirmed bookings whose
-- blocked intervals (booking plus buffers) overlap. Postgres enforces it, so it holds under any
-- concurrency and for every code path, including writes that never touch the API.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tstzrange("blocked_from", "blocked_until", '[)') WITH &&
  ) WHERE ("status" = 'confirmed');
