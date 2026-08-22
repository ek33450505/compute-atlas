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

const nextConfig: NextConfig = {
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
