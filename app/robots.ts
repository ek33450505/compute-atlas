import type { MetadataRoute } from "next";
import { SITEMAP_FAMILY_IDS, SITEMAP_INDEX_URL, sitemapChildUrl } from "@/lib/sitemap-families";

// AI-crawler rules live here, in our own code, instead of being left to
// Cloudflare's managed robots.txt block (Security -> Settings -> Bot
// traffic -> "Set your preference to block training in robots.txt"). That
// Cloudflare feature is all-or-nothing -- it offers no per-crawler control --
// so it cannot allow one AI crawler while blocking the rest. Writing the
// rules ourselves gives us that per-crawler control.
//
// Google-Extended is DELIBERATELY ABSENT from BLOCKED_AI_CRAWLERS below.
// Compute Atlas is a source-cited public dataset that wants to be cited in
// Gemini and Google AI Overviews answers, and Google-Extended is the crawler
// control for that (it governs Gemini/AI-Overviews training & grounding
// only -- it does NOT affect Googlebot or standard search indexing).
//
// IMPORTANT (operational): the Cloudflare toggle above must be turned OFF,
// or its managed block is merged back in ahead of ours (between
// "# BEGIN Cloudflare Managed content" / "# END Cloudflare Managed Content"
// markers) and re-adds a Google-Extended block, silencing this change.
//
// The `Content-Signal` directive below used to be injected by that same
// Cloudflare feature. It is gone from the live robots.txt as of 2026-09-15
// (measured at origin, cf-cache-status: MISS), so we now emit it from our
// own code via MetadataRoute.Robots' `other` field (added in Next 16.3.0).
// Keys keep their casing and values pass through verbatim, and the entry is
// scoped to the User-Agent block it sits on -- so it rides the "*" rule.
export const BLOCKED_AI_CRAWLERS = [
  "Amazonbot",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "ClaudeBot",
  "CloudflareBrowserRenderingCrawler",
  "GPTBot",
  "meta-externalagent",
] as const;

export default function robots(): MetadataRoute.Robots {
  const rules: MetadataRoute.Robots["rules"] = [
    {
      userAgent: "*",
      allow: "/",
      // Trailing slash matters: "/api/" blocks the JSON endpoints under
      // /api/... (facilities, stats, search, contribute, submissions) but
      // NOT the public doc page at the bare "/api" path (app/api/page.tsx),
      // which stays crawlable and is listed in the sitemap.
      disallow: ["/admin/", "/api/"],
      // Content-Signal (contentsignals.org): search indexing yes, training
      // no, retrieval/citation allowed. It speaks to crawlers that read the
      // directive but not our User-Agent blocks, and it matches the CC BY 4.0
      // data licence's reuse-with-attribution terms.
      //
      // OPEN QUESTION for the maintainer: it does not sit perfectly with the
      // Google-Extended exemption above. Content-Signal has no per-agent
      // form, so on the "*" rule it also tells Google-Extended ai-train=no --
      // stricter than the exemption this file goes out of its way to
      // preserve. It ships anyway for two reasons: prod already served this
      // exact line via Cloudflare, so emitting it restores the prior position
      // rather than inventing a stricter one; and Content-Signal states a
      // PREFERENCE, whereas the User-Agent blocks below are the enforceable
      // statement, which still exempts Google-Extended. Resolving the tension
      // (varying the signal per agent, or dropping ai-train=no) is a policy
      // call and is deliberately NOT made here.
      other: {
        "Content-Signal": "search=yes,ai-train=no,use=reference",
      },
    },
    ...BLOCKED_AI_CRAWLERS.map((userAgent) => ({
      userAgent,
      disallow: "/",
    })),
  ];

  return {
    rules,
    // The index alone would be enough for Google (it fetches every child
    // listed inside it), but listing the children too costs nothing here and
    // helps crawlers that don't parse a sitemap index. Derived from the
    // family registry rather than hardcoded, so a tenth family can't leave
    // this list stale.
    sitemap: [SITEMAP_INDEX_URL, ...SITEMAP_FAMILY_IDS.map(sitemapChildUrl)],
  };
}
