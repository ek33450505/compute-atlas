/**
 * The data license deed. Three machine-readable surfaces declare it and must
 * not drift apart: the `Dataset` JSON-LD `license` (`lib/seo.ts`), the JSON
 * API's `Link: <…>; rel="license"` header (`lib/api-response.ts`), and the
 * HTML `<link rel="license">` in `app/layout.tsx`. All three read this
 * constant. The rendered prose on /about, /api and /data links the deed too,
 * but those are anchors with visible text, not machine declarations, so they
 * are left as-is.
 *
 * It lives here rather than inside `lib/seo.ts` because
 * `lib/api-response.ts` is a dependency of every API route, and `lib/seo.ts`
 * reaches `lucide-react` through `lib/status.ts` — importing it there would
 * put React icon components in ~20 route bundles to read one string. This
 * file has no imports at all.
 */
export const DATASET_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

/** A Stripe Payment Link, or null when absent or anything else. */
export function parseSupportLink(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const ok =
      url.protocol === "https:" &&
      url.hostname === "buy.stripe.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/[A-Za-z0-9_-]+$/.test(url.pathname);
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

export const siteConfig = {
  name: "Compute Atlas",
  tagline: "Mapping the U.S. compute buildout",
  description:
    "Compute Atlas is a source-cited map of the U.S. compute buildout — traditional and hyperscale data centers, AI-specific facilities, crypto-mining operations, and the dedicated power generation built to supply them — from proposed and permitted to under construction and operational. It tracks what the buildout costs as well as what it adds: fuel mix, water stress, and documented community opposition, with a public source behind every record.",
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
   * Reader-support Stripe Payment Links, the only funding path on the site.
   * Configured per deployment through public env vars (the links are public
   * by nature): NEXT_PUBLIC_STRIPE_SUPPORT_MONTHLY_5, _MONTHLY_15,
   * _MONTHLY_50 and _ONE_OFF (pay what you want). A value counts only if it
   * is an https://buy.stripe.com/ URL; anything else is `null`, so a typo
   * cannot render an arbitrary link. Each must be a literal
   * `process.env.NEXT_PUBLIC_…` read so Next inlines it at build time.
   */
  supportLinks: {
    monthly5: parseSupportLink(process.env.NEXT_PUBLIC_STRIPE_SUPPORT_MONTHLY_5),
    monthly15: parseSupportLink(process.env.NEXT_PUBLIC_STRIPE_SUPPORT_MONTHLY_15),
    monthly50: parseSupportLink(process.env.NEXT_PUBLIC_STRIPE_SUPPORT_MONTHLY_50),
    oneOff: parseSupportLink(process.env.NEXT_PUBLIC_STRIPE_SUPPORT_ONE_OFF),
  },
  /** Public Bluesky profile for the project. */
  blueskyUrl: "https://bsky.app/profile/compute-atlas.com",
  /**
   * Newsletter subscribe page. A link only (no embedded form, so no
   * CSP `form-action`/`frame-src` change). The list is held by Buttondown; the
   * site's facility/state watch subscribers are NEVER imported into it (they
   * opted into alerts only).
   */
  newsletterUrl: "https://buttondown.com/compute-atlas",
} as const;
