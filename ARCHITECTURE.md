# Architecture: Compute Atlas

Compute Atlas is a source-cited public tracker of AI data centers, crypto-mining sites, and dedicated power-generation facilities in the US. The system comprises three layers: a Next.js 16 frontend with React Server Components, a Neon Postgres backend serving cacheable JSON API responses, and an offline operator tool (the discovery pipeline) that proposes changes to a human-moderated staging queue.

## System Overview

**Frontend:** Next.js 16 App Router with React 19 + TypeScript. Renders facility data via React Server Components; components never query the database directly. Reads are centralized through `lib/data.ts` and served through tag-based `unstable_cache` with ISR (Incremental Static Regeneration). The UI itself is Tailwind v4 with Base UI + shadcn primitives, and features MapLibre GL for the globe view.

**Backend:** Neon serverless Postgres, schema in `lib/db/schema.ts`, accessed via Drizzle ORM. The database holds five tables: live facility records, staging submissions, a full audit trail (`facility_history`), subscription data, and `leadsTable` (public tip-offs). Unreviewed intake flows through the `submissions` table (staged and `pending`-by-default) and requires explicit human approval to become live; maintainer-reviewed data publishes directly through `lib/facility-write.ts` (admin UI, admin REST) or `scripts/sync-to-neon.ts` (bulk). See "Invariants (as Absences)".

**Discovery Pipeline:** A local, scheduled operator tool (`scripts/discovery/`) that proposes new facilities and status changes to the staging queue. It runs via launchd on the maintainer's machine and never writes live facilities — it's not part of the deployed application.

## Codemap

### Read Path: `lib/data.ts` and Caching

All database reads flow through centralized loaders in `lib/data.ts`. Components and pages call these functions; none query the database directly.

**Public API functions:**
- **`getAllFacilities()`**, **`getFacilityById(id)`**, **`getFacilitiesByState(code)`**, **`getPowerGenerationFacilities()`**, **`getStats()`**, **`getNotableFacilities(n)`**, **`getFacilitiesByStatus(status)`**, **`getFacilitiesByMetro(slug)`**, **`getFacilitiesByOperator(name)`**, and others — all public query functions internally call the cached loaders.

**Cached loaders (internal):**
- **`loadFacilities()`**: Whole-dataset loader, cached for 1 hour with tag `"facilities"`. Backs ~15 aggregate pages (home, map, table, stats, explore lenses, operators/states index, sitemap). Returns deterministically sorted by `id`.
- **`loadFacilitiesForSearch()`**: Same data cached for 24 hours, **NO cache tag** (cache key is `"facilities-search"`, but deliberately untagged). Used only for the global ⌘K search index in the root layout. The 86400s timer is the intended refresh; the no-tag design prevents a root-layout read from being stamped onto every route on the site. A tag here would be busted by every `db:sync --apply`, nuking the entire site's cache in one shot. Previously carried `"facilities"` tag, reasoned inert at the time; that premise broke once `scripts/sync-to-neon.ts` began adding `"facilities"` to every publish.
- **Scoped cached readers** (per-facility, per-state, per-operator, power-generation, etc.): Tag-only, no timer on the reader. Revalidated only when writes affect their specific scope. Note: the rendered page may still inherit a longer ISR timer from other reads in its render tree (e.g., a scoped detail page reads `loadFacilitiesForSearch` in the root layout, so it inherits that reader's 86400s floor).

All loaders read from either Neon (if `DATABASE_URL` is set) or fall back to the bundled JSON file `data/facilities.json` for offline development. In tests (vitest), caching is disabled.

**Why this structure?** Aggregate and detail pages have different revalidation needs. Approving a single facility on prod shouldn't force the whole site to rebuild; scoped tags ensure a write only touches affected pages.

### Write Paths: Staging, Approval, and Maintainer Publish

- **`lib/submissions.ts`**: Envelope-only validation and staging. `createSubmission()` inserts a new `pending` row in the `submissions` table. The full facility schema validation happens later.
- **`lib/facility-write.ts`**: Exports `createFacility()`, `updateFacility()`, `writeStatusUpdate()`, `writeEnrichmentUpdate()`, and `deleteFacility()` — the write primitives used from inside the Next runtime. They always tag-bust the affected scopes. The approval path calls them, and so do the admin surfaces directly: `app/admin/facilities/facility-form-actions.ts`, `app/admin/facilities/delete-action.ts`, and the bearer-gated `app/api/facilities/route.ts` and `app/api/facilities/[id]/route.ts`.
- **Approval workflow**: Admin calls `/api/submissions/{id}/approve` or the CLI `npm run submissions -- approve <id>`, which calls `approveSubmission()` in `lib/submissions.ts`. This path validates the full `facilitySchema`, calls the write primitive, and emits a `facility_history` audit row.
- **Maintainer bulk publish**: `scripts/sync-to-neon.ts` (`npm run db:sync`, dry run by default; `-- --apply` to publish). `planSync()` diffs `data/facilities.json` against Neon and fails closed on drift — it refuses to overwrite any row that moved ahead of the JSON snapshot's basis, and the same check is re-run atomically inside the UPDATE's `WHERE` clause so a concurrent prod approval cannot be clobbered. It never deletes. Cache-tag revalidation is pre-flighted before the first write, so a publish cannot succeed while leaving the site stale. Its history rows carry `SYNC_HISTORY_SOURCE = "maintainer-sync"`, a `facility_history.source` distinct from `"admin-direct"` and from a submission id.

**Rejection** calls `rejectSubmission()`, which requires a reason (a rejection without one is a `400`), stamps the row `rejected`, and is terminal: any second review action on that submission returns `409 Submission already <status>`. Re-proposing a rejected candidate means staging it again.

### Domain Schema: `lib/schema.ts`

A single source of truth for facility shape, expressed as a Zod discriminated union on `facilityType`:

```
facilitySchema = dataCenterSchema | cryptoMiningSchema | powerGenerationSchema
```

Every facility is one of these three types. Common fields (id, name, operator, location, status, sources, etc.) live in `baseFacilityShape`; each type adds its own fields. For cross-references: `poweredBy` is a base field on all facility types (set on compute records to point to their power source), and `poweredFacilityIds` is nested under `generation` on power-generation facilities (the one-directional source of truth; the reciprocal "Powered by" display is derived at render time).

**Invariant:** No fact enters the system without a citable source. The `sources` array is required and validated by `sourceSchema` (url, label, kind, retrievedAt; publisher is optional). Omit unknown fields rather than fabricate them.

### API Endpoints: `app/api/`

- **Public read:** `/api/facilities` (returns `{count, facilities}` unpaginated, filterable by `?status=`, `?type=`, `?state=`, `?operator=`, `?q=`), `/api/facilities/{id}`, `/api/stats` (aggregate dataset figures: facility count, states, operational/planned/under-construction capacity), `/api/search` (full-text search over the database), `/api/schema` (schema introspection). No authentication. All responses are rate-limited by IP and cached via Cache-Control headers (1h for list/facility/stats, 10m for search, 24h for schema).
- **Public intake:** `POST /api/contribute` (anonymous). Hard-pins `status=pending`, validates with Zod, ignores privileged fields, rate-limits by IP hash. Submissions are human-moderated before going live. `POST /api/leads` is the lighter-weight sibling — public, anonymous, unauthenticated, honeypot-guarded and rate-limited; it writes a tip-off URL to `leadsTable` and never touches facility data.
- **Email alerts (double-opt-in):** `POST /api/subscribe` (public; starts subscription), `/api/subscribe/confirm` (confirms via emailed token), `/api/subscribe/unsubscribe` (opts out). No authentication; opt-in is tracked via email and token.
- **Admin write:** `POST /api/submissions`, `/api/submissions/{id}/approve`, `/api/submissions/{id}/reject` (staging queue); `POST /api/facilities` and `PATCH` / `DELETE /api/facilities/{id}` (single live records — the `DELETE` route and the admin delete action are the only delete surfaces); and `POST /api/revalidate`, the only way an out-of-process CLI can bust cache tags. All require the `API_ADMIN_TOKEN` bearer. Used by the admin UI and the discovery pipeline.

All responses use the `jsonResponse()` helper for consistent status codes and CORS handling. The `/api/search` endpoint uses Postgres full-text search (the database `search_vector`), not the client-side Fuse.js library (which backs the ⌘K command palette in the UI).

### Map and UI: `components/map/`, `lib/seo.ts`

**MapLibre GL** wraps the map in an imperative layer over React; vector (streets) and satellite (Esri) basemaps are swappable without re-mounting. The globe projection is hardcoded (not a mapbox style) to preserve perspective on layer changes.

**JSON-LD** via `lib/seo.ts` generates structured data: `Dataset` on the homepage, `Place` + `BreadcrumbList` on facility detail pages, `ItemList` on directory pages, and a site-wide `Organization`/`WebSite` graph. The OG image is rendered server-side via Satori (React-to-image).

Collection pages (`/states/{state}`, `/operators/{operator}`, `/power`, `/opposition`, `/status/{status}`, `/metros/{metro}`) all use the shared `components/collection/collection-page.tsx` primitive for consistency.

## Invariants (as Absences)

**1. No unreviewed write ever becomes a live facility.** The gate is human review, not any single table. Unreviewed intake — the discovery pipeline and the anonymous `POST /api/contribute` — has exactly one door: it lands as a `pending` row in `submissions` and requires an explicit human `approve` before it touches `facilitiesTable`. Nothing promotes itself. Maintainer-reviewed data takes the second door: `npm run db:sync -- --apply` (`scripts/sync-to-neon.ts`) publishes adds and updates directly, because a maintainer publishing records they have already reviewed *is* the human gate. That door is guarded structurally rather than procedurally — dry run is the default and `--apply` is explicit, a fail-closed drift guard refuses to overwrite any Neon row that moved ahead of the JSON snapshot's basis, tag-busting is pre-flighted before the first write, deletion is never possible, and only the maintainer holds `DATABASE_URL`. The drift guard and the tag-bust pre-flight can each be waived (`--force-over-drift`, `--skip-revalidate`), but only by an explicit flag that the printed plan announces as DISABLED. The admin UI and the bearer-gated `/api/facilities` routes are the same door at single-record granularity. `npm run db:seed -- --force` is the one path whose overwrites bypass both the history log and the tag bust; it is bootstrap-only, for filling an empty database.

**2. No user accounts.** The system uses a single-secret admin token (bearer in Authorization header). The admin UI gates behind a stateless cookie (`admin_session`). This is a durable product decision, not a missing feature.

**3. No reverse flow from the app to `data/facilities.json`.** The JSON file is a read-only export artifact (CC-BY-4.0 licensed separately from code). `npm run db:export` is an operator tool, not part of the runtime.

**4. No fact without a source.** `lib/schema.ts` requires `sources: z.array(sourceSchema).min(1)` on every facility, so a record with no source cannot pass validation on any write path — approval, admin, or `db:sync`. Staging is gated the same way: `lib/submissions.ts` requires at least one provenance source before a submission is accepted, which covers both the discovery pipeline and public contributors.

**5. Every reviewed write is audited.** All changes through the app's write primitives and `db:sync` are logged to `facility_history` with a full diff, the source (`"admin-direct"`, a submission id, `"maintainer-sync"`, or `"db-seed"`), and the change's provenance. Two deliberate gaps: audit inserts are best-effort (a failed history insert logs and does not roll back the facility write), and `db:seed -- --force` writes history only for genuinely new inserts — its overwrite pass writes none, deliberately, so a bulk reseed cannot flood the activity feed. Which is why it is bootstrap-only.

## Layer Boundaries and Cross-Cutting Concerns

### Caching Tiers

- **Full-site ISR floor:** 24h (search index in root layout via `loadFacilitiesForSearch`). This is the longest revalidation on the site. The reader carries no cache tag, so writes do not affect it; the 86400s timer is the only refresh mechanism. All pages inherit this floor when the root layout renders.
- **Aggregate page cache:** 1h (loadFacilities). Intentionally uncoupled from write events; `db:sync --apply` does bust the `"facilities"` tag, but aggregates have a cheap 1h self-healing timer (Ed, 2026-07-22 ISR-write-blowout fix), so scoped writes don't pin them to a refresh cycle.
- **Scoped page caches:** Tag-only, no timer on the reader itself. Revalidated on write only. Pages inherit any longer timer from reads higher in the render tree (typically 24h from the root layout).

Why decouple? Previous versions busted the global `"facilities"` tag on every write, rebuilding the entire site. That is a large surface: the route count is one page per facility, plus one per operator slug, state, metro, status, and learn topic, plus roughly twenty static pages — so it grows with every data wave (at the time of writing, a little over 1,500 routes). Scoped tags cut that blast radius to 4–6 cache **tags** per write (facility detail, current/previous state, current/previous operator, ±power-generation).

**Prod-only gotcha:** Neon is the source of truth. `unstable_cache` is Next.js in-memory; a prod data-only change (approving a facility on prod) updates Neon but not the cache until the tag expires or a tagged page is revalidated. The cache survives Neon outages by serving stale data — this is intentional, a feature not a bug, ensuring the site stays read-accessible even during database downtime.

### Provenance Threading

Every submission row carries a `provenance` JSON field recording:
- `sources`: array of source URLs cited for this submission
- `discoveredBy`: who/what proposed it (e.g., "data-wave:run-123" or "manual")
- `confidence`, `runId`, `note`, `submitterIpHash`, `attribution`

On approve, the provenance is preserved in the audit trail (`facility_history`), enabling traceability: given a facility, you can see its full editing history, who proposed each change, and which sources justified it.

### Discovery Pipeline Isolation

`scripts/discovery/` is a local, scheduled operator tool. It:
- Reads published source data (SEC filings, press, permit databases, etc.)
- Proposes new facilities and status changes
- Stages both as `pending` submissions
- **Never** writes live facilities

The pipeline uses the Claude Code subscription (not metered API) and runs via launchd at 13:00. It writes to the same Postgres instance as the runtime via the admin `/api/submissions` endpoint (bearer auth). The approval workflow is identical to public contributor submissions: human reviews the staging queue and approves/rejects.

This isolation means the app's runtime is decoupled from the pipeline's data sources and logic. The pipeline can be updated, paused, or run ad hoc without touching production code.

## Code Structure Diagram

```mermaid
graph TB
    subgraph "Client (Browser)"
        RSC["React Server Components<br/>(app/page.tsx, app/map, etc.)"]
        UI["UI Layer<br/>(Tailwind, MapLibre GL,<br/>Base UI + shadcn)"]
    end

    subgraph "Server (Next.js)"
        Data["Centralized Read Layer<br/>(lib/data.ts)<br/>loadFacilities, getFacilityById, etc."]
        Cache["Tag-Based ISR Cache<br/>(unstable_cache)<br/>1h aggregate, tag-scoped detail<br/>24h site floor (untagged)"]
        Schema["Domain Schema<br/>(lib/schema.ts)<br/>Zod facilitySchema<br/>discriminated union"]
        API["API Routes<br/>(app/api/)<br/>Public read, public contribute,<br/>admin write"]
    end

    subgraph "Database (Neon Postgres)"
        Live["facilitiesTable<br/>(live records)"]
        Submissions["submissionsTable<br/>(staged, pending-by-default)"]
        History["facility_history<br/>(audit trail)"]
        Subs["subscriptions<br/>(for email alerts)"]
        Leads["leadsTable<br/>(public tip-offs)"]
    end

    subgraph "Operator Tool (Local)"
        Pipeline["Discovery Pipeline<br/>(scripts/discovery/)<br/>Claude Code subscription<br/>Proposes via /api/submissions"]
    end

    RSC -->|read| Data
    Data -->|cache hit/miss| Cache
    Data -->|query| Live
    Cache -->|invalidates via tags| Live

    UI -->|call| API
    API -->|create submission| Submissions
    API -->|record tip-off| Leads
    API -->|read live| Live
    API -->|approve flow| History
    API -->|write after approval| Live

    Submissions -->|human approves| History
    History -->|fact source| Schema

    Pipeline -->|POST /api/submissions<br/>bearer token| API
    Pipeline -->|reads sources<br/>external data| Schema

    Schema -.->|validates| Live
    Schema -.->|validates| Submissions
```

## Operational Considerations

**Offline fallback:** If Neon is unreachable and `DATABASE_URL` is unset, the app falls back to `data/facilities.json`. For local development, `` `DATABASE_URL= npm run dev` `` switches to JSON mode (useful during Neon outages).

**Local discovery runs:** The pipeline is scheduled via launchd but can be invoked ad hoc via `bash scripts/discovery/run.sh` with `DISCOVERY_ENABLED=true` set in the environment. The underlying `claude -p` call uses `--append-system-prompt` with a plain-text batch contract (not JSON) to enforce JSON-only output mode for parsing reliability.

**Admin CLI:** `npm run submissions -- list pending | approve <id> "note" | reject <id> "note"` for staging-queue review and approval.

**Source exports:** `npm run db:export` writes the live facility set back to `data/facilities.json` for distribution (CC-BY-4.0 separate license).

## Trade-offs and Lessons

**Why Drizzle over raw SQL?** Type safety on queries and migrations without heavyweight ORMs like Prisma. Drizzle stays close to SQL.

**Why tag-based ISR over time-based?** Aggregates have natural revalidation timers (1h is acceptable staleness for stats); scoped pages should refresh immediately on write via tag bust, yet all pages inherit a 24h ISR floor from the root layout's untagged search reader. Mixing both (tags + timers) gives fine-grained control without nuking the entire site on every change.

**Why no time-based full cache invalidation?** Previous versions used `revalidate: 300` (5 min), causing prod cache rot during outages. The current model: scoped tags bust immediately, aggregates use a cheap long timer (1h), search index stays 24h. However, all pages floor at 24h because the root layout's `loadFacilitiesForSearch` reader carries no cache tag — it can only refresh via its timer — so an un-busted data change can take up to a full day to propagate.

**Why no user accounts?** Contributor attribution is optional; the admin UI is for one operator. User accounts add auth complexity, session management, and account recovery. For a single-operator tool, the bearer token is simpler and sufficient. This is a durable design choice, not a placeholder pending features.

**Why stage before approval?** Submissions are cheap to generate (pipeline, public form); approval is where rigor happens. This decouples discovery velocity (fast, automated) from publication discipline (human-gated).

**Why keep the pipeline local?** It needs access to real-time SEC filing APIs, press databases, and permit systems — all require complex scraping and source debouncing. Hosting it serverless (Lambda) adds latency and cold-start costs; launchd on a developer machine with persistent state is simpler and cheaper.

## Further Reading

- **Data model:** `lib/schema.ts` — Zod schemas for all facility types and enums.
- **DB migrations:** `drizzle/` — Drizzle migration files; apply with `npm run db:migrate`.
- **Cache tag vocabulary:** `lib/cache-tags.ts` — the tags a write emits (`tagsForFacility`) and the `POST /api/revalidate` allowlist (`isValidCacheTag`, backed by `LITERAL_TAGS` + `TAG_PATTERNS`), kept in one place so producer and validator cannot drift apart.
- **Operator slug handling:** `lib/operator-slug.ts` — dependency-free slug generator (imported by `lib/cache-tags.ts` for `operator:<slug>` scoping).
- **Discovery pipeline:** `scripts/discovery/` and `docs/discovery-pipeline.md` — methodology and source enumeration.
- **Public contribution:** `CONTRIBUTING.md` — editorial standards for source-cited data.
