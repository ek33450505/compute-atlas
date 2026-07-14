-- Hand-written SQL, applied via `drizzle-kit generate --custom` rather than
-- schema-diffed by `drizzle-kit generate`.
--
-- drizzle-kit's PostgreSQL snapshot/generator has no first-class support for
-- STORED generated columns of type `tsvector`, so this file's SQL body is
-- authored by hand. `--custom` still gives it a normal journaled entry (see
-- `drizzle/meta/_journal.json`, idx 3) and a carry-forward snapshot (see
-- `drizzle/meta/0003_snapshot.json`) that does NOT attempt to model
-- `search_vector` — so `npm run db:migrate` applies this file exactly like
-- any other migration, and a future `drizzle-kit generate` run diffs against
-- a snapshot that was never asked to represent tsvector in the first place.
-- See lib/db/schema.ts's `searchVector` column comment for the corresponding
-- Drizzle-side awareness shim.
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
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      "name" || ' ' || "operator" || ' ' || coalesce("doc" ->> 'notes', '')
    )
  ) STORED;
--> statement-breakpoint
CREATE INDEX "facilities_search_vector_idx" ON "facilities" USING gin ("search_vector");
