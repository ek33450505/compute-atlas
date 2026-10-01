# SEO soak: sitemap index split — pre-registration (2026-09)

Pre-registered BEFORE the change ships to production, per the
`seo-index-census` skill's rule that a before/after measurement needs a
soak window committed in advance — writing this after the fact would not
count as pre-registration.

## What changed

`/sitemap.xml` becomes a sitemap INDEX over nine per-family children
(`/sitemaps/<family>.xml`) instead of one flat `<urlset>`.

**Pre-change baseline (the *before* state this soak measures against).**
Verified live against production on 2026-09-25, while the sitemap-split
commits were still on `feature/seo-index-census` only:
`https://www.compute-atlas.com/sitemap.xml` returned HTTP 200, root element
`<urlset>`, **2,997** `<loc>` entries.

**Post-change state — this shipped on 2026-09-26, day 1 of the window.**
Merged to `main` as #349 (`15cd17c`, "Segment the sitemap by route family and
add an index-coverage census"), so the split is live for the whole soak
window. Re-verified live on 2026-09-28: `/sitemap.xml` returns a
`<sitemapindex>` with **9** `<sitemap>` children and **0** flat `<url>`
entries.

```bash
curl -s https://www.compute-atlas.com/sitemap.xml -o /tmp/sm.xml
grep -c '<sitemap>' /tmp/sm.xml   # 9
grep -c '<url>'     /tmp/sm.xml   # 0
for f in $(grep -o '<loc>[^<]*sitemaps/[^<]*</loc>' /tmp/sm.xml \
             | sed 's|<loc>||;s|</loc>||'); do
  echo "$(basename "$f" .xml) $(curl -s "$f" | grep -c '<loc>')"
done
```

Per-family URL counts from that last loop, 2026-09-28: static 22 · learn 7 ·
states 55 · operators 233 · stakeholders 9 · **facilities 2,249** · status 6 ·
metros 28 · counties 396 — 3,005 total.

GSC reports index coverage PER SITEMAP. Under the old flat sitemap, "which
route family is unindexed?" was unanswerable — every family's URLs were
lumped into one coverage report. The hypothesis under test: splitting the
sitemap lets each family's real coverage surface independently, and if
facilities (the largest, most crawl-budget-constrained family) shows
meaningfully worse coverage than the small families, the split makes that
visible in a way it never could be before.

## Window

- **Opens:** 2026-09-26
- **Closes:** 2026-10-10 (14 days — the skill's stated minimum soak)
- **Earliest valid read:** 2026-10-13 (GSC data lags 2-3 days behind real
  crawl/index activity — pulling on 2026-10-10 itself would read an
  incomplete tail)

## Pre-change GSC baseline

- **28 days to 2026-09-25:** 494 clicks / 47,914 impressions
- **Last 7 complete days (2026-09-18 → 2026-09-24):** 218 clicks / 13,863
  impressions

The trailing 2-3 days of any GSC pull are incomplete and must be excluded
from both the baseline above and any post-soak read — this is why the
last-7-days figure stops at 2026-09-24, not 2026-09-25.

## The falsifiable test for the whole plan

After the soak window closes and the earliest-valid-read date has passed, GSC
must show **per-sitemap coverage differing measurably between families** —
that difference is the entire reason for the split (see "What changed"
above).

**If every family reports the same indexed ratio, the hub-sink hypothesis is
wrong, and the thin-hub triage unit must be DROPPED, not pursued.** This is
stated plainly so a null result cannot quietly get reinterpreted as "not
enough data yet": the split either reveals per-family variation or it
doesn't, and a flat result across all nine families is a real answer, not a
non-result.

## Named confounds

Any of the following occurring inside the soak window gives observed
movement more than one candidate cause, and must be checked and ruled out
(or explicitly named as a confound) before attributing any change to the
sitemap split:

- A concurrent data wave (`npm run db:sync -- --apply`) that adds, removes,
  or meaningfully edits facilities — that changes content, not just sitemap
  shape.
- An internal-linking change (nav, related-facility links, hub pages) —
  changes crawl paths independently of the sitemap.
- A content edit to page templates or copy at a scale that could plausibly
  affect indexing signals (e.g. thin-content fixes, canonical changes).
- Any change to `robots.txt`, the sitemap-generation code, or Cloudflare
  rules affecting Googlebot access during the window — this property has
  had a real Cloudflare/Googlebot access incident before (see
  `npm run check:googlebot`); rule it out explicitly, don't assume it away.

If any of these occur during 2026-09-26 → 2026-10-10, record them here
before drawing conclusions from the 2026-10-13 read. The log below is that
record.

## Confound log

**Recorded 2026-09-28; extended 2026-09-29 (through `1099e79`), 2026-09-30 (Bartow County data correction; CT/CO wave, #372) and 2026-10-01 (footer portfolio link; DE/DC wave, #374).** Those are the dates this section was written, not the
date of any entry — each entry carries its own date. The window is still open
(closes 2026-10-10), so this log is **incomplete** and must be appended to as
further events land.

Each entry names the confound category from the list above that it falls
under, and is marked **OCCURRED** or **RULED OUT**. Where a count is given,
the command that produces it is given with it.

Repo-side entries are reproducible with:

```bash
git --no-pager log --since=2026-09-26 --first-parent main --format='%h %ad %s' --date=short
git --no-pager show --stat --format='' <sha>
```

### OCCURRED

**2026-09-27 — #351 `f0f8601`, "Fix the contribution funnel's measured leaks"**
Categories: *internal-linking change* **and** *content edit to page templates*
**and** *robots.txt* (surface only — see the qualifier).

- Added `components/contribute/source-correction-note.tsx`, rendered
  unconditionally on `app/facilities/[slug]/page.tsx` and
  `app/counties/[county]/page.tsx`. It is server-rendered prose containing a
  new internal `<Link href="/contribute">`, so it is simultaneously a copy
  change and a new internal link on **2,249 facility pages and 396 county
  hubs** (counts from the per-family loop above, same date).
- `app/robots.ts` changed, but **no `Allow`/`Disallow` rule and no user-agent
  was added, removed or altered**. The change adds two `other` entries keyed
  `# Bulk data` and `# Licence`, which every robots.txt parser discards as
  comments. Verify: `git --no-pager diff f0f8601~1 f0f8601 -- app/robots.ts`.
  Touches the named surface; does not change crawler access.

**2026-09-27 — #352 `8245797`, "Dedupe the Helios campus, and block four resale SEO crawlers"**
Categories: *concurrent data wave* **and** *robots.txt* — two named categories
at once — **plus an unlisted one** (see the third bullet).

- `data/facilities.json` + `data/facilities.meta.json` changed: a data wave.
- `app/robots.ts` gained `BLOCKED_SEO_CRAWLERS` — `DataForSeoBot`, `dotbot`,
  `QlyzeBot`, `SERankingBacklinksBot` — each with `Disallow: /`. This **is** a
  real crawler-access change, unlike #351's. None of the four is Googlebot or
  bingbot.
- `next.config.ts` gained a `permanent: true` 301 from
  `/facilities/galaxy-helios-dickens-tx` to
  `/facilities/galaxy-helios-dickens-county-tx` (the Helios dedupe). **A URL
  left the `facilities` sitemap mid-window.** Route retirement is *not* in the
  named-confounds list above, and it bears directly on per-family coverage of
  the largest family — see "Gaps in the pre-registered list".

**2026-09-27 — Cloudflare WAF user-agent rule, 18 → 14 UAs**
Category: *Cloudflare rules affecting Googlebot access*. Out-of-repo.

- The change itself is **reported, not re-measured here.** It is corroborated
  in-repo by `CLAUDE.md` (measured 2026-09-27, four UAs removed), but the rule
  lives behind the Cloudflare API and this log did not read it. Anyone relying
  on the 18 → 14 figure should re-read the live rule.
- What *was* verified live on 2026-09-28, and is the part that matters for
  this soak: **Googlebot, bingbot and an ordinary Chrome UA all returned
  HTTP 200**, on both `/` and a real facility page.

  ```bash
  for ua in \
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" \
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" \
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"; do
    curl -s -o /dev/null -w "%{http_code} ${ua:0:30}\n" -A "$ua" \
      https://www.compute-atlas.com/facilities/123net-dc1-southfield-mi
  done
  ```

- ⚠️ **Qualifier — this rules out a blanket block, not every access effect.**
  Three 200s at one moment say nothing about rate-limiting, intermittent
  challenges, or behaviour at crawl volume. `npm run check:googlebot` is the
  standing check; note the canary it backs has never actually been armed (see
  the memory on the Googlebot canary before treating its greens as evidence).

**2026-09-26 → 2026-09-28 — discovery pipeline produced nothing for the window's first three days**
Category: **none of the named four.** This is a confound in the *opposite*
direction — a suppression of the data-wave category rather than an instance of
it — and it is the least obvious entry here.

- Measured from `discovery-logs/launchd.out`: every state attempted on
  2026-09-26, 2026-09-27 and the morning of 2026-09-28 failed with "no
  parseable candidate array" — WI, IN (09-26 13:30); OK, WY (09-27 15:30);
  NM, LA (09-28 13:27). The first clean run of the window is
  `[2026-09-28T15:17:02-0400] discovery run OK — no failures`.

  ```bash
  grep -nE 'FAIL: discovery run|discovery run OK' \
    discovery-logs/launchd.out | tail -10
  ```

- `discovery-logs/launchd.err` additionally shows
  `timeout: failed to run command 'claude': No such file or directory` (4
  occurrences — the launchd PATH problem) and a `VerificationGateUnavailableError`
  abort (the Ollama source-verification gate failing closed, which is correct
  behaviour: it refuses to stage unverified candidates).
- ⚠️ **Cause vs. effect — both halves are measured, but from different
  artifacts.** The *effect* (three days of no staged candidates) is measured
  above. Both *causes* are measured too; the OAuth one just is not in the logs,
  which is why an earlier draft of this entry called it unconfirmed:
  - **09-28, `claude` off the launchd PATH** — `timeout: failed to run command
    'claude': No such file or directory` appears verbatim ×4 in
    `discovery-logs/launchd.err`.
  - **09-26/27, expired OAuth** — `grep -c "OAuth session expired"` returns **0**
    for both `launchd.err` and `launchd.out`. The string is the entire 73-byte
    *content* of the candidate files themselves, in exactly the four states that
    failed on those two days:
    `grep -l "OAuth session expired" discovery-logs/candidates-2026092*.json`
    → `…20260926T130004-WI`, `…20260926T130012-IN`, `…20260927T130104-OK`,
    `…20260927T131733-WY`. The pipeline wrote the auth error where candidates
    should have been.
- Effect on the soak: new-URL supply was flat for **3 of the window's 14
  days**.

**2026-09-28 — 8 facilities approved and published; #359 `2a2be74`**
Category: *concurrent data wave*.

- `data/facilities.meta.json` `recordCount` went 2241 → 2249 (+8): 5 AK, 3 AL.

  ```bash
  git --no-pager diff 2a2be74~1 2a2be74 -- data/facilities.meta.json
  git --no-pager diff 2a2be74~1 2a2be74 -- data/facilities.json \
    | grep '^+' | grep -o '"state": "[A-Z][A-Z]"' | sort | uniq -c
  ```

- Note this is the **same event as the outage entry above, recovered**: the AL
  and AK discovery runs at 14:22 and 14:38 on 09-28 are the first two that
  succeeded, and these 8 records are their output. Do not count them as two
  independent confounds.

**2026-09-28 — #355 `9907134`, runtime dependency bumps (Dependabot)**
Category: *content edit to page templates* — **indirect**, via the renderer.

- `next` 16.3.3 → 16.3.6 and `react`/`react-dom` 19.2.4 → 19.3.0, plus 11
  other runtime packages. No template source changed, but a framework bump can
  change emitted HTML. **Not measured** — no before/after HTML diff was taken.
- It lands on **every** family at once, so it cannot by itself produce a
  between-family difference; it matters only for absolute magnitudes.

  ```bash
  git --no-pager diff 9907134~1 9907134 -- package.json | grep '^[-+] '
  ```

**2026-09-29 — #363 `133e70c`, 19 facilities approved and published**
Category: *concurrent data wave*. `facilities` family only.

- `recordCount` 2249 → 2268 (+19): 14 AR, 5 CA.

  ```bash
  git --no-pager diff 133e70c~1 133e70c -- data/facilities.meta.json
  git --no-pager diff 133e70c~1 133e70c -- data/facilities.json \
    | grep '^+' | grep -o '"state": "[A-Z][A-Z]"' | sort | uniq -c
  ```

**2026-09-29 — #365 `d9fa6da`, siting-context backfill**
Category: *content edit to page templates* (data-driven content, no template
change). `facilities` family only.

- 177 facility pages that had no "nearest water" line gained one, and 182
  gained a "nearest ≥230 kV line" — both render in the "Siting context" panel.
  Existing values were untouched (0 changed, 0 nulled).
- One `data/siting-context.json` entry was dropped, for
  `galaxy-helios-dickens-tx` — the URL #352 already 301'd, so no page changed.

**2026-09-30 — branch `data/bartow-bunkhouse-correction`, Bartow County, GA correction + 3 facilities**
Categories: *concurrent data wave* **and** *internal-linking change* (operator
hub). `facilities` family, plus one operator hub removed and one grown.

- Prompted by a correction request from Taurus Investment Holdings, which no
  source tied to Project Bunkhouse. Published through `submissions` (6 rows,
  each human-approved), then `db:export`.
- `recordCount` 2268 → 2271 (+3, all GA): `atlas-stiles-road-cartersville-ga`,
  `oakley-brown-farm-road-cartersville-ga`,
  `switch-keep-2-atlanta-north-cartersville-ga`.
- 2 records changed: `taurus-digital-realty-project-bunkhouse-stilesboro-ga`
  (**title changed** — "Taurus/Digital Realty" → "Digital Realty"; operator
  → `Digital Realty`) and `atlas-project-springbank-adairsville-ga`. Both pins
  moved (≈1 km and ≈7.2 km).
- USGS NHD failed the pre-flight twice, so `build:mapdata` ran with
  `--skip-nhd`: the 3 new pages render a "Siting context" panel without
  nearest-water / nearest-≥230 kV lines, and the 2 moved pins still show
  values computed at their old coordinates. A full `build:mapdata` is owed
  (the NHD ceiling in `lib/siting-context.test.ts` is 3 until then); that
  follow-up is itself a small `facilities`-family content change.
- The operator hub for "Taurus Investment Holdings (Taurus DC SPE LLC); to be
  managed by Digital Realty" lost its only facility and no longer exists; the
  `Digital Realty` hub gained one.

  ```bash
  git --no-pager diff main -- data/facilities.meta.json
  ```

**2026-09-30 — #372 (`automated/neon-sync`), Connecticut + Colorado, 19 facilities**
Categories: *concurrent data wave* **and** *internal-linking change* (new
operator and county hubs). `facilities` family.

- Already live in Neon when the 17:36Z Neon→JSON sync (run 36752631424)
  exported it; #372 is that export plus the map data below.
- `recordCount` 2271 → 2290 (+19: 10 CO, 9 CT; 17 `data_center`, 2
  `power_generation`).
- 6 existing records changed. No title changed and no pin moved (the four
  `location` diffs are street / postal code only): `cognovum-trumbull-ct`,
  `cyrusone-nym5-norwalk-ct`, `flexential-parker-co`, `global-ai-windsor-co`,
  `qts-aurora-co`, `tierpoint-waterbury-ct`.
- Distinct operator slugs 1030 → 1042 (+12) and county slugs 860 → 863 (+3:
  `hartford-ct`, `jefferson-co`, `new-haven-ct`), counted with
  `operatorSlug` (`lib/operator-slug.ts`) and `countySlug` (`lib/counties.ts`)
  over `data/facilities.json`. These are slug counts; hub pages were not
  inspected.
- USGS NHD passed the pre-flight, then degraded mid-run (HTTP 504s, 0.0406
  facilities/sec at 250/2290), so `build:mapdata` ran with `--skip-nhd`. The
  19 new pages render a "Siting context" panel with water stress / aquifer /
  groundwater decline but without nearest-water / nearest-≥230 kV lines.
  `check-siting-additive`: 19 added, 0 lost, 0 nulled, 0 changed. The NHD
  ceiling in `lib/siting-context.test.ts` rises 3 → 22 (these 19 plus the 3
  Bartow County records above). The full `build:mapdata` owed there now
  covers 22 pages plus the 2 moved GA pins, and will itself be a small
  `facilities`-family content change.
- The homepage hero plate (`components/home/hero-plate-paths.ts`) and
  `public/data/{hero-points,map-layers,pipeline-history}.json` were
  regenerated from the new data.

  ```bash
  git --no-pager diff c8deea0 ab8671d -- data/facilities.meta.json
  git --no-pager diff c8deea0 ab8671d -- data/facilities.json \
    | grep '^+' | grep -o '"state": "[A-Z][A-Z]"' | sort | uniq -c
  ```

**2026-10-01 — `feature/contact-privacy`, maintainer portfolio link removed (Ed's call to ship inside the soak)**
Category: *content edit to page templates* — at template scale (the footer is on
every HTML page), but the smallest form of it.

- `components/site-footer.tsx`: the outbound `<a href="https://edwardkubiak.com">`
  around "Edward Kubiak" became plain text. The visible footer text is
  unchanged; one **external** link is gone from every page. No internal link,
  title, H1, canonical, `robots.txt` or sitemap change.
- `app/support/page.tsx`: the same outbound link removed from the "Who's behind
  it" bio; the prose is otherwise unchanged. One page.
- Shipped in the soak deliberately: sites now cite Compute Atlas as a data
  source, and the link led readers to the maintainer's personal contact
  details. The rest of the branch (`/admin/contact` reply-via-Resend, the
  contact notification email) is not crawlable — `/admin/` is disallowed in
  `app/robots.ts` and cookie-gated.

  ```bash
  git --no-pager log -S'edwardkubiak.com' --first-parent main --format='%h %ad %s' \
    --date=short -- components/site-footer.tsx app/support/page.tsx
  ```

**2026-10-01 — #374 (`automated/neon-sync`), Delaware + District of Columbia, 16 facilities**
Categories: *concurrent data wave* **and** *internal-linking change* (new
operator hubs). `facilities` family.

- Already live in Neon when the 18:17Z Neon→JSON sync (run 36905711567)
  exported it; #374 is that export plus the map data below.
- `recordCount` 2290 → 2306 (+16: 13 DE, 3 DC; 10 `data_center`, 6
  `power_generation`).
- 6 existing records changed. No title changed and no pin moved (the three
  `location` diffs are street / postal code only):
  `365-data-centers-washington-dc`, `abit-usa-duff-tn`,
  `coresite-dc1-washington-d-c-dc`, `maguire-hayden-harrington-de`,
  `parkway-gravel-st-georges-de`, `the-data-centers-star-campus-newark-de`.
- Distinct operator slugs 1042 → 1053 (+11). County slugs unchanged at 863:
  every new record falls in a county that already had one. Counted the same
  way as #372; hub pages were not inspected.
- USGS NHD failed the quorum pre-flight at [KS interior] in CI (layers 4 and
  10 timed out at 12s), and again when re-probed by hand, so `build:mapdata`
  ran with `--skip-nhd`. The 16 new pages render a "Siting context" panel
  with water stress / aquifer / groundwater decline but without nearest-water
  / nearest-≥230 kV lines. `check-siting-additive`: 16 added, 0 lost, 0
  nulled, 0 changed. The NHD ceiling in `lib/siting-context.test.ts` rises
  22 → 38. The full `build:mapdata` owed there now covers 38 pages plus the
  2 moved GA pins.
- The homepage hero plate (`components/home/hero-plate-paths.ts`) and
  `public/data/{hero-points,map-layers,pipeline-history}.json` were
  regenerated from the new data.

  ```bash
  sha=$(git log -1 --format=%h --grep='(#374)' main)
  git --no-pager diff "$sha~1" "$sha" -- data/facilities.meta.json
  git --no-pager diff "$sha~1" "$sha" -- data/facilities.json \
    | grep '^+' | grep -o '"state": "[A-Z][A-Z]"' | sort | uniq -c
  ```

### RULED OUT

Listed because the section's own instruction is to rule confounds out
explicitly rather than omit them.

**2026-09-28 — #361 `1bec5e6`, preview-only prerender trim** — **RULED OUT**.

- It edits `generateStaticParams` on the facility, county and operator
  templates, but through `previewSubset` (`lib/build-params.ts`), which
  returns the full list unless `VERCEL_ENV === "preview"`. Production output
  is unchanged. Verify: `grep -A4 'export function previewSubset' lib/build-params.ts`.

**2026-09-28 → 2026-09-29 — #354, #356, #357, #362, #364, #366** — **RULED OUT**.

- None touches `app/`, `components/`, `next.config.ts`, `proxy.ts` or
  `app/robots.ts`: CI config, dev dependencies, and the discovery / map-data
  pipelines. Verify per SHA with
  `git --no-pager show --name-only --format='' <sha> | grep -E '^(app/|components/|next\.config|proxy\.ts)'`
  (empty for each).

**2026-09-29 — #368 `b79b487` (`undici` 7.29.0 → 7.30.0) and #367 `1099e79`
(`ip-address` 10.4.0 → 10.7.2)** — **RULED OUT**.

- Both change `package-lock.json` only (transitive dependencies). No direct
  dependency, template or config changed. Verify:
  `git --no-pager show --name-only --format='' b79b487 1099e79`.

**2026-09-28 — #353 `6c0b85e`, "Close the security audit's findings"** —
**RULED OUT** as Googlebot-affecting.

- 97 files changed (`git --no-pager show --name-only --format='' 6c0b85e | grep -c .`),
  but the SEO- or crawler-relevant ones are `app/robots.test.ts` and
  `lib/seo.test.ts` (**tests**, no shipped behaviour) plus `proxy.ts` /
  `proxy.test.ts`.
- `proxy.ts`'s matcher is `["/admin/:path*", "/api/:path*"]` — **no public page
  path is matched**, so the edge check it added cannot reach a crawlable HTML
  route. Verify: `grep -A3 'export const config' proxy.ts`.
- ⚠️ Scope of this ruling: it rests on the matcher and on the SEO-relevant
  subset of the file list, not on an individual audit of all 97 files.

**2026-09-28 — #358 `c6809cb`, "require the Vercel ignore-gate's diff base to be an ancestor of HEAD"** —
**RULED OUT**, low relevance.

- Touches only `scripts/vercel-ignore-build.sh` and `tests/vercel/run.bats`. It
  changes which commits produce a deployment, not page content, internal links
  or crawler access.
- The one indirect path, named so it is not rediscovered later: the gate
  governs *when* a change reaches production, so it can shift a publish date.
  It cannot change what Googlebot sees on a page that is live.

## Gaps in the pre-registered list

Two things occurred inside the window that the "Named confounds" list does not
name. Recording them as gaps rather than folding them in silently, because the
list was pre-registered and amending it after the fact is the thing
pre-registration exists to prevent:

1. **Route retirement / 301 redirect** (#352). A URL leaving a sitemap family
   mid-window changes that family's denominator and its coverage report
   directly. The named list covers content, linking, robots and Cloudflare —
   not route inventory.
2. **Absence of expected activity.** The list names things *happening*; the
   discovery outage is a named-category input (new content) *failing to
   happen* for 3 of 14 days. A pre-registration that only enumerates positive
   events cannot catch this class.

## What this does to the 2026-10-13 read

Stated plainly, because a pre-registration whose confounds swamp its signal is
a fact to record, not to hide.

The falsifiable test above is **per-sitemap coverage differing measurably
between families**. The confounds land unevenly across families, and that is
precisely the problem:

- The **`facilities` family — the one the hypothesis is actually about — took
  five changes inside the window**: two data waves (+8 records 2026-09-28, +19
  on 2026-09-29), a 301 retirement removing a URL from it (2026-09-27), a new
  internal link added to all 2,249 of its pages (2026-09-27), and new siting
  content on 177 of its pages (2026-09-29). A framework bump (2026-09-28) hit
  every family equally.
- `counties` took the internal-link change (396 pages). The other seven
  families took none of it.
- **Therefore a facilities-vs-others difference on 2026-10-13 has at least
  four candidate causes, and the sitemap split is only one of them. The
  positive branch of the test is confounded and cannot, on its own, attribute
  an observed difference to the split.**
- The outage pushes the other way: 3 of 14 days supplied no new content, so
  absolute crawl/index volume in the window is depressed relative to a normal
  fortnight. That affects magnitudes, not the between-family shape.

**The null branch is the more readable of the two, but is not immune.** Every
confound above acts *differentially* on `facilities`/`counties`, so they push
toward between-family variation rather than away from it; a flat result across
all nine families is therefore hard to explain by these confounds. The
exception worth naming: if a confound lifted `facilities` coverage while its
true baseline was worse, the two could cancel and read flat spuriously. So
"every family reports the same indexed ratio → drop the thin-hub triage unit"
remains decidable, with that caveat attached.

Choosing between reading 2026-10-13 with these limitations stated, and
extending the window past the confounds, is a maintainer decision and is
deliberately not made here.

## See also

- `scripts/index-census.ts` — the stratified per-family census this soak is
  built on.
- `scripts/census-baseline.ts` / `scripts/census-diff.ts` — freeze and diff
  tooling; `data/index-census-history.jsonl` is the resulting time series.
