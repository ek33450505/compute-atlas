import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

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
// Also note: the live robots.txt currently carries a
// `Content-Signal: search=yes,ai-train=no,use=reference` line, which comes
// from that same Cloudflare feature and will disappear once it's turned
// off. We do NOT try to reproduce it here -- Next's MetadataRoute.Robots
// has no field for a Content-Signal directive, and hand-rolling the route
// to emit one is out of scope for this change. Flagged as a concern for the
// maintainer to decide separately.
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
    },
    ...BLOCKED_AI_CRAWLERS.map((userAgent) => ({
      userAgent,
      disallow: "/",
    })),
  ];

  return {
    rules,
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
