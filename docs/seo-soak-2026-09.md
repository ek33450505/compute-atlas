# SEO soak: sitemap index split — pre-registration (2026-09)

Pre-registered BEFORE the change ships to production, per the
`seo-index-census` skill's rule that a before/after measurement needs a
soak window committed in advance — writing this after the fact would not
count as pre-registration.

## What changed

`/sitemap.xml` becomes a sitemap INDEX over nine per-family children
(`/sitemaps/<family>.xml`) instead of one flat `<urlset>`.

Verified live against production on 2026-09-25 (this change has not yet
merged to `main` / deployed — the sitemap-split commits are on
`feature/seo-index-census` only): `https://www.compute-atlas.com/sitemap.xml`
returned HTTP 200, root element `<urlset>`, **2,997** `<loc>` entries. That is
the pre-change baseline state this soak measures against.

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
before drawing conclusions from the 2026-10-13 read.

## See also

- `scripts/index-census.ts` — the stratified per-family census this soak is
  built on.
- `scripts/census-baseline.ts` / `scripts/census-diff.ts` — freeze and diff
  tooling; `data/index-census-history.jsonl` is the resulting time series.
