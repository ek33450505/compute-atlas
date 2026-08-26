# CLAUDE.md

Guidance for Claude Code (and human contributors) working in this repo.

**Compute Atlas** (`www.compute-atlas.com`) is a source-cited public tracker of AI
data centers, crypto-mining sites, and dedicated power-generation facilities in
the US. Next.js app + a curated, human-moderated dataset served from Postgres.

## Commands

```bash
npm run dev            # local dev server (next dev)
npm run build          # production build
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest run (unit/integration)
npm run test:watch     # vitest watch
npm run test:e2e       # playwright (a11y + e2e)
bats tests/discovery/run.bats   # shell tests for the discovery harness

# Database (Neon Postgres + Drizzle) — all read .env.local
npm run db:generate    # generate a migration from schema changes
npm run db:migrate     # apply migrations
npm run db:sync        # DRY RUN: diff data/facilities.json against Neon, print the plan
npm run db:sync -- --apply   # publish adds + updates, write history, bust cache tags
npm run db:export      # export live facilities back to data/facilities.json (Neon → JSON)
npm run check:drift    # report JSON↔Neon drift (read-only, non-blocking)
npm run db:seed        # BOOTSTRAP ONLY: insert NEW facilities into an empty DB
npm run db:seed -- --force   # legacy bulk overwrite — writes NO history, busts NO tags

# Map data
npm run build:mapdata                 # build static map overlays and siting-context from public sources

# Data operations
npm run submissions -- list pending          # review the staging queue
npm run submissions -- approve <id> "note"   # promote a pending submission to live
npm run submissions -- reject <id> "note"
npm run check-sources                        # source-liveness report (read-only)
```

**CI:** GitHub Actions runs typecheck, lint, and the vitest suite (plus the
discovery BATS shell tests) on each PR; the Vercel preview build is an additional
gate. Still run `npm run typecheck && npm test` locally before opening a PR.

## Architecture

- **Framework:** Next.js 16 (App Router, React Server Components) + React 19 + TypeScript.
- **Data:** Neon serverless Postgres via Drizzle ORM. Drizzle tables in
  `lib/db/schema.ts`; config in `drizzle.config.ts`. DB access is centralized in
  `lib/data.ts` — components don't query the DB directly.
- **Domain schema:** `lib/schema.ts` — the Zod `facilitySchema`, a discriminated
  union on `facilityType` (`data_center` | `crypto_mining` | `power_generation`).
  This is the single source of truth for a facility's shape; validate against it
  everywhere data enters the system.
- **Map:** MapLibre GL (`components/map/*`), globe projection + vector/satellite
  basemaps. Optional overlays (waterways, transmission lines, drought, baseline
  water stress, groundwater decline, principal aquifers) are tinted,
  off-by-default, lazily-loaded layers grouped (Water · Power · Geology) behind
  the map's "Layers" control, each keyed by a color swatch. Ordinal overlays use
  single-hue light→dark ramps so severity reads by luminance, not hue (ramps are
  centralized in `lib/map-overlays.ts` so paint and legend never drift); when an
  ordinal layer is active the control shows a legend with per-band facility
  counts (built at build time into `map-layers.json`). Fill-only overlays are
  hidden over satellite imagery, so their toggles are disabled in satellite mode.
  The `/map` route is immersive full-bleed — `FooterGate` suppresses the global
  footer there so the map fills exactly one viewport. Each
  facility page displays "Siting context" — straight-line proximity to nearest
  named surface water and ≥230 kV transmission line, plus the surrounding basin's
  water stress / groundwater trend (WRI Aqueduct 4.0) and underlying principal
  aquifer (USGS) — framed as regional context, not measured facility water use.
  `data/facilities.json` is the seed/export artifact, not the live source.
- **UI:** Tailwind v4, Base UI + shadcn primitives, a parchment/ink "atlas" design
  system in `app/globals.css :root`.
- **SEO:** `lib/seo.ts` builds JSON-LD (`Dataset` on the homepage; `Place` +
  `BreadcrumbList` on facility pages; site-wide `Organization`/`WebSite` graph;
  `ItemList` on directory/collection pages); per-route `alternates.canonical`;
  `app/sitemap.ts` + `app/robots.ts` (`/admin` + `/api` disallowed).
- **Collection pages:** `components/collection/collection-page.tsx` is the shared
  primitive for facility-list landing pages (masthead + stat row + card grid +
  BreadcrumbList/ItemList JSON-LD), with `show-more-list.tsx` for progressive
  reveal of long lists. Used by the by-status and by-metro lenses.
- **Key routes:** `app/page.tsx` (home) · `app/map` · `app/table` · `app/explore/*`
  + lens pages (`states`/`operators`/`power`/`opposition`/`status`/`metros`, incl.
  `[state]`/`[operator]`/`[status]`/`[metro]` hubs) · `app/facilities/[slug]` ·
  `app/contribute` · `app/activity` · `app/admin/*` · `app/api/*`.

## Core invariant: no unreviewed write ever becomes a live facility

The gate is **human review**, not any particular mechanism. There are exactly two
ways data goes live, and both put a person in front of it:

1. **Unreviewed intake is staged.** Anything arriving from the discovery pipeline
   or a public contributor lands as a `pending` row in the `submissions` table and
   requires an explicit human `approve` (`lib/submissions.ts`, the `submissions`
   CLI, or the admin UI). Nothing promotes itself. Never relax this.
2. **Maintainer-reviewed data publishes directly** via `npm run db:sync -- --apply`
   (`scripts/sync-to-neon.ts`). A maintainer publishing records they have already
   reviewed *is* the human gate — staging their own work for their own approval
   would be ceremony, not safety. The gate lives in the explicit `--apply`
   (dry run is the default), the fail-closed drift guard, and the fact that only
   the maintainer holds `DATABASE_URL`.

⚠️ Do not "fix" `db:sync` into routing through `submissions` — that reading of this
section is what this wording exists to prevent (Ed, 2026-08-08).

- **Public intake** (`POST /api/contribute`) is anonymous + moderated: it hard-pins
  `status=pending`, validates with Zod, and ignores privileged fields. Never relax it.
- **Admin/pipeline writes** (`POST /api/submissions`, approve/reject) require the
  `API_ADMIN_TOKEN` bearer. The admin pages use a lightweight single-secret cookie
  gate — there is intentionally **no user-account system** (durable product decision).
- **Data rigor:** every fact is traceable to a real, citable source. Do not
  fabricate coordinates, capacity, operators, or dates — omit unknown fields. See
  `CONTRIBUTING.md` and the data model in `lib/schema.ts`.

## Data waves: the DB is the source of truth, the JSON is generated

Research → **`npm run db:sync`** (dry run, review the plan) → `-- --apply` →
`npm run db:export` → **`npm run build:mapdata`** → commit the regenerated JSON.
`data/facilities.json` is never hand-edited as the *publish* step; it is an artifact of the DB.

⚠️ **`build:mapdata` is part of the wave, not an optional extra.** New facilities have no entry
in `data/siting-context.json` until it runs, so their pages silently render without the
"Siting context" panel — no error, just a missing section. Skipping it let that gap reach 65 of
934 records before anyone noticed (2026-08-08). Use the full run, not `--skip-nhd`: that flag
reuses existing nearestWater/nearestTransmission values, which is precisely what new records
lack. Diff-read the result — it should be additive (fills and new entries), and any
`value → null` is data loss, not a refresh.

Why it matters: the site reads Neon live, so data never needed a build. Editing the
file and shipping it through git made every correction a Vercel deploy, and left
drift (`check:drift`, the `neon-sync` workflow) to be detected and repaired
afterwards. Syncing first makes drift structurally impossible instead, and
`check:drift` becomes a true invariant that should always pass.

`db:sync` writes `facility_history` for every change (so `/activity` sees it) and busts the cache tags for affected scopes (`facility:<id>`, `state:<XX>`, `operator:<slug>`, ±`power-generation`), plus unconditionally adds the `"facilities"` tag to keep aggregate pages fresh. It cannot reach the untagged search index (86400s timer only). `db:seed --force` does neither — it is bootstrap-only, kept for filling an empty database.

## Discovery pipeline

A local, scheduled, subscription-powered pipeline (`scripts/discovery/`) that
proposes new facilities and re-checks existing ones for status changes, staging
both as `pending`. It never writes live facilities. Every candidate source URL is
fetched and mechanically verified before staging, using a **local Ollama** model
(`scripts/discovery/verify-source.ts`); the gate is on by default and, if Ollama is
unreachable or `OLLAMA_VERIFY_MODEL` is not pulled, the run **aborts loudly** rather
than staging unverified candidates (`VERIFY_SOURCES_ENABLED=false` is the only
opt-out). Architecture and the safety contract: `docs/discovery-pipeline.md`; operator mechanics
(launchd, `ollama pull`, running it by hand): `docs/discovery-runbook.md`. It uses the Claude Code subscription (not the metered
API) and runs via `launchd` on the maintainer's machine — treat it as an operator
tool, not part of the deployed app.

## Conventions

- React 19 functional components + hooks; test files alongside source
  (`Foo.tsx` → `Foo.test.tsx`), Vitest + Testing Library, assert on
  roles/text not test-ids. Playwright covers a11y/e2e.
- Accessibility is first-pass, not a later sweep (labels, focus-visible, keyboard
  nav, `prefers-reduced-motion`).
- Editorial voice: "source-cited" (not "source-verified"); the site reads
  impersonal, personal pages first-person. De-sell.
- **Dual license:** code MIT (`LICENSE`), data CC-BY-4.0 (`LICENSE-DATA`).

## Gotchas

- **`.env.local` quoting:** `vercel env add` keeps surrounding quotes; a quoted
  `DATABASE_URL` is invalid and fails *silently* (no fallback). Strip quotes.
- **Builds are gated, production included.** `vercel.json` runs
  `scripts/vercel-ignore-build.sh` as Vercel's Ignored Build Step: **any**
  deployment whose diff touches only `data/`, `docs/`, `.github/`, `*.md` is
  skipped — production too, since `db:sync` puts data live in Neon before the
  commit recording it is ever merged. The one thing a prod build still refreshes
  on a data-only merge is the `withJsonFallback` snapshot bundled from
  `data/facilities.json`; that now rides the next code deploy (or
  `npx vercel redeploy --target production` on demand). Covered by
  `tests/vercel/run.bats`. Note Vercel builds *every push to every branch, PR or
  not* — batching commits on a long-lived branch saves nothing on its own.
  Three traps if you touch this script: Vercel's build container has a
  **single-branch shallow clone** (no `origin/main`, and `git fetch origin main`
  fails), so it diffs `VERCEL_GIT_PREVIOUS_SHA` — the last *built* commit, which
  correctly accumulates across skipped pushes and may sit well behind `HEAD^`
  after a merge. It **fails open**: any uncertainty builds, which means a broken
  gate looks identical to a working one. And it can now withhold a *production*
  deploy, so the fail-open paths matter more than they used to. Verify changes by
  reading the real build log (`npx vercel inspect --logs <url> | grep
  vercel-ignore`), never by local probes alone.
- **Prod cache & bulk go-live:** The site has three independent cache tiers:
  - **Aggregate pages** (home/map/table/stats/explore) read `loadFacilities` with **1h ISR timer** (`revalidate: 3600`) and carry the `"facilities"` tag — they self-heal within the hour even if a tag bust is missed.
  - **Scoped pages**: `/facilities/[slug]` (1064 routes) carries only scoped tags — `facility:<id>`, `operator:<slug>`, `state:<XX>`, plus `power-generation` where relevant — and no longer carries the global `"facilities"` tag; it floors at 86400s inherited from the root layout. The state/operator/metro hubs (50/363/27 routes) **do** still carry `"facilities"` on a 3600s timer, so they self-heal hourly as well as on a bust. There is no `metro:` tag — metro hubs are covered by `"facilities"` alone.
  - **Search index** (global ⌘K palette via `loadFacilitiesForSearch` in root layout) is **24h untagged timer only** — no tag bust affects it; `db:sync --apply` cannot refresh it.
  
  All pages inherit the longest timer from any reader in their render tree (typically 24h from the root layout). The tag vocabulary (`facility:<id>`, `state:<XX>`, `operator:<slug>`, `power-generation`, `facilities`) is centralized in `lib/cache-tags.ts` and shared by `lib/facility-write.ts` and `POST /api/revalidate` so producer and validator can't drift apart. `db:sync --apply` and the approve-on-prod path bust affected tags for you. Only a **raw** Neon write (`db:seed --force`, an ad-hoc upsert) leaves them un-busted — then hit the admin-bearer `POST /api/revalidate` yourself with the affected tags (e.g. `{"tags":["facilities","state:CA"]}`); brand-new facility ids need no bust (cache-miss populates them).
- **JSON ↔ Neon — Neon is truth, and `db:sync` is the only bulk write path.**
  `db:sync` applies adds *and* updates, writes history, busts tags, and refuses to
  overwrite a Neon row that moved ahead of the JSON's basis (`facilities.meta.json`'s
  `asOf`) — so it can't clobber a prod approval. `db:seed --force` publishes adds but
  **silently drops every correction to an existing row, writes no history, and busts
  no tags** — it is bootstrap-only. After syncing, `db:export` regenerates the JSON
  from Neon so `check:drift` is clean.
- **Local-only docs:** some maintainer notes under `docs/` are gitignored working
  files — check `.gitignore` before adding a doc, and never commit those.
- **Dev server:** don't run `next build`/`start` while `next dev` is live (it
  corrupts `.next`); a long-running dev server can also serve stale `globals.css`.
- **Static-asset edge cache:** `/data/:path*` and `/basemap/:path*` carry `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800` (edge cache up to 1 day plus 7 days stale reuse); `/fonts/:path*` are immutable. After `npm run build:mapdata`, regenerated geojson rides the edge cache for up to 24 hours — if a correction must go live immediately, purge Cloudflare by prefix.
