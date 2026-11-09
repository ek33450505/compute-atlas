import type { MetadataRoute } from "next";
import { SITEMAP_FAMILY_IDS, SITEMAP_INDEX_URL, sitemapChildUrl } from "@/lib/sitemap-families";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

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
//
// POLICY (Ed, 2026-10-15, amended 2026-11-09). ALLOWED: classic SEARCH engines
// (Googlebot, Bingbot, DuckDuckBot), archives (archive.org_bot,
// Arquivo-web-crawler), AI assistants fetching on a person's behalf
// (Claude-User, Perplexity-User), AI search crawlers and indexers
// (PerplexityBot, Claude-SearchBot, ExaSearchBot, Amzn-SearchBot), AI search
// assist (DuckAssistBot) and Google-Extended. BLOCKED: AI TRAINING crawlers,
// bulk dataset extractors, SEO-resale crawlers, and the three tokens in
// BLOCKED_BY_EDITORIAL_CHOICE (ChatGPT-User, OAI-SearchBot, Applebot; Ed,
// 2026-11-09). The 2026-10-15 posture had allowed those three.
//
// Cloudflare enforces the same set at the edge (out of repo). This file is the
// source of truth and must mirror the edge, because a UA blocked at the edge but
// allowed here (or the reverse) makes a compliant crawler read one thing and get
// another. Known deltas: "Anchor Browser" is edge-only (a browser product with
// no robots token), and Baiduspider, Manus-User, meta-externalfetcher,
// MistralAI-User and Terracotta are edge-only pending Ed's decision.
// Applebot-Extended is no longer robots-only: the edge matches
// `contains "Applebot"` and so blocks it too.
//
// Tokens below that were derived from a User-Agent string rather than
// confirmed against vendor docs (unverified): Novellum,
// ProRataInc, Reflectionbot, ShapBot, Shap-User, KorzyData, TikTokSpider.
//
// "Anchor Browser" is on the Cloudflare rule but deliberately not listed: it is
// a browser-automation product, not a robots.txt product token.
export const BLOCKED_AI_CRAWLERS = [
  "Amazonbot",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "ClaudeBot",
  "CloudflareBrowserRenderingCrawler",
  "FacebookBot",
  "GPTBot",
  "meta-externalagent",
  "Novellum",
  "PetalBot",
  "ProRataInc",
  "TikTokSpider",
  "Timpibot",
] as const;

// Bulk dataset extractors -- crawlers that exist to lift whole datasets or
// sites into someone else's index. This is the AI-extractor subset of the
// Cloudflare custom rule "Block bulk dataset extractors"; that rule's four SEO
// UAs live in BLOCKED_SEO_CRAWLERS.
export const BLOCKED_BULK_EXTRACTORS = [
  "Reflectionbot",
  "ShapBot",
  "Shap-User",
  "KorzyData",
] as const;

// SEO-backlink resale crawlers -- a different category from
// BLOCKED_AI_CRAWLERS above, with a different rationale, so it gets its own
// list rather than being folded into that one. These don't train models;
// they re-crawl the site to sell backlink/SEO-analysis data through
// third-party subscriptions we get no benefit from. Blocking them is a
// bandwidth decision, not a training-consent one. Measured over 7 days, the
// four below combined for ~0.7 GB/week (~3 GB/month) against a 100 GB/month
// Vercel Hobby bandwidth cap, serving nobody but their own paying customers:
//
//   SERankingBacklinksBot  4,148 req  0.22 GB
//   DotBot (Moz)             802 req  0.25 GB
//   QlyzeBot               2,900 req  0.15 GB
//   DataForSeoBot          1,671 req ~0.08 GB
//
// AhrefsBot and SemrushBot are DELIBERATELY ABSENT from this list, unlike the
// four above (same pattern as Google-Extended's exemption from
// BLOCKED_AI_CRAWLERS). They cost bandwidth the same way, but they're also
// how Ed's own backlink profile is visible to him and to anyone evaluating
// the project -- there's no substitute that doesn't crawl the site.
// ~0.44 GB/week is the accepted price for that visibility.
export const BLOCKED_SEO_CRAWLERS = [
  "DataForSeoBot",
  // Moz's own robots.txt examples for this crawler consistently use
  // lowercase "dotbot" (moz.com/help/moz-procedures/crawlers/dotbot), not the
  // "DotBot" casing its User-Agent header sends. Matching is case-insensitive
  // per the robots.txt spec either way, but this is the vendor's documented
  // token.
  "dotbot",
  "QlyzeBot",
  // Unconfirmed against vendor docs: help.seranking.com sits behind a
  // Cloudflare bot-challenge that blocks non-browser fetches (verified
  // 2026-09-27), so the actual documented directive couldn't be read. This is
  // the exact string SERankingBacklinksBot sends as its own User-Agent,
  // corroborated by that same doc URL's slug
  // ("SERankingBacklinksBot-Crawler") but not by the directive text itself.
  "SERankingBacklinksBot",
] as const;

// Blocked by editorial choice (Ed, 2026-11-09): retrieval and search agents
// from companies Ed chooses not to support ("block them - i dont support those
// companies"). This is NOT a training-crawler classification; it supersedes the
// 2026-10-15 allowance for these three tokens only. Plain Applebot is the
// search crawler (Applebot-Extended, the training control, is in
// BLOCKED_AI_CRAWLERS).
// Expected consequences of this choice (reasoned, not measured): blocking plain
// Applebot removes the site from Siri/Spotlight surfacing, and blocking
// ChatGPT-User/OAI-SearchBot stops ChatGPT retrieval and search citation.
export const BLOCKED_BY_EDITORIAL_CHOICE = [
  "ChatGPT-User",
  "OAI-SearchBot",
  "Applebot",
] as const;

export default function robots(): MetadataRoute.Robots {
  const rules: MetadataRoute.Robots["rules"] = [
    {
      userAgent: "*",
      allow: "/",
      // Trailing slash matters: "/api/" blocks the JSON endpoints under
      // /api/... (facilities, stats, search, contribute, submissions) but
      // not the bare "/api" path, which is a permanent redirect to /data
      // (app/api/page.tsx) and is not in the sitemap.
      //
      // "/access/dataset" (no trailing slash) is the personal download page: its URL
      // carries a live access token. The disallow keeps compliant crawlers from
      // fetching it at all; the page's noindex + X-Robots-Tag cover a crawler
      // that arrives via a link anyway. The public request page "/access" is not
      // a prefix of it and stays crawlable.
      disallow: ["/admin/", "/api/", "/access/dataset"],
      // Content-Signal (contentsignals.org): search indexing yes, AI input
      // (grounding / retrieval / citation) yes, training no. This is the
      // 2026-10-15 decision (Ed) and matches the User-Agent blocks below, which
      // allow AI assistants and AI search while blocking training crawlers. It
      // speaks to crawlers that read the directive but not our User-Agent
      // blocks, and it matches the CC BY 4.0 data licence's reuse-with-
      // attribution terms.
      //
      // It does not sit perfectly with the Google-Extended exemption above.
      // Content-Signal has no per-agent form, so on the "*" rule it also tells
      // Google-Extended ai-train=no -- stricter than the exemption this file goes
      // out of its way to preserve. It ships anyway because Content-Signal
      // states a PREFERENCE, whereas the User-Agent blocks below are the
      // enforceable statement, which still exempts Google-Extended. Resolving
      // the tension (varying the signal per agent, or dropping ai-train=no) is
      // a policy call and is deliberately NOT made here.
      //
      // The "# Citation" / "# Licence" entries below are comments, not
      // directives -- confirmed against Next's own serializer
      // (node_modules/next/dist/build/webpack/loaders/metadata/resolve-route-data.js),
      // which emits every `other` entry as a literal "key: value" line with
      // no bare-comment affordance, so a key starting with "#" is the only
      // way to land a line every robots.txt parser discards. No parser acts
      // on these two lines; the audience is the person deciding how to take
      // the data. The "# Citation" line points at /data, never at a data file.
      other: {
        "Content-Signal": "search=yes,ai-input=yes,ai-train=no",
        "# Citation": `How to cite Compute Atlas and its facility pages -- see ${siteConfig.url}/data`,
        "# Licence": `Data is CC-BY-4.0, attribution required -- ${DATASET_LICENSE_URL}. Code is MIT.`,
      },
    },
    ...BLOCKED_AI_CRAWLERS.map((userAgent) => ({
      userAgent,
      disallow: "/",
    })),
    ...BLOCKED_BULK_EXTRACTORS.map((userAgent) => ({
      userAgent,
      disallow: "/",
    })),
    ...BLOCKED_SEO_CRAWLERS.map((userAgent) => ({
      userAgent,
      disallow: "/",
    })),
    ...BLOCKED_BY_EDITORIAL_CHOICE.map((userAgent) => ({
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
