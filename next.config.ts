import type { NextConfig } from "next";

import { CSP_REPORT_PATH } from "./lib/csp-report";

/**
 * Content-Security-Policy — ENFORCING as of 2026-09-07 (issue #236). It was
 * report-only from 2026-09-04 while the evidence was gathered.
 *
 * What the flip rests on. The original criterion was "a week of clean
 * browser consoles", which turned out to be unfalsifiable: with no report
 * endpoint, a silent console for a page nobody opened looked exactly like a
 * genuinely clean one. It was replaced by two mechanical sweeps, and BOTH
 * were required, because each is blind to what the other sees:
 *   - `e2e/csp.spec.ts` against a real production build — covers the
 *     gesture-only surfaces (`/map` satellite mode, the geocoder) that a
 *     bare page load never reaches, and carries a canary test proving the
 *     violation listener actually fires. 5/5 clean, 2026-09-07.
 *   - A production sweep of 10 route families against www.compute-atlas.com
 *     — the only thing that can see subresources the Cloudflare proxy
 *     injects and the app never declares. That sweep is how
 *     `static.cloudflareinsights.com` was found (PR #254); zero violations
 *     on 2026-09-07 after it merged.
 * `/map` was the last real blocker and is fixed at the source: PR #253
 * switched to MapLibre's CSP-safe build, so nothing here needs
 * `'unsafe-eval'`.
 *
 * ⚠️ `script-src` still carries 'unsafe-inline' for Next.js's bootstrap
 * script, so an enforcing `script-src` is weaker than it looks. Enforcing is
 * still a real gain — `object-src 'none'`, `base-uri`, `frame-ancestors` and
 * `form-action` are now actually enforced rather than merely reported.
 * Nonce-based tightening is a separate, larger job; do not let it block or
 * un-do this.
 *
 * Every non-'self' origin below is evidenced by a real subresource this app
 * loads (checked 2026-09-04) — not a speculative allowance:
 *   - https://tiles.openfreemap.org — vector tiles, glyphs, and sprite for
 *     the basemap style (public/basemap/parchment.json is fetched
 *     same-origin, but its `tiles`/`glyphs`/`sprite` fields point here;
 *     see lib/map.ts's BASEMAP_STYLE_URL comment).
 *   - https://services.arcgisonline.com — Esri World Imagery satellite
 *     raster tiles (lib/map.ts SATELLITE_TILE_URL).
 *   - https://nominatim.openstreetmap.org — the map's location-search
 *     geocoder (lib/geocode.ts), called via fetch().
 *   - https://static.cloudflareinsights.com — Cloudflare Web Analytics'
 *     beacon.min.js, injected by the Cloudflare proxy in front of production.
 *     It does NOT exist in a local build, so no local check can see it: it was
 *     found by running the e2e/csp.spec.ts listener against PRODUCTION on
 *     2026-09-07, where it was the ONLY violation, on 7 of 10 route families
 *     swept (/, /map, /table, /facilities/*, /admin/login, /learn/*,
 *     /contribute). That asymmetry is the point — a local harness is necessary
 *     but not sufficient for this header, because the proxy adds subresources
 *     the app never declares.
 *   - https://va.vercel-scripts.com — confirmed in
 *     node_modules/@vercel/{analytics,speed-insights}/dist/index.js:
 *     both packages load their bootstrap script from here ONLY when
 *     `isDevelopment()` is true (local `npm run dev`); production resolves
 *     to the same-origin /_vercel/insights/script.js and
 *     /_vercel/speed-insights/script.js, already covered by 'self'. Left in
 *     so local dev testing (see flip criteria below) doesn't manufacture a
 *     false violation.
 *
 * `frame-ancestors` is NOT in this shared list — it is supplied per scope by
 * `buildCsp` below. See that function for why leaving it here would have
 * been a silent security regression.
 */
const CSP_COMMON_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org https://services.arcgisonline.com",
  "connect-src 'self' https://tiles.openfreemap.org https://services.arcgisonline.com https://nominatim.openstreetmap.org",
  "worker-src 'self' blob:",
  "child-src blob:",
  // ⚠️ `frame-src` is stated EXPLICITLY and must stay that way. Its fallback
  // chain is `child-src` FIRST, and only then `default-src` — so with
  // `child-src blob:` above and no entry here, framing resolved to `blob:`
  // alone: same-origin iframes blocked, blob: iframes allowed, which is the
  // inverse of the intent and of what `default-src 'self'` would suggest to
  // a reader. Verified in a browser against this build, not inferred:
  // appending a `/table` iframe reported `frame-src -> /table`.
  //
  // `'none'` rather than `'self'` because nothing in the app frames anything
  // (zero frame-src violations across both the production sweep and
  // e2e/csp.spec.ts, under a policy with this same fallback), so `'self'`
  // would be an unevidenced allowance — and this list only carries origins a
  // real subresource needs. Anything that legitimately needs to iframe later
  // will fail against a directive that says so, instead of against an
  // invisible fallback.
  "frame-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

/**
 * Builds the policy for one scope, differing only in `frame-ancestors`.
 *
 * ⚠️ This split is load-bearing, and the reason is easy to miss. Per the CSP
 * spec, a browser that honours an *enforcing* `frame-ancestors` MUST IGNORE
 * `X-Frame-Options` entirely on that response. `/admin/*` sets
 * `X-Frame-Options: DENY` (stricter than the site-wide SAMEORIGIN) — so
 * shipping one enforcing policy with `frame-ancestors 'self'` everywhere
 * would have quietly *downgraded* admin framing protection from DENY to
 * same-origin, as a side effect of a change nominally about tightening
 * security. Under report-only the same directive was inert, which is exactly
 * why this could not have been observed before the flip. `'none'` for admin
 * preserves DENY's meaning in the header that now actually wins.
 *
 * `report-uri` goes last. It is the deprecated-but-universally-supported
 * form, chosen over `report-to`/`Reporting-Endpoints` on purpose: the
 * Reporting API batches delivery (tens of seconds), which cannot be asserted
 * on in `e2e/csp.spec.ts` without a slow, flaky wait — and an unverifiable
 * report channel is precisely the failure this issue already burned two
 * sessions on. `app/api/csp-report/route.ts` already parses both wire
 * formats, so adopting `Reporting-Endpoints` later is a header-only change.
 */
function buildCsp(frameAncestors: "'self'" | "'none'"): string {
  return [
    ...CSP_COMMON_DIRECTIVES,
    `frame-ancestors ${frameAncestors}`,
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");
}

const CSP_SITE_WIDE = buildCsp("'self'");
const CSP_ADMIN = buildCsp("'none'");

/**
 * Baseline security headers applied to every route, including the enforcing
 * CSP above. `X-Frame-Options` is kept alongside `frame-ancestors` for
 * browsers that predate CSP Level 2 framing control; where both are
 * understood, `frame-ancestors` wins.
 */
const BASELINE_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Content-Security-Policy", value: CSP_SITE_WIDE },
];

/**
 * Permanent redirects for facility slugs that no longer exist.
 *
 * A retired facility id would otherwise 404 forever on a URL Google had
 * already indexed. `db:sync` never deletes, so a retirement is always a
 * deliberate out-of-band act — which makes this list short and hand-curated
 * rather than generated.
 *
 * Point each retired slug at the successor a reader most likely wanted. Where
 * a record was split into several, that is a judgement call: prefer the
 * successor that inherits the original's primary location.
 */
const RETIRED_FACILITY_REDIRECTS = [
  {
    // Retired 2026-08-27. This record claimed to cover three Amazon campuses,
    // but its own cited source (KSLA, 2026-02-24) states the Resilient Tech
    // Park site "is not part of Monday's $12 billion investment". It was split
    // into aws-blanchard-caddo-parish-la, aws-benton-bossier-parish-la and
    // aws-resilient-technology-park-shreveport-la. Blanchard is the successor
    // carrying the original's Caddo Parish location.
    source: "/facilities/amazon-northwest-louisiana",
    destination: "/facilities/aws-blanchard-caddo-parish-la",
    permanent: true,
  },
];

const nextConfig: NextConfig = {
  /**
   * `/methodology` (app/methodology/page.tsx, via lib/methodology.ts) reads
   * `docs/methodology.md` off disk at module-evaluation time. The page has
   * no `revalidate`/dynamic data so Next prerenders it fully at `next build`
   * (where the repo is always fully checked out) — this entry is a
   * belt-and-suspenders guard so the file is still traced into the
   * serverless bundle if that page ever becomes dynamic, rather than relying
   * solely on `@vercel/nft`'s heuristic static analysis of the `fs` call.
   */
  outputFileTracingIncludes: {
    "/methodology": ["./docs/methodology.md"],
  },

  async redirects() {
    return RETIRED_FACILITY_REDIRECTS;
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: BASELINE_SECURITY_HEADERS,
      },
      {
        // Admin surfaces get the stricter DENY (no framing at all) rather
        // than SAMEORIGIN — Next.js applies this after the broader match
        // above, so it wins for this key on /admin/* paths.
        //
        // The CSP is re-stated here for the same reason, and it is not
        // redundant: an enforcing `frame-ancestors` makes browsers ignore
        // `X-Frame-Options` outright, so without this override the DENY
        // above would be dead letter and admin pages would inherit the
        // site-wide `frame-ancestors 'self'`. See `buildCsp`. Header rules
        // replace by key rather than merging, so this value must be the
        // WHOLE policy, not just the differing directive.
        source: "/admin/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: CSP_ADMIN },
        ],
      },
      {
        // Static map data and basemap style. Regenerated only by
        // `npm run build:mapdata`, so a 1-day edge TTL is safe and a long
        // stale-while-revalidate keeps the CDN serving during a refresh.
        // Next's default for `public/` is `max-age=0, must-revalidate`,
        // which left 8.3 MB of geojson uncacheable at both Vercel and
        // Cloudflare (measured `cf-cache-status: DYNAMIC`, 2026-08-21).
        //
        // `:path+` (one or more segments), NOT `:path*` (zero or more).
        // `app/data/page.tsx` is a real HTML route at bare `/data`, and
        // `:path*` also matches the empty remainder — so the asset rule was
        // shadowing that page with a day-long edge cache plus a 7-day
        // stale-while-revalidate tail, well past anything a redeploy or ISR
        // revalidation could dislodge. It served a stale record count on
        // prod for a full day before being caught (2026-09-05). `:path+`
        // still matches `/data/water.geojson` etc.; it just requires at
        // least one path segment, so the bare route is excluded. See
        // next.config.test.ts's "asset-cache headers don't shadow app
        // routes" block — do not simplify this back to `:path*`.
        source: "/data/:path+",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // No `app/basemap/` route exists, so `:path*` vs `:path+` is
        // currently moot here — kept as `:path+` anyway for consistency
        // with the `/data` rule above, since both serve the same kind of
        // build-generated static asset and should read the same way.
        source: "/basemap/:path+",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // Vendored font files never change content under a fixed name.
        // `app/fonts/` also doesn't exist, so `:path*` is harmless here too;
        // left as `:path*` (not widened to `:path+` like the two rules
        // above) because this header value is unique to fonts rather than
        // shared with another static-asset rule, so there's no matching
        // pattern to stay consistent with.
        source: "/fonts/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
