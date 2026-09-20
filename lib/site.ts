/**
 * The data license deed. Three machine-readable surfaces declare it and must
 * not drift apart: the `Dataset` JSON-LD `license` (`lib/seo.ts`), the JSON
 * API's `Link: <…>; rel="license"` header (`lib/api-response.ts`), and the
 * HTML `<link rel="license">` in `app/layout.tsx`. All three read this
 * constant. The rendered prose on /about, /api and /data links the deed too,
 * but those are anchors with visible text, not machine declarations, so they
 * are left as-is.
 *
 * It lives here rather than beside `DATASET_DOI_URL` in `lib/seo.ts` because
 * `lib/api-response.ts` is a dependency of every API route, and `lib/seo.ts`
 * reaches `lucide-react` through `lib/status.ts` — importing it there would
 * put React icon components in ~20 route bundles to read one string. This
 * file has no imports at all.
 */
export const DATASET_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

export const siteConfig = {
  name: "Compute Atlas",
  tagline: "Mapping the U.S. compute buildout",
  description:
    "Compute Atlas is an open, source-cited map of the U.S. compute buildout — traditional and hyperscale data centers, AI-specific facilities, crypto-mining operations, and the dedicated power generation built to supply them — from proposed and permitted to under construction and operational. It tracks what the buildout costs as well as what it adds: fuel mix, water stress, and documented community opposition, with a public source behind every record.",
  /**
   * The `<meta name="description">` / og / twitter string. Deliberately SHORT
   * and separate from `description` above, which is 451 chars and feeds the
   * Dataset + WebSite JSON-LD (`lib/seo.ts`), where length is an asset for
   * dataset discovery rather than a liability. Google renders ~155 chars on
   * desktop and ~120 on mobile, so the long one showed only its first third
   * on the SERP — brand-and-jargon first, with no number and no mention of
   * power, water, or opposition before the cut.
   * Keep at or under 160 characters and front-load the terms people search.
   * Guarded by `lib/site.test.ts`.
   */
  metaDescription:
    "Interactive US data center map and database — AI, hyperscale, and crypto-mining sites plus the power built to supply them. Every record is source-cited.",
  url: "https://www.compute-atlas.com",
  repoUrl: "https://github.com/ek33450505/compute-atlas",
  /**
   * Two funding paths, both live. Named individually rather than as one
   * `sponsorUrl` so a new destination can never silently repoint an existing
   * link. Ko-fi leads: guest checkout, no account needed — GitHub Sponsors
   * requires a GitHub account, which is the exact barrier for this site's
   * actual audience (residents, local journalists, county officials). GitHub
   * Sponsors stays because it is 0%-fee on one-off gifts.
   */
  kofiUrl: "https://ko-fi.com/L2T725R7FV",
  githubSponsorsUrl: "https://github.com/sponsors/ek33450505",
} as const;
