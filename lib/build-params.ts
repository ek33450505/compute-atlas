/**
 * Build-time trimming of `generateStaticParams` results.
 *
 * Every Vercel build prerenders the whole corpus (~4,330 routes, ~90s of
 * 29-worker page generation). Three dynamic templates account for 95% of that,
 * and each preview deploy also writes ~4,330 ISR entries that are discarded
 * when the preview is superseded. Build CPU and ISR writes were the two largest
 * lines on the September 2026 bill; previews do not need the full corpus
 * prerendered to be reviewable.
 *
 * Untrimmed routes are NOT lost on a preview: the templates that use this helper
 * rely on Next's default `dynamicParams: true`, so any param not returned here is
 * rendered on demand at first request. Never use this on a template that sets
 * `dynamicParams = false` (e.g. `app/sitemaps/[family]/route.ts`) — there a
 * trimmed param is a 404, not a slower first hit.
 *
 * What this does NOT cost you, because the obvious worry is wrong. The natural
 * objection is "previews prerender every page, so trimming them means a
 * data-dependent render crash is no longer caught at PR time". Measured, it
 * still is: the REQUIRED `Playwright e2e` job runs `npm run build && npm run
 * start` (`playwright.config.ts:56`, `.github/workflows/ci.yml`) on every PR,
 * with `VERCEL_ENV` unset — so a full 4,330-route build happens per PR
 * regardless of this helper, and a crashing page fails that job. The coverage
 * moves between jobs; it does not move to merge time.
 *
 * Nor does a promoted deployment serve trimmed output in production. Vercel has
 * three no-rebuild promotion paths, and all three serve an artifact that was
 * built AS production: "promote preview to production" explicitly does a
 * complete rebuild; promoting a staged production build skips the rebuild but
 * that build already ran with `VERCEL_ENV=production`; and instant rollback
 * only targets deployments that have already served production traffic.
 * (Checked against Vercel's promotion docs 2026-09-28 — re-check if they
 * change, since the whole safety of this helper on production rests on
 * `VERCEL_ENV` being `production` for anything production ever serves.)
 */

/**
 * Return the first `keep` entries on a Vercel **preview** build, and `all`
 * unchanged everywhere else (production, GitHub-Actions CI, local builds).
 *
 * The gate is the positive `VERCEL_ENV === "preview"` test on purpose: a
 * negative form such as `!== "production"` silently captures unset and unknown
 * values, which is exactly the defect PR #358 fixed elsewhere in this repo.
 *
 * `process.env` is read inside the function, not at module scope, so a test can
 * vary it without resetting the module registry. The subset is the first `keep`
 * entries in the order given — never sorted, shuffled or sampled, because a
 * nondeterministic build input is its own class of problem.
 */
export function previewSubset<T>(all: T[], keep: number): T[] {
  if (process.env.VERCEL_ENV !== "preview") return all;
  if (all.length <= keep) return all;
  return all.slice(0, keep);
}
