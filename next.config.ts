import type { NextConfig } from "next";

/**
 * Content-Security-Policy — REPORT-ONLY. Violations surface only in the
 * browser console; there is deliberately no `report-to`/`report-uri`
 * endpoint yet (that's a later addition, not an oversight — this step is
 * about gathering evidence, not routing it anywhere).
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
 *   - https://va.vercel-scripts.com — confirmed in
 *     node_modules/@vercel/{analytics,speed-insights}/dist/index.js:
 *     both packages load their bootstrap script from here ONLY when
 *     `isDevelopment()` is true (local `npm run dev`); production resolves
 *     to the same-origin /_vercel/insights/script.js and
 *     /_vercel/speed-insights/script.js, already covered by 'self'. Left in
 *     so local dev testing (see flip criteria below) doesn't manufacture a
 *     false violation.
 *
 * Deliberately NOT enforcing yet: script-src still needs 'unsafe-inline'
 * for Next.js's inline bootstrap script, and a nonce-based tightening of
 * that is the enforcement-phase task, not this one. Flip criteria: a week
 * of clean browser consoles (no CSP violation lines) across `/`, `/map`
 * (including satellite mode and the location-search geocoder),
 * `/facilities/*`, and `/admin/login` — then swap this header for a real
 * `Content-Security-Policy` and add a report endpoint.
 */
const CSP_REPORT_ONLY_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org https://services.arcgisonline.com",
  "connect-src 'self' https://tiles.openfreemap.org https://services.arcgisonline.com https://nominatim.openstreetmap.org",
  "worker-src 'self' blob:",
  "child-src blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

/**
 * Baseline security headers applied to every route. Includes the
 * REPORT-ONLY CSP above; an *enforcing* Content-Security-Policy is still
 * deferred to its own follow-up (see that comment for the flip criteria).
 */
const BASELINE_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY_DIRECTIVES },
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
        source: "/admin/:path*",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        // Static map data and basemap style. Regenerated only by
        // `npm run build:mapdata`, so a 1-day edge TTL is safe and a long
        // stale-while-revalidate keeps the CDN serving during a refresh.
        // Next's default for `public/` is `max-age=0, must-revalidate`,
        // which left 8.3 MB of geojson uncacheable at both Vercel and
        // Cloudflare (measured `cf-cache-status: DYNAMIC`, 2026-08-21).
        source: "/data/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/basemap/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // Vendored font files never change content under a fixed name.
        source: "/fonts/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
