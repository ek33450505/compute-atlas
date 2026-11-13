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
bats tests/discovery/           # shell tests for the discovery harness (every suite in the directory)

# Database (Neon Postgres + Drizzle) — all read .env.local
npm run db:generate    # generate a migration from schema changes
npm run db:migrate     # apply migrations
npm run db:sync        # DRY RUN: diff the local data/facilities.json snapshot against Neon, print the plan
npm run db:sync -- --apply   # publish adds + updates, write history, bust cache tags
npm run db:sync -- --apply --skip-notify   # publish without emailing facility subscribers
npm run db:export      # write the local gitignored data files from Neon (Neon → JSON)
npm run test:dataset   # vitest against the real snapshot (pretest:dataset runs prebuild)
npm run ownership:apply   # DRY RUN: apply data/operator-ownership.json to Neon (-- --apply to write)
npm run db:seed        # BOOTSTRAP ONLY: insert NEW facilities into an empty DB
npm run db:seed -- --force   # legacy bulk overwrite — writes NO history, busts NO tags

# Map data
npm run build:mapdata                 # build static map overlays and siting-context from public sources
npm run siting:refresh                # DRY RUN: build:mapdata → additive guard vs Neon → siting:apply dry run
npm run siting:apply -- --apply       # write siting context to Neon

# Data operations
npm run submissions -- list pending          # review the staging queue
npm run submissions -- approve <id> "note"   # promote a pending submission to live
npm run submissions -- approve <id> "note" --notify-watchers   # required when the facility it writes has confirmed watchers: approving emails them
npm run submissions -- reject <id> "note"
npm run check-sources                        # source-liveness report (read-only)
```

**CI:** seven workflows live in `.github/workflows/` (`automation-health`, `ci`, `codeql`,
`discovery-watchdog`, `googlebot-canary`, `release-please`, `schema-check`). `ci.yml` is the PR gate and
runs three jobs — `typecheck · lint · test` (tsc, eslint, vitest), `BATS tests`
(the discovery, vercel ignore-gate and workflows shell suites), and
`Playwright e2e` (a11y + e2e). CodeQL scans on every PR and push to `main` plus
weekly. The Vercel preview build is an additional gate. (Phase 1, 2026-11-05: `neon-sync`, `nhd-backfill` and `release-please` are `disabled_manually`; see Gotchas.)

Now: `neon-sync`, `nhd-backfill` and `drift-alert` are deleted (`schema-check` replaces drift-alert's schema check); `release-please` is still disabled.

⚠️ **Exactly three status checks are *required* on `main`, and their names are
load-bearing: `typecheck · lint · test`, `BATS tests`, `Playwright e2e`.** Branch
protection matches on the job name, so **never rename them** — a rename silently
detaches the requirement and the branch is unprotected while still reading green.
`Playwright e2e` has been required since 2026-09-11: a red e2e blocks the merge,
it is not advisory. Still run `npm run typecheck && npm test` locally before
opening a PR.

## Architecture

- **Framework:** Next.js 16 (App Router, React Server Components) + React 19 + TypeScript.
- **Data:** Neon serverless Postgres via Drizzle ORM. Drizzle tables in
  `lib/db/schema.ts`; config in `drizzle.config.ts`. DB access is centralized in
  `lib/data.ts` — components don't query the DB directly.
- **Domain schema:** `lib/schema.ts` — the Zod `facilitySchema`, a discriminated
  union on `facilityType` (`data_center` | `crypto_mining` | `power_generation`).
  This is the single source of truth for a facility's shape; validate against it
  everywhere data enters the system. Optional fields like `stakeholders` (named
  people with a documented stake in a specific site) are site-level curated,
  excluded from public intake and discovery enrichment.
  `notRecorded` marks a field deliberately left out, with a public reason; validation rejects a field that
  is both set and marked; and the field-extraction lane skips marked fields. It is maintainer-curated
  and stripped from public intake and discovery staging like `stakeholders`.
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
  `data/facilities.json` is a gitignored local export of Neon, not the live source.
- **UI:** Tailwind v4, Base UI + shadcn primitives, a parchment/ink "atlas" design
  system in `app/globals.css :root`.
- **SEO:** `lib/seo.ts` builds JSON-LD (`Dataset` on `/dataset`, only while dataset sharing is on, with
  `isAccessibleForFree: false`; `Place` +
  `BreadcrumbList` on facility pages; site-wide `Organization`/`WebSite` graph;
  `ItemList` on directory/collection pages); per-route `alternates.canonical`;
  `app/sitemap.ts` + `app/robots.ts` (`/admin` + `/api` disallowed).
- **Collection pages:** `components/collection/collection-page.tsx` is the shared
  primitive for facility-list landing pages (masthead + stat row + card grid +
  BreadcrumbList/ItemList JSON-LD), with `show-more-list.tsx` for progressive
  reveal of long lists. Used by the by-status, by-metro and by-county hubs and the stakeholder
  pages (`app/{status,metros,counties,stakeholders}/[…]/page.tsx`).
- **Key routes:** `app/page.tsx` (home) · `app/map` · `app/table` · `app/explore/*`
  + lens pages (`states`/`operators`/`power`/`opposition`/`status`/`metros`/`counties`,
  incl. `[state]`/`[operator]`/`[status]`/`[metro]`/`[county]` hubs) ·
  `app/facilities/[slug]` · `app/contribute` · `app/activity` · `app/admin/*` ·
  `app/api/*` · approved-access dataset: `app/access` (the request form) and `app/access/*` (confirm,
  dataset, renew, unsubscribe), `app/admin/access`, `app/api/dataset/*`, `app/api/cron/dataset-edition`.
- **Dataset-sharing tables** (migration `0020`, `lib/db/schema.ts`): `dataset_access_grants`,
  `dataset_editions`, `dataset_downloads`. Their logic is in `lib/dataset-*.ts`; `lib/data.ts`
  does not read them.

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
   (dry run is the default), the fail-closed stale-basis guard, and the fact that only
   the maintainer holds `DATABASE_URL`.

⚠️ Do not "fix" `db:sync` into routing through `submissions` — that reading of this
section is what this wording exists to prevent (Ed, 2026-08-08).

- **Public intake** (`POST /api/contribute`) is anonymous + moderated: it hard-pins
  `status=pending`, validates with Zod, and ignores privileged fields. Never relax it.
  It also accepts one field that never reaches a facility: an optional `notifyEmail`
  ("email me when this is reviewed"), gated entirely on `SUBMISSION_NOTIFY_ENABLED`, which is
  **`true` in production since 2026-09-14** (Ed's decision; it shipped disabled and stayed
  that way for weeks). Unsetting the var is still the kill switch, but it takes a redeploy
  (Vercel applies env changes to new deployments only) and a Cloudflare purge for the form
  fields; see `docs/maintainers.md`. It is
  deliberately NOT part of `contributeInputSchema` — a Zod object strips unknown keys
  silently, so with the flag off the field is never read or validated and responses stay
  byte-identical; putting it in the schema would make a malformed value 400 while the feature
  is off, an oracle revealing it exists. ⚠️ That reasoning is about the DISABLED state and
  still governs any future re-disable — do not "tidy" `notifyEmail` into the schema now that
  the flag is on. It is stored in
  `submission_notify_requests` (never in `submissions.payload`, which matters because the
  admin detail view renders every unrecognised payload key), used for exactly one
  transactional send on approve/reject, then deleted — on review even if the send failed.
  Volume is bounded by `checkSubmissionNotifySendCap`, a persistent salted-hash counter;
  the sibling `checkSubmissionNotifyCap` bounds only outstanding requests, because those rows
  are deleted at review time. Do not conflate the two, and do not route it through
  `subscriptions`: this reader never subscribed, so an unsubscribe link would be a lie.
- **Watch subscriptions are double opt-in, and the auto-confirm shortcut is gated on the REQUESTER,
  not the address.** `canAutoConfirm` originally returned true whenever *the address* held any
  `confirmed` row, which let an anonymous POST create a live subscription for a third party and mail
  them (up to 50/address/7d). An existing confirmed row proves *someone* once proved receipt of that
  address — **not that this requester did**. The shortcut now requires a signed, httpOnly consent
  cookie minted only when a confirm link is genuinely clicked, and is refused outright when a prior
  `unsubscribed` row exists for that exact `(email, targetType, targetId)`. ⚠️ Do not "simplify" it
  back to an address-level check, and do not add a volume cap and call it consent — a cap makes an
  unconsented action bounded, not consented. ⚠️ The partial unique index
  `subscriptions_active_target_idx` is `WHERE status <> 'unsubscribed'`, so an unsubscribed row does
  not block re-insertion at the index level. Durable opt-outs now live in `email_suppressions`
  (migration 0016: per-target, plus a global "Stop all automated email" that only its first stop
  token can undo; see `docs/maintainers.md`). Every subscription email goes through `sendGated`
  (`lib/email-gate.ts`), which re-reads the row by id and checks suppression and required status
  before it sends, plus the per-address cap for confirm mail only. `lib/email-send-gate-guard.test.ts` fails if a
  guarded sender is called outside the gate. Every attempt is written to `email_sends` (migration
  0017) with the address as a salted hash only. County and metro watch targets exist behind
  `WATCH_AREAS_ENABLED` (`lib/watch-target-types.ts`).
- **Admin/pipeline writes** require a bearer token, but not all the same one.
  `POST /api/submissions` — staging only — accepts EITHER `API_INTAKE_TOKEN` or
  `API_ADMIN_TOKEN` (`requireIntake`). The scheduled discovery pipeline submits with
  `API_INTAKE_TOKEN` only (`DISCOVERY_REQUIRE_INTAKE_TOKEN=1`, with the token set in Vercel
  production and `.env.local`); manual runs may still fall back to `API_ADMIN_TOKEN`. The split
  was declined 2026-10-28 (see `docs/maintainers.md`) because the pipeline also holds the owner
  `DATABASE_URL`; that still holds for the leads lane's writes, retention-prune and
  publish-heartbeat, so this narrows submissions, not the whole pipeline. `GET
  /api/submissions` and approve/reject require `API_ADMIN_TOKEN`. Do not widen
  `requireIntake` past that one handler. The admin pages use a lightweight
  single-secret cookie gate — there is intentionally **no user-account system**
  (durable product decision).
- **Data rigor:** every fact is traceable to a real, citable source. Do not
  fabricate coordinates, capacity, operators, or dates — omit unknown fields. See
  `CONTRIBUTING.md` and the data model in `lib/schema.ts`.

## Data waves: Neon is the source of truth, the data files are local

`data/facilities.json`, `data/facilities.meta.json`, `data/siting-context.json`,
`data/operator-ownership.json` and `data/nhd-backfill-debt.json` are gitignored local files, as are
the hero outputs (`components/home/hero-plate-paths.ts`, `public/data/hero-points.json`,
`public/data/pipeline-history.json`). `npm run db:export` writes them from Neon. Old commits still
serve the frozen open edition (3,025 records). A wave never produces a data commit:

`npm run db:export` → research → **`npm run test:dataset`** (its `pretest:dataset` hook runs
`npm run prebuild`, so the hero artifacts regenerate from the snapshot; it fails on a fixture
snapshot) → **`npm run db:sync`** (dry run, review the plan) → `npm run db:sync -- --apply`.

`db:sync` refuses a snapshot below the export floor (2,900 records) or whose meta `recordCount`
disagrees, in dry run and `--apply`, before any DB access ("looks like the test fixture; run
`npm run db:export` first"). A fresh clone has no data files: run `npm run prebuild` (fixture mode
outside Vercel; CI sets `ALLOW_FIXTURE_SNAPSHOT=1` on its Seed step and the Playwright `webServer`
only) before typecheck and tests. Vercel builds export the snapshot from Neon and fail closed in
production. `docs/media/map.svg` is a frozen committed asset; `build:heroplate` no longer writes it.

**Local siting refresh** (new facilities have no siting context until it runs, so their pages render
without the "Siting context" panel, with no error): `npm run db:export`, then
`npm run siting:refresh` (dry run: `build:mapdata` → additive guard against Neon → `siting:apply` dry
run), then `npm run siting:apply -- --apply`. `siting:refresh` cannot pass `--skip-nhd` or
`--backfill-nhd`; run those steps by hand. The guard refuses an empty Neon baseline ("run
`npm run backfill:siting -- --apply` first"), and a confirmed-NHD-absence clear fails it, so that clear needs a
deliberate maintainer apply (an allowlist is a follow-up). Diff-read the result: it should be
additive, and any `value → null` is data loss, not a refresh. Use the full run rather than
`--skip-nhd` (which reuses existing nearestWater/nearestTransmission values, exactly what new
records lack) except when USGS NHD is degraded rather than down: the failure budget counts failures
and is blind to latency, so 200-OK responses at 30x slow keep a full pass grinding. Then run
`build:mapdata -- --skip-nhd` now and `-- --backfill-nhd` later (it fills only entries lacking
`nearestWater`; mutually exclusive with `--skip-nhd`). Record the shortfall with
`npm run nhd:debt -- --note "<why>"` (`-- --ledger-db` mirrors it to Neon `maintenance_ledger`).
The ledger `data/nhd-backfill-debt.json` is a local file that `db:export` does not recreate, and the
dataset ratchet in `lib/siting-context.dataset.test.ts` FAILS (does not skip) when it is missing.
`npm run nhd:debt -- --count` prints the live integer; the non-CONUS exclusion (AK, HI, GU, MP, PR,
VI: NHD is CONUS-only) is required or the count never reaches 0. `resolveNearestWater` carries a
prior `nearestWater` forward on every unconfirmed NHD failure; only a confirmed absence clears it,
which is why a full run is the right tool for re-querying a facility whose coordinates were corrected.

**Ownership:** edit the local `data/operator-ownership.json` (from `db:export`), then
`npm run ownership:apply` (dry run) and `npm run ownership:apply -- --apply`. It inserts and
updates, reads back and checks the count, and ALWAYS REFUSES removals (a removal is a reviewed manual
Neon edit plus a revalidate). It busts `operator:<slug>` and `facilities`, and needs `API_BASE_URL`
and `API_ADMIN_TOKEN` unless `--skip-revalidate`.

**Admin "Refresh site"** busts the `facilities` tag only. It does not regenerate the hero plate,
hero points or as-of date; the next build does. By decision (Ed, 2026-11-06), the button does not call a deploy hook.

**Maintainer note for pulling PR C into a tree that has the data files:** the pull deletes them.
Back them up first (the NHD ledger has no other copy: the Neon row from `npm run nhd:debt -- --ledger-db` is a durable record of the count, but no command restores the local file from it; keep the backup, or re-record the current count with `npm run nhd:debt -- --note "<why>"`, which resets the ceiling to today's count), then run `npm run db:export` (discovery's
loader reads Neon first and aborts loudly on a bad snapshot). Merge or pull only outside weekdays 13:00 (Mon-Fri).

⚠️ **Data-source decision (2026-09-29): keep the live NHD query service, do not migrate to bulk
download.** Evaluated and rejected replacing the per-facility ArcGIS queries (`nhdQueryLayer`,
called by `nearestWaterViaNHD`) with a bulk download:
- USGS NHD was retired 2023-10-01 and is frozen — no longer maintained; the 3D Hydrography Program
  (3DHP) is the successor. ⚠️ Secondary-sourced: the USGS access page returned HTTP 403 to `curl` this
  session, so it was not fetched directly — corroborated by the `3DHP`/`3DHP_all` MapServers returning
  HTTP 200.
- The live service's layer is *named* "Flowline - Small Scale" but its own metadata describes
  high-resolution NHD at 1:24,000/1:12,000 scale, with `GNIS_NAME` present. The name is a trap — it is
  NOT the USGS 1:1,000,000 product.
- Bulk sizes via the TNM Access API: national FileGDB 31,436,969,083 bytes (29.3 GiB, published
  2025-09-18); national GeoPackage 43.1 GB; sum of all 56 state/territory FileGDBs ~22.7 GB (that
  per-state sum was not independently re-verified).
- **Decision: not switching.** `data/siting-context.json` is already the cache; frozen upstream data
  cannot go stale, so only our own coordinate corrections invalidate an entry. Re-querying all 2,268
  records to learn ~19 new ones per wave is ~99% waste, which `--backfill-nhd` removes instead. Bulk
  would cost 22.7 GB of transfer, a GDAL system dependency (no mature pure-JS FileGDB reader; the
  pure-JS shapefile route is ~46.5 GB), and replacing `nearestFromCandidates`'s bbox-prefilter + linear
  scan with a real spatial index.
- Keep the live service as the documented escape hatch for a genuine full recompute (a methodology
  change or mass coordinate corrections).
- Explicitly rejected: the USGS 1:1,000,000 hydrographic geodatabase (~231 MB national, small enough
  to tempt) — it is a ~40x coarser generalization than the 1:24,000 data every other record was
  measured at, so mixing it in would make `nearestWater` mean two different things inside one
  published field.

⚠️ **`fetchArcGISAll` now fails closed on a truncated page set.** It verifies its paged total against
the service's own `returnCountOnly` total and throws on mismatch, because a page returning HTTP 200
with `features: []` is byte-indistinguishable from genuine end-of-data. Measured: HIFLD reports 10,490
features at `VOLTAGE>=230` and the layer's `maxRecordCount` is 2000 — exactly the page size — so a
single transient empty page would have published ~6,000 of 10,490 (~43% loss) into both
`public/data/power.geojson` and every `nearestTransmission`, with nothing failing. Consequence:
`nearestTransmission` needs no carry-forward, unlike `nearestWater` — a `null` there is now
authoritative, and adding a carry-forward would destroy the ability to ever clear a stale value.

`db:sync` writes `facility_history` for every change (so `/activity` sees it) and busts the cache tags for affected scopes (`facility:<id>`, `state:<XX>`, `operator:<slug>`, ±`power-generation`), plus unconditionally adds the `"facilities"` tag to keep aggregate pages fresh. A notes-only update (only `notes`/`note` text differs, at any depth) is recorded as `editorial`, which /activity, its feed, contributor credits, the quarterly summary and the state digest all exclude; facility watchers are still notified unless `--skip-notify` is passed. It cannot reach the untagged search index (86400s timer only). `db:seed --force` does neither — it is bootstrap-only, kept for filling an empty database.

⚠️ **`--skip-notify` for metadata-only publishes.** A wave that touches many records without changing a single asserted fact (source URL dedupe, coordinate precision corrections, etc.) may use `db:sync -- --apply --skip-notify` to suppress notification. It is **deliberately opt-in and never inferred** — "did this change matter to a human" is a judgement you make, not a heuristic. The flag affects only facility subscribers (`targetType='facility'`); state subscribers never receive transactional mail from `db:sync`, only a monthly digest, so the flag has no effect on them either way. Check `docs/maintainers.md` for the decision criteria.

## Discovery pipeline

A local, scheduled, subscription-powered pipeline (`scripts/discovery/`) that
proposes new facilities and re-checks existing ones for status changes, staging
both as `pending`. It never writes live facilities. Every candidate source URL is
fetched and mechanically verified before staging, using a **local Ollama** model
(`scripts/discovery/verify-source.ts`); the gate is on by default and, if Ollama is
unreachable or `OLLAMA_VERIFY_MODEL` is not pulled, the run **aborts loudly** rather
than staging unverified candidates (`VERIFY_SOURCES_ENABLED=false` is the only
opt-out). A field-extraction lane (`extract-fields.ts` / `verify-fields.ts`) fills missing
structured fields on existing facilities. It runs **on every scheduled `run.sh` run** (after the
discovery and source-liveness lanes) and can also be run by hand; everything it produces still
stages as `pending`. It reads
PDF sources via `pdftotext -layout` and so **requires poppler** — without it every PDF source goes
unread, loudly warned but not fatal. ⛔ Always invoke it with an explicit `--fields` list — and
since 2026-09-11 (#276) `extract-fields.ts` enforces that itself: its own `parseArgs` throws
`--fields is required` when the flag is absent *or* supplies no usable value, because two of the six
extractable fields failed the accuracy bench (`capacityMw.planned` P=75%,
`energy.onSiteGenerationMw` P=50%) and the shortest command must not also be the most dangerous one.
⚠️ The shared `parseFieldsArg` helper it calls **does** still default to all six when `--fields` is
omitted, and that default is deliberate: `verify-fields.ts` imports the same function and relies on
it, being read-only and staging nothing. So the requirement is `extract-fields.ts`-specific, layered
on top — do not "simplify" it into the shared helper. Since 2026-10-29 the scheduled extract lane
pins ONLY `water.coolingType` (P=95%/R=95%, measured 2026-09-01). `capacityMw.operational` was unpinned:
its P=100%/R=100% measured a drifted prompt on a corpus with no distractors (`scripts/discovery/bench/README.md`).
Scheduled-run `verify-fields` still re-checks both. `energy.source` and `energy.utility` remain extractable but are not pinned
(unmeasured). ⚠️ `water.coolingType`'s 95% belongs to the PROMPT, not the field — it is 53%
without the decision rule, which `extract-fields.ts` carries verbatim from `docs/methodology.md#cooling-type`
under a drift test. ⛔ `aiClassification` was benched the same way on 2026-09-12 and is NOT shippable as a
three-value field — P=61%/R=83% with its full decision rule, against P=56%/R=43% with a bare
vocabulary. The rule bought recall, not accuracy (hallucinations rose 5→8), because the `likely`
tier asks whether an indicator is substantive rather than what the page states; 13 `likely`
answers were right 4 times. Dropping that tier helps a lot: the two-value variant
(`aiClassificationStated`, `confirmed`|`mixed_use`) scores **P=85%/R=89%** with hallucinations
down to 2, and `confirmed` alone was answered 14 times and right 14. ⚠️ Do NOT read that as
"ship confirmed-only at 100%" — this corpus has twice shown the model REALLOCATING its errors
onto whichever values remain, so a narrower vocabulary needs its own run. Neither field is an
`ExtractableField`; the lane cannot emit either. Read `scripts/discovery/bench/README.md` before
re-proposing either. The scheduled invocation bakes that list in, and bounds each tool with
`ENRICHMENT_LIMIT` (60) / `VERIFY_LIMIT` (40) — successive runs continue from a per-lane
cursor instead of re-reading the same head of the table; ~10 hours is what one UNBOUNDED
sweep would cost (rescaled from the measured 12h/2,525-gap figure; the 2,190-gap count is
from 2026-09-01 on the old two-field list, and the one-field list is not re-measured), and
an unparseable limit would otherwise disable the bound entirely, so `run.sh` validates both
before use.
The leads lane (`leads-lane.ts`: public URL tips → pending submissions) also runs on every scheduled run in
`run.sh`, after the field-extraction lane, bounded by `LEADS_LIMIT` (default 10).
Architecture and the safety contract: `docs/discovery-pipeline.md`; operator mechanics
(launchd, `ollama pull`, running it by hand): `docs/discovery-runbook.md`. It uses the Claude Code subscription (not the metered
API) and runs via `launchd` on the maintainer's machine Mon-Fri at 13:00 local — treat it as an operator
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

- **Bulk exits are closed (Phase 1, Ed 2026-11-05).** The data stays CC BY 4.0 (all records, future ones too). Protection is ACCESS-only: no bulk download, no bulk API, no per-record JSON. The one sanctioned file route is the approved-access lane below.
  - **Approved-access lane** (dark unless `DATASET_SHARING_ENABLED` is exactly `"true"`, `lib/dataset-flag.ts`). Ed approves each grant by hand in `/admin/access`; access is free (decided 2026-11-09). Each grantee gets per-grant watermarked `facilities.json` and `facilities.csv` from `/api/dataset/file` via a personal link, at most 30 served files per grant in any rolling 24 h (`lib/dataset-download.ts`). Weekly editions come from `/api/cron/dataset-edition` (Friday 14:00 UTC, `vercel.json`). The `/dataset` and `/contact` pages show "Request access" only when the flag is on. Procedures, kill switch and retention: `docs/maintainers.md`, "Approved-access dataset sharing".
  - `/data` is the "Cite & license" page (footer and mobile sheet only, no downloads); `/dataset` is the file offer (header "Dataset"), and the nav groups live in `lib/site-nav.ts`. While the flag is unset, the `/access*` pages render a noindexed "not open yet" page (`app/access/page.tsx`), except the unsubscribe pages, which work with the flag off. The `/access` landing page is static, so a flag change needs a redeploy.
  - The `/api` documentation page redirects to `/data`; nothing on the site or in the README advertises an API (Ed, 2026-11-06).
  - `GET /api/facilities` (list), `GET /api/facilities/{id}` and the full shape of `/api/search` are admin-bearer only and `no-store` (#528, #529). The public palette search (`/api/search?…&shape=palette`) stays.
  - Cloudflare custom rule `d0286981a37e4076ad52eb840601683f` ("Pause bulk dataset exits", Block) uses the 5th of 5 Free-plan custom-rule slots. It blocks `lower(path)` in {`/api/facilities`, `/api/facilities/`, `/data/facilities.csv`, `/data/facilities.json`}, GET/HEAD on `starts_with(lower(path), "/api/facilities/")`, and `/api/search` unless `args["shape"][0] eq "palette"`.
  - ⚠️ Always `lower()` paths in this site's CF rules: the origin matched `/API/facilities/<id>` to the route while a case-sensitive rule let it through.
  - ⚠️ Each CF edit needs Ed's explicit go. The rule also blocks the discovery loader's authenticated `/api/facilities` read, so discovery reads Neon directly via `DISCOVERY_READ_DATABASE_URL`, falling back to the owner `DATABASE_URL` when that is unset.
  - `/map` and `/embed/states/[state]` ship only `MapPoint` (id, facilityType, status, lat/lon rounded to 2 dp, state) plus server-computed filter options. Popup details come from `GET /api/map/facility/[id]`; operator/minMw filters from `GET /api/map/match` (#532). `public/data/hero-points.json` is anonymous, de-duplicated `{lat, lon, status}` at 2 dp (#533). `data/siting-context.json` no longer reaches the client bundle (an import-graph test guards it).
  - `data/facilities.json` is no longer in the repo (gitignored local export; see Data waves). Old commits still serve the frozen 3,025-record open edition.
- **`.env.local` quoting:** `vercel env add` keeps surrounding quotes; a quoted
  `DATABASE_URL` is invalid and fails *silently* (no fallback). Strip quotes.
  Two sibling traps in the same family, both silent:
  - **A new Vercel env var is invisible to already-built deployments.** Vercel
    injects env at deploy time, so `vercel env add` after the deploy leaves the
    running function reading `undefined` until you
    `npx vercel redeploy --target production <url>`. Cost the contact endpoint its
    first real message (2026-09-01): the row stored with `email_sent = false` and
    the send was skipped — correct fail-safe behavior, indistinguishable from a
    code bug until you compare the deployment's age against the variable's.
  - **Appending to `.env.local` needs a trailing-newline check first.** The file
    does not reliably end in one, so a bare `>>` concatenates the new key onto the
    previous value (`EMAIL_FROM=…<addr>CONTACT_TO_EMAIL=…`), corrupting both. Check
    with `tail -c1`, or append a leading `\n`.
- **Builds are gated, production included.** `vercel.json` runs
  `scripts/vercel-ignore-build.sh` as Vercel's Ignored Build Step: **any**
  deployment whose diff touches only `docs/`, `.github/`, `*.md`, `LICENSE` or `LICENSE-DATA` is
  skipped — production too, since `db:sync` puts data live in Neon before any commit is merged.
  No `data/` file is allowlisted (the data files are untracked), so a diff touching `data/` builds.
  Changed paths are listed with `--no-renames`, so a rename of code into `docs/` still builds.
  A production build can be forced with `npx vercel redeploy --target production`. Covered by
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
  - **Aggregate pages** (home/map/stats/explore) read `loadFacilities` with a **24h ISR timer** (`revalidate: 86400`, lowered from 1h on 2026-10-13 to cut ISR Writes) and carry the `"facilities"` tag. Freshness comes from tag busts: `db:sync --apply` busts `"facilities"`, and an approve/reject that leaves the pending queue empty busts it once (`lib/submissions.ts`); single writes bust only scoped tags. Home (which also reads untagged `getRecentActivity`/`getQuarterlyPipelineSummary`), `/activity`, its feed and `/contributors` read untagged direct-DB data and stay on 3600. `/table` is no longer an ISR aggregate page: it is dynamic and server-paginated (50 rows/page; filter, sort and `q` on the server), reading through the 24h-cached `getAllFacilities` loader, so it carries no ISR timer of its own (#531).
  - **Scoped pages**: `/facilities/[slug]` (2,241 routes) carries only scoped tags — `facility:<id>`, `operator:<slug>`, `state:<XX>`, plus `power-generation` where relevant — and no longer carries the global `"facilities"` tag; it declares `export const revalidate = 86400` itself (the root layout no longer reads `loadNavFacets`, so nothing inherits a floor). The per-entity hub pages (`/states/[state]`, `/operators/[operator]`, the metro hubs and `/counties/[county]`: 55 states / 1,018 operators / 27 metros / 847 counties) **do** still carry `"facilities"` on a 86400s timer, so they self-heal daily as well as on a bust. There is no `metro:` or `county:` tag — metro and county hubs are covered by `"facilities"` alone. The index pages `/operators`, `/counties`, `/power`, `/opposition` and `/stakeholders` (not the per-entity hubs above), plus the five `/status/[status]` pages (Wave 8: top 48 by default, `?state=xx` for the full list), are the exception: they read `searchParams`, so they are dynamic, read through the 24 h-cached loader like `/table`, and carry no ISR timer of their own.
    ⚠️ Those five figures are a **snapshot, not a constant** — read from the production build log of `6515815` on **2026-09-28** (4,330 prerendered routes in total; `npm run check:drift` (a check since retired) confirmed JSON and Neon agreed at 2,241 facilities that day). Every data wave grows them. Re-read a real build log before citing any of them; do not trust the numbers on this line.
  - **Search index** (global ⌘K palette: operator/state facets via `loadNavFacets`, fetched lazily on first open from `GET /api/nav-index`, cached at the edge `s-maxage=86400`; no longer in any page's HTML or the root layout) has **two untagged staleness layers**: the 24h `unstable_cache` on `loadNavFacets`, then the edge `s-maxage=86400` + `stale-while-revalidate=604800` on `/api/nav-index`. A new operator or state can take up to ~2 days to appear (24h origin + 24h edge, worst case); SWR adds at most one stale response after edge expiry. No tag bust affects it; `db:sync --apply` cannot refresh it. The root layout reads no cached data (`SiteFooter` uses the static `facilities.meta.json`), so no route inherits a floor from it.
  
  Pages inherit the longest timer from any reader in their render tree; the tag-only detail/state/embed-state pages declare `revalidate = 86400` explicitly. The tag vocabulary (`facility:<id>`, `state:<XX>`, `operator:<slug>`, `power-generation`, `facilities`) is centralized in `lib/cache-tags.ts` and shared by `lib/facility-write.ts` and `POST /api/revalidate` so producer and validator can't drift apart. `db:sync --apply` and the approve-on-prod path bust affected tags for you. Only a **raw** Neon write (`db:seed --force`, an ad-hoc upsert) leaves them un-busted — then hit the admin-bearer `POST /api/revalidate` yourself with the affected tags (e.g. `{"tags":["facilities","state:CA"]}`); brand-new facility ids need no bust (cache-miss populates them).
- **A fourth cache surface, and it is a security boundary (audit s169, 2026-09-27).** A Cloudflare
  **cache rule** makes **every GET whose path does not start with `/admin`** eligible for the edge
  cache (`http_request_cache_settings`, `cache: true`, `edge_ttl: respect_origin`). That includes
  every `/api/*` route, the bearer-gated ones included. Two consequences that are easy to get wrong:
  - **`jsonResponse()` is `no-store` by default** (`lib/api-response.ts`) and must stay that way. It
    serves authenticated bodies (`GET /api/submissions` returns every staged row), writes, error
    bodies and 429s. Before this default, Cloudflare supplied `public, max-age=14400` to those
    responses, because the origin sent no directive. It sets **both** `Cache-Control` and
    `CDN-Cache-Control` (Cloudflare evaluates the latter first), placed *before* the `init.headers`
    spread so a caller can still override deliberately. **Public reads are unaffected** — they use the
    separate `cacheableJson()` helper, which is the only opt-in cacheable path.
    ⚠️ Cloudflare's `Authorization`-header protection does **not** save you here: on Free/Pro/Business
    it declines to store an authenticated response only when `Cache-Control` lacks `public`,
    `s-maxage` **and** `must-revalidate` — and Next's dynamic-route default carries two of the three.
    Verified by probe: `cf-cache-status` read `MISS`/`EXPIRED`, never `BYPASS`.
  - **A mutating or token-bearing GET must opt out explicitly.** `/api/cron/state-digest` is a
    mutating GET; the `?token=` confirm/unsubscribe/access routes put single-use tokens in the cache
    key. All emit `no-store`. Do not add a new GET under `/api/` without deciding this.
- **Cloudflare is bypassable at the origin, so its rules are not a control (audit s169).** The proxied
  A record's content is Vercel's anycast IP `76.76.21.21`, and Vercel routes by SNI/Host — so
  `curl --resolve 'www.compute-atlas.com:443:76.76.21.21'` reaches the origin directly and skips the
  WAF UA blocks, the 100 GET/10s rate limit, the country block, the edge cache and the managed DDoS
  ruleset. Authorization is unaffected (all origin-side). **Never treat a Cloudflare WAF rule as a
  bandwidth or abuse control** — it enforces intent against compliant clients and is decorative
  against anyone who tries. `proxy.ts` enforces a Cloudflare-injected shared-secret header to close
  this; it has been **fail-closed on production since 2026-10-15** (unsetting `EDGE_SHARED_SECRET`
  403s `/admin`, `/api` except cron, `/map`, `/data`, `/table`, `/facilities/*` and `/embed/*`;
  rotation procedure in `docs/maintainers.md` §9), and `/api/cron/*` is exempt because Vercel Cron
  may reach the deployment without traversing Cloudflare.
- **`app/robots.ts` is the source of truth for blocked crawlers; the Cloudflare rules are a second
  copy.** Posture (Ed, 2026-10-15; supersedes 2026-10-14's "block AI agents incl. retrieval"; amended
  2026-11-09): **allow classic SEARCH engines (Googlebot, Bingbot, DuckDuckBot), archives
  (archive.org_bot), AI assistants (Claude-User, Perplexity-User), AI search
  crawlers and indexers (PerplexityBot, Claude-SearchBot, ExaSearchBot, Amzn-SearchBot) and AI search
  assist (DuckAssistBot); block AI training crawlers, bulk dataset extractors and SEO-resale
  crawlers.** `Google-Extended` stays allowed. **2026-11-09 amendment (Ed: "block them - i dont
  support those companies"): ChatGPT-User, OAI-SearchBot (OpenAI) and plain Applebot (Apple) are
  blocked** (`BLOCKED_BY_EDITORIAL_CHOICE`, a company choice, not a training-crawler
  classification; expected consequences (reasoned, not measured): no Siri/Spotlight surfacing via Applebot, and no ChatGPT retrieval or search citation). Also 2026-11-09 (Ed: "block them"):
  Baiduspider, Manus-User, meta-externalfetcher, MistralAI-User and Terracotta are blocked in robots.txt
  (`BLOCKED_TO_MIRROR_EDGE`) only so robots.txt agrees with the edge, which already 403ed them (live probe 2026-11-09 23:55Z: all five 403). Arquivo-web-crawler joined that list later on 2026-11-09 (Ed: block) after the edge rule changed at v289 (2026-11-10 00:09Z; cause not confirmed) and re-included it. Counts, each labelled with its side: **`app/robots.ts` = 14 `BLOCKED_AI_CRAWLERS`
  + 4 `BLOCKED_BULK_EXTRACTORS` + 4 `BLOCKED_SEO_CRAWLERS` + 3 `BLOCKED_BY_EDITORIAL_CHOICE` + 6
  `BLOCKED_TO_MIRROR_EDGE` = 31 tokens**; **Cloudflare (MEASURED via the API 2026-11-10 ~00:45Z,
  ruleset v289) = a 23-UA AI Crawl Control rule matched by `http.user_agent contains` + a "Block bulk
  dataset extractors" custom rule of 8 UAs (4 extractors + the 4 SEO crawlers).**
  `lib/cloudflare-waf-parity.test.ts` records the 23.
  Because the match is `contains "Applebot"`, the edge also blocks `Applebot-Extended`, so it is no
  longer robots-only. The only edge-only entry robots.txt does not carry is Anchor Browser (a browser
  product with no robots token).
  The custom rule also blocks HTTP-library UAs (python-requests, curl/, etc.) on `/facilities/*` and
  `/table` since 2026-11-09; those are not robots tokens. `Arquivo-web-crawler` (arquivo.pt, Portugal's
  national web archive) is blocked on both sides since 2026-11-09 (Ed); it had been allowed as an archive until the edge rule changed at v289 (2026-11-10 00:09Z; cause not confirmed) and re-included it. The AI Crawl Control rule is READABLE via the rulesets API,
  but its per-crawler toggles are dashboard-only and every toggle save regenerates the rule,
  overwriting manual edits. The four SEO crawlers were FOUND missing from it on 2026-10-14; the
  actual drop date is unknown (some dashboard save after 2026-09-27). They now live in the custom
  bulk rule. `Content-Signal` is `search=yes,ai-input=yes,ai-train=no`. The sides are only partly
  reconciled by tooling (`lib/cloudflare-waf-parity.test.ts` checks the repo against a hand-recorded
  ledger, not the live edge) -- re-measure both before citing either; the Cloudflare side is
  out-of-repo, so only a live read confirms it. A UA blocked at the edge but not disallowed in
  `robots.txt` is worse than useless — a compliant crawler reads `Allow: /`, gets a 403, and retries.
- **Every caught DB error logs a SQLSTATE only, via `redactedErrorCode` from `lib/db-error.ts`.**
  Drizzle's `DrizzleQueryError.message` is `Failed query: … params: …`, so logging the error
  **object** puts bound parameters (an IP hash, a subscriber email, a raw bearer token) into Vercel
  Runtime Logs. There is exactly **one** implementation — do not fork a private copy; three existed
  before 2026-09-27 and diverged. ⚠️ Its code check accepts any identifier-shaped code
  (`/^[A-Z0-9_]{2,40}$/`) and returns `"unknown"` otherwise; the identifier shape is what keeps a
  crafted `code` from carrying data. A strict 5-character `/^[0-9A-Z]{5}$/` SQLSTATE regex is still
  **wrong**: it would regress the neon-http driver and discard `ENOTFOUND`/`ECONNREFUSED`, and
  `ENOTFOUND` is this project's outage-vs-link-rot discriminator.
  ⚠️ A regex is the wrong tool for finding these sites: `[^)]*` breaks on a `)` inside a format string
  and an end-of-line anchor misses a multi-line call. Both happened; use a paren-balanced scan.
- **Neon is truth, and `db:sync` is the only bulk write path.**
  `db:sync` applies adds *and* updates, writes history, busts tags, and refuses to
  overwrite a Neon row that moved ahead of the snapshot's basis (`facilities.meta.json`'s
  `asOf`) — so it can't clobber a prod approval. `db:seed --force` publishes adds but
  **silently drops every correction to an existing row, writes no history, and busts
  no tags** — it is bootstrap-only.
- **Local-only docs:** some maintainer notes under `docs/` are gitignored working
  files — check `.gitignore` before adding a doc, and never commit those.
- **Dev server:** don't run `next build`/`start` while `next dev` is live (it
  corrupts `.next`); a long-running dev server can also serve stale `globals.css`.
  A restart does **not** clear `.next/cache`, so a "fresh" server can replay an
  ISR-cached page from before the last data publish — that looks exactly like
  a stale data snapshot but isn't (comparing data cannot see a stale
  *render*). `rm -rf .next/cache` and re-fetch before concluding anything.
- **JSX drops a leading space when the text chunk contains an HTML entity.** If a
  text chunk *follows an interpolation* `{...}` **and** contains `&apos;`,
  `&rsquo;`, `&middot;` etc., its leading space is silently dropped and two words
  render joined — `tracks {stats.count} dedicated-…` became "tracks
  79dedicated-…" live on prod. The source looks correct (`od -c` shows a normal
  `0x20`), so this is **invisible in review**; it only shows in rendered HTML,
  where React's `<!-- -->` separator sits directly between two word characters.
  Fix with an explicit `{" "}` after the interpolation — **not** by replacing the
  entity, which `react/no-unescaped-entities` forbids for `'`. Guarded by
  `e2e/prose-spacing.spec.ts`, which scans raw SSR HTML (never a hydrated DOM —
  hydration removes the `<!-- -->` markers and the check would silently always
  pass) across 23 routes including one per dynamic template (counted
  2026-09-28 from that spec's `ROUTES` array — parse it, don't grep it: the
  array is interleaved with comments that defeat a naive line count).
- **Static-asset edge cache:** `/data/:path*` and `/basemap/:path*` carry `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800` (edge cache up to 1 day plus 7 days stale reuse); `/fonts/:path*` are immutable. After `npm run build:mapdata`, regenerated geojson rides the edge cache for up to 24 hours — if a correction must go live immediately, purge Cloudflare.
  ⛔ **Prefix purge is Enterprise-only and purge-by-URL silently does nothing here** — measured
  2026-09-12: posting the exact URLs to `/zones/<id>/purge_cache` returned `success: true` while the
  entry kept serving with a climbing `age`. Only `{ purge_everything: true }` evicts. A 200 from
  purge_cache is NOT evidence of eviction; verify with `age: 0` / `cf-cache-status: MISS` and the
  actual body. Before Phase 1 the public read API was cached by Cloudflare for **4h**
  (`cache-control: public, max-age=14400`), NOT the 1h `READ_CACHE.list` asks for. Since 2026-11-05
  `GET /api/facilities` is admin-bearer only, `no-store`, and CF-blocked (see the Gotchas bullet
  "Bulk exits are closed"), so it no longer serves a stale count and needs no purge in a wave. The
  4h figure is a pre-Phase-1 measurement; re-measure before citing it for any other route. ⚠️ Probe with a real **GET**: a `curl -I` HEAD reported
  `cf-cache-status: DYNAMIC` on the very response a GET showed as a `HIT`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

⚠️ **The bundled docs can be wrong — verify behaviour, not prose.** While adding the edge check to
`proxy.ts` (audit s169, 2026-09-27), `node_modules/next/dist/docs/.../proxy.md` stated that a literal
matcher source prefix-matches (`/about` also matching `/about/team`). Compiling the real matcher array
with the installed Next's own `getMiddlewareMatchers` showed otherwise: `/data` matches **only**
`/data`, never `/data/facilities.geojson`. Had the doc been trusted, every static geojson request would
have been pulled through the proxy. Bare `/admin` **is** matched by `/admin/:path*`, which is why the
admin arm tests `pathname === "/admin"` explicitly. The measurement and how to re-run it are recorded
in `proxy.ts`. So: read the bundled guide to learn what exists, then **measure the behaviour you are
going to depend on.**

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
