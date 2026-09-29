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
npm run db:sync -- --apply --skip-notify   # publish without emailing facility subscribers
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

**CI:** eight workflows live in `.github/workflows/` (as of 2026-09-28:
`automation-health`, `ci`, `codeql`, `discovery-watchdog`, `drift-alert`,
`googlebot-canary`, `neon-sync`, `release-please`). `ci.yml` is the PR gate and
runs three jobs — `typecheck · lint · test` (tsc, eslint, vitest), `BATS tests`
(the discovery, vercel ignore-gate and drift-classifier shell suites), and
`Playwright e2e` (a11y + e2e). CodeQL scans on every PR and push to `main` plus
weekly. The Vercel preview build is an additional gate.

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
  + lens pages (`states`/`operators`/`power`/`opposition`/`status`/`metros`/`counties`,
  incl. `[state]`/`[operator]`/`[status]`/`[metro]`/`[county]` hubs) ·
  `app/facilities/[slug]` · `app/contribute` · `app/activity` · `app/admin/*` ·
  `app/api/*`.

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
  It also accepts one field that never reaches a facility: an optional `notifyEmail`
  ("email me when this is reviewed"), gated entirely on `SUBMISSION_NOTIFY_ENABLED`, which is
  **`true` in production since 2026-09-14** (Ed's decision; it shipped disabled and stayed
  that way for weeks). Unsetting the var is still the kill switch and needs no deploy. It is
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
  not block re-insertion; durable suppression is a known gap, tracked for a separate session.
- **Admin/pipeline writes** require a bearer token, but not all the same one.
  `POST /api/submissions` — staging only — accepts EITHER `API_INTAKE_TOKEN` or
  `API_ADMIN_TOKEN` (`requireIntake`), so the discovery pipeline can stage a
  `pending` row without holding a secret that could publish one. `GET
  /api/submissions` and approve/reject require `API_ADMIN_TOKEN`. Do not widen
  `requireIntake` past that one handler. The admin pages use a lightweight
  single-secret cookie gate — there is intentionally **no user-account system**
  (durable product decision).
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

Forgetting it is now caught rather than discovered later: `lib/siting-context.test.ts` asserts
every id in `data/facilities.json` has an entry in `data/siting-context.json`, so a wave that
skips `build:mapdata` turns the required `typecheck · lint · test` check red instead of shipping
silently. This covers the **manual** path specifically — `neon-sync.yml`'s additive guard only
ever ran inside the automated workflow, so a maintainer syncing by hand bypassed it entirely.
The reverse direction is deliberately NOT asserted: retiring a facility needs a raw Neon delete
and legitimately leaves a stale siting entry behind. That orphan survives `--skip-nhd` runs (which
union in every existing id) but is pruned by the next full or `--backfill-nhd` run, whose id set is
facilities + computed results only. `check-siting-additive.mjs` then reports it as `removed: 1` and
exits 1 — confirm the id is absent from `data/facilities.json` before accepting that as a prune
rather than a loss (first seen 2026-09-29: `galaxy-helios-dickens-tx`, retired in #352).

⚠️ **The ONE sanctioned `--skip-nhd` exception, and its price** (2026-09-22). When USGS NHD is
*degraded rather than down*, the full pass neither finishes nor aborts: `build-map-data.mjs`'s
`NHD_CONSECUTIVE_FAILURE_BUDGET = 10` counts **failures** and is blind to **latency**, so 200-OK
responses arriving 30x slow keep it grinding (measured 473ms..14.5s on identical queries; the run
was cancelled at 2h05m against a 6h job cap).
In that case publish in two stages: (1) `build:mapdata -- --skip-nhd` now — that branch seeds every
id and merges `{...existing[id], ...envContext[id]}`, so it is *structurally* additive and new
records still get waterStress/aquifer/groundwaterDecline; (2) `build:mapdata -- --backfill-nhd` once
NHD is healthy — it restricts the NHD pass to only the facilities whose existing
`data/siting-context.json` entry lacks `nearestWater` (201 on 2026-09-29, not a full 2,268-record re-pass) and
carries every other entry forward untouched. `--skip-nhd` and `--backfill-nhd` are mutually exclusive
and error out together.

⚠️ **CORRECTION (2026-09-29): the "finishing would not have helped" claim formerly in this section was
false, and the false claim was expensive.** It read: *"the full path rebuilds `computeSitingContext`
from scratch and never merges the existing file, so scattered timeouts null `nearestWater` on EXISTING
records and the additive guard discards everything."* Verified false in source: `resolveNearestWater`
**carries a prior `nearestWater` forward** on every unconfirmed/partial/total NHD failure — its gate
is `absenceConfirmed !== true`. Only a genuinely confirmed absence (both NHD layers answered and found
nothing) clears an existing value, and that's deliberate: it's what lets a corrected coordinate clear
stale data. The false warning made a full run look destructive, so it was avoided for **seven
consecutive data waves** while the debt grew (141 → 155 → 158 → 177) — a false deterrent costs more
than a false assertion, because nothing ever tests the action you didn't take. Note: `mergeSitingContextEntry`
takes an explicit `nhdRan` flag rather than inferring it, because `resolveNearestWater` signals "clear
this stale value" by *omitting* the key, and an object spread cannot delete an omitted key — an
unconditional existing-first merge would make a confirmed absence unable to ever clear a stale value on
the default full-run path. That was a real regression, caught in review on this branch. The full path
remains the right tool for exactly one case: re-querying a facility whose coordinates were corrected,
because only it can *clear* a stale value — `--backfill-nhd` only fills gaps, it never re-checks a
facility that already has an entry.

⛔ **Stage 2 is not test-covered by an entry-shape check** — `siting-context.test.ts` asserts an ENTRY
exists, not that it carries NHD fields — but the outstanding count is now covered by a separate
mutation-tested ratchet (`NHD_BACKFILL_DEBT_CEILING`, 0 since the 2026-09-29 stage-2 run) that fails if the debt grows *or*
silently shrinks. Track the raw count explicitly and verify with
```bash
python3 -c "
import json
s=json.load(open('data/siting-context.json'))
f={x['id']:x for x in json.load(open('data/facilities.json'))}
off={'HI','AK','GU','MP','PR','VI'}
print(sum(1 for i,v in s.items() if 'nearestWater' not in v
          and f.get(i,{}).get('location',{}).get('state') not in off))"
```
Stage 2 ran on 2026-09-29 and took it **177 → 0** in ~5 min (NHD healthy). Expect **0**; anything
higher is a `--skip-nhd` wave's new debt, and the ratchet will fail on it. ⚠️ The non-CONUS exclusion is REQUIRED: 24 facilities
(AK 9 · HI 6 · GU 4 · MP 2 · PR 2 · VI 1) legitimately have no NHD match because NHD is CONUS-only,
so an unscoped count reads 201 and can never reach 0.
Do NOT treat this as general permission to
use `--skip-nhd` on a wave — the paragraph above is still the rule.

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

Why it matters: the site reads Neon live, so data never needed a build. Editing the
file and shipping it through git made every correction a Vercel deploy, and left
drift (`check:drift`, the `neon-sync` workflow) to be detected and repaired
afterwards. Syncing first makes drift structurally impossible instead, and
`check:drift` becomes a true invariant that should always pass.

`db:sync` writes `facility_history` for every change (so `/activity` sees it) and busts the cache tags for affected scopes (`facility:<id>`, `state:<XX>`, `operator:<slug>`, ±`power-generation`), plus unconditionally adds the `"facilities"` tag to keep aggregate pages fresh. It cannot reach the untagged search index (86400s timer only). `db:seed --force` does neither — it is bootstrap-only, kept for filling an empty database.

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
structured fields on existing facilities. It runs **nightly as part of `run.sh`** (after the
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
on top — do not "simplify" it into the shared helper. Both pinned fields
are bench-measured: `capacityMw.operational` (P=100%/R=100%) and `water.coolingType` (P=95%/R=95%,
measured 2026-09-01). `energy.source` and `energy.utility` remain extractable but are not pinned
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
`ENRICHMENT_LIMIT` (60) / `VERIFY_LIMIT` (40) — a full sweep is ~10 hours (rescaled from the
measured 12h/2,525-gap figure now that the pinned list totals 2,190 gaps, measured 2026-09-01), and an unparseable
limit would otherwise disable the bound entirely, so `run.sh` validates both before use.
Architecture and the safety contract: `docs/discovery-pipeline.md`; operator mechanics
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
  - **Scoped pages**: `/facilities/[slug]` (2,241 routes) carries only scoped tags — `facility:<id>`, `operator:<slug>`, `state:<XX>`, plus `power-generation` where relevant — and no longer carries the global `"facilities"` tag; it floors at 86400s inherited from the root layout. The jurisdiction/operator/metro/county hubs (55 states / 1,018 operators / 27 metros / 847 counties, the county hubs behind a `/counties` index) **do** still carry `"facilities"` on a 3600s timer, so they self-heal hourly as well as on a bust. There is no `metro:` or `county:` tag — metro and county hubs are covered by `"facilities"` alone.
    ⚠️ Those five figures are a **snapshot, not a constant** — read from the production build log of `6515815` on **2026-09-28** (4,330 prerendered routes in total; `npm run check:drift` confirmed JSON and Neon agreed at 2,241 facilities that day). Every data wave grows them. Re-read a real build log before citing any of them; do not trust the numbers on this line.
  - **Search index** (global ⌘K palette via `loadFacilitiesForSearch` in root layout) is **24h untagged timer only** — no tag bust affects it; `db:sync --apply` cannot refresh it.
  
  All pages inherit the longest timer from any reader in their render tree (typically 24h from the root layout). The tag vocabulary (`facility:<id>`, `state:<XX>`, `operator:<slug>`, `power-generation`, `facilities`) is centralized in `lib/cache-tags.ts` and shared by `lib/facility-write.ts` and `POST /api/revalidate` so producer and validator can't drift apart. `db:sync --apply` and the approve-on-prod path bust affected tags for you. Only a **raw** Neon write (`db:seed --force`, an ad-hoc upsert) leaves them un-busted — then hit the admin-bearer `POST /api/revalidate` yourself with the affected tags (e.g. `{"tags":["facilities","state:CA"]}`); brand-new facility ids need no bust (cache-miss populates them).
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
  this; it is deliberately **fail-open while `EDGE_SHARED_SECRET` is unset**, and `/api/cron/*` is
  exempt because Vercel Cron may reach the deployment without traversing Cloudflare.
- **`app/robots.ts` is the source of truth for blocked crawlers; the Cloudflare WAF rule is a second
  copy.** Counts, each labelled with its side and dated because they drift independently (measured
  2026-09-27): **`app/robots.ts` = 8 `BLOCKED_AI_CRAWLERS` + 4 `BLOCKED_SEO_CRAWLERS` = 12 tokens**;
  the **Cloudflare WAF rule = 18 UAs, now 14** after this audit removed four. The two sides have never
  been equal and nothing reconciles them — re-measure both before citing either. The WAF side is
  out-of-repo, so only a live API read can confirm it.
  The drift was not just numeric: the WAF was *inverted*: it 403'd `Perplexity-User` /
  `Manus-User` / `MistralAI-User` — the vendors' markers for a **human-initiated** fetch — while
  letting `PerplexityBot` (the indexing crawler) through, and blocked `Baiduspider`, a **search**
  engine, on a site whose binding constraint is crawl budget. Corrected 2026-09-27 (those four removed
  from the WAF rule, taking it 18 → 14; `app/robots.ts` was not changed). **The posture is: block
  TRAINING, allow RETRIEVAL and SEARCH.** A UA blocked at
  the edge but not disallowed in `robots.txt` is worse than useless — a compliant crawler reads
  `Allow: /`, gets a 403, and retries.
- **Every caught DB error logs a SQLSTATE only, via `redactedErrorCode` from `lib/db-error.ts`.**
  Drizzle's `DrizzleQueryError.message` is `Failed query: … params: …`, so logging the error
  **object** puts bound parameters (an IP hash, a subscriber email, a raw bearer token) into Vercel
  Runtime Logs. There is exactly **one** implementation — do not fork a private copy; three existed
  before 2026-09-27 and diverged. ⚠️ Its permissive `typeof code === "string"` check is **deliberate**:
  a strict `/^[0-9A-Z]{5}$/` SQLSTATE regex would regress the neon-http driver and discard
  `ENOTFOUND`/`ECONNREFUSED`, and `ENOTFOUND` is this project's outage-vs-link-rot discriminator.
  ⚠️ A regex is the wrong tool for finding these sites: `[^)]*` breaks on a `)` inside a format string
  and an end-of-line anchor misses a multi-line call. Both happened; use a paren-balanced scan.
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
  A restart does **not** clear `.next/cache`, so a "fresh" server can replay an
  ISR-cached page from before the last data publish — that looks exactly like
  JSON↔Neon drift but isn't (`check:drift` compares data and cannot see a stale
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
  actual body. Also note the public read API is cached by Cloudflare for **4h**
  (`cache-control: public, max-age=14400`), NOT the 1h `READ_CACHE.list` asks for, so after a publish
  `/api/facilities` can serve a stale count for hours while home and `/data` are already correct —
  purge it as part of the wave. ⚠️ Probe with a real **GET**: a `curl -I` HEAD reported
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
