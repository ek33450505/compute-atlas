-- Hand-written SQL, applied via `drizzle-kit generate --custom` rather than
-- schema-diffed by `drizzle-kit generate`.
--
-- drizzle-kit's PostgreSQL snapshot/generator has no first-class support for
-- STORED generated columns of type `tsvector`, so this file's SQL body is
-- authored by hand. `--custom` still gives it a normal journaled entry (see
-- `drizzle/meta/_journal.json`, idx 3). The carry-forward snapshot at the
-- time (`drizzle/meta/0003_snapshot.json`) does NOT model `search_vector` at
-- all, but the very next migration's snapshot (`drizzle/meta/0004_snapshot.json`)
-- DOES record it — as a plain (non-generated) tsvector column, matching
-- lib/db/schema.ts's `searchVector` shim. So from 0004 onward, schema.ts and
-- the snapshot agree the column exists; what neither the snapshot nor
-- schema.ts capture is the GENERATED ALWAYS AS (...) STORED expression below
-- or the `facilities_search_vector_idx` GIN index — both remain hand-managed
-- and invisible to `drizzle-kit generate`, which will not reproduce or alter
-- them on its own. See lib/db/schema.ts's `searchVector` column comment for
-- the corresponding Drizzle-side awareness shim.
--
-- Adds a generated `search_vector` tsvector column to `facilities`, computed
-- from name + operator + notes (from the `doc` jsonb's `notes` field is NOT
-- read here — see note below), plus a GIN index for full-text search via
-- `plainto_tsquery('english', ...)` (see lib/search-db.ts).
--
-- NOTE on `notes`: the facilities table has no dedicated `notes` scalar
-- column (only `doc` jsonb carries structured content), so this migration
-- pulls notes via `(doc->>'notes')` from the jsonb column, coalesced to ''
-- exactly as the phase spec's `coalesce(notes, '')` describes, sourced from
-- the jsonb doc rather than a scalar column that doesn't exist.
ALTER TABLE "facilities"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      "name" || ' ' || "operator" || ' ' || coalesce("doc" ->> 'notes', '')
    )
  ) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facilities_search_vector_idx" ON "facilities" USING gin ("search_vector");
