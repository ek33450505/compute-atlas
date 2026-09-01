import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every route. Deliberately does NOT
 * include Content-Security-Policy — an enforcing CSP needs explicit
 * allowances for MapLibre GL + inline styles and a browser-verified pass;
 * that's deferred to its own follow-up rather than bundled into this fix.
 */
const BASELINE_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
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
