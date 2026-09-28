import { describe, it, expect } from "vitest";
// Next's own robots.txt serializer, the function the build actually runs on
// this route's return value. Imported from a private path deliberately: the
// object-shape assertions below prove what we return, only this proves the
// line reaches the file. If a Next upgrade moves it, the import error is the
// signal to re-verify that `other` still emits what we think it does.
import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import robots, { BLOCKED_AI_CRAWLERS, BLOCKED_SEO_CRAWLERS } from "@/app/robots";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";
import { SITEMAP_FAMILY_IDS, SITEMAP_INDEX_URL, sitemapChildUrl } from "@/lib/sitemap-families";

const CONTENT_SIGNAL = "search=yes,ai-train=no,use=reference";

describe("robots", () => {
  it("allows / and disallows /admin/ and /api/", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
    expect(rule.disallow).toEqual(["/admin/", "/api/"]);
  });

  it("disallow /api/ (trailing slash) does not match the bare /api doc page path", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallowList = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    // Standard robots.txt prefix matching: "/api/" matches paths starting
    // with "/api/" but not the exact "/api" path (no trailing slash).
    for (const pattern of disallowList) {
      if (!pattern) continue;
      expect("/api".startsWith(pattern)).toBe(false);
    }
  });

  it("points at the site's sitemap.xml", () => {
    const result = robots();
    expect(result.sitemap).toContain(`${siteConfig.url}/sitemap.xml`);
  });

  it("lists the sitemap index plus every family child, derived from the registry, each exactly once", () => {
    const result = robots();
    const sitemap = result.sitemap;
    expect(Array.isArray(sitemap)).toBe(true);
    const sitemapList = sitemap as string[];

    // Length pins the exact composition: the index + one entry per family,
    // no more, no fewer — so a stray duplicate or a dropped family fails
    // this even if the "contains" assertions below happen to still pass.
    expect(sitemapList).toHaveLength(1 + SITEMAP_FAMILY_IDS.length);

    expect(sitemapList).toContain(SITEMAP_INDEX_URL);
    for (const id of SITEMAP_FAMILY_IDS) {
      expect(sitemapList).toContain(sitemapChildUrl(id));
    }

    // Exactly once each — a duplicate entry would satisfy every assertion
    // above while still being wrong.
    expect(new Set(sitemapList).size).toBe(sitemapList.length);
  });

  it("does NOT block Google-Extended (regression guard: this dataset wants to be cited in Gemini/AI Overviews)", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const userAgents = ruleList.map((rule) => rule.userAgent);
    expect(userAgents).not.toContain("Google-Extended");
  });

  it("does NOT block AhrefsBot or SemrushBot (regression guard: Ed relies on them for backlink-profile visibility)", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const userAgents = ruleList.map((rule) => rule.userAgent);
    expect(userAgents).not.toContain("AhrefsBot");
    expect(userAgents).not.toContain("SemrushBot");
  });

  it("disallows / for every entry in BLOCKED_AI_CRAWLERS, with no allow", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];

    for (const agent of BLOCKED_AI_CRAWLERS) {
      const rule = ruleList.find((r) => r.userAgent === agent);
      expect(rule).toBeDefined();
      expect(rule?.disallow).toBe("/");
      expect(rule?.allow).toBeUndefined();
    }
  });

  it("pins BLOCKED_AI_CRAWLERS against a hardcoded list", () => {
    // Hardcoded deliberately: the coverage test above iterates the same array
    // it's checking, so a token silently dropped from the source array would
    // still pass it. This list is the independent copy that goes red instead.
    //
    // Google-Extended is DELIBERATELY ABSENT from this list and must stay
    // absent -- app/robots.ts explains why, and the regression guard above
    // asserts it. This pin is not a checklist of every AI crawler that exists;
    // it's the exact set we chose to block. Don't "fix" it by adding one.
    expect([...BLOCKED_AI_CRAWLERS]).toEqual([
      "Amazonbot",
      "Applebot-Extended",
      "Bytespider",
      "CCBot",
      "ClaudeBot",
      "CloudflareBrowserRenderingCrawler",
      "GPTBot",
      "meta-externalagent",
    ]);
  });

  it("disallows / for every entry in BLOCKED_SEO_CRAWLERS, with no allow", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];

    for (const agent of BLOCKED_SEO_CRAWLERS) {
      const rule = ruleList.find((r) => r.userAgent === agent);
      expect(rule).toBeDefined();
      expect(rule?.disallow).toBe("/");
      expect(rule?.allow).toBeUndefined();
    }
  });

  it("pins the literal contents of BLOCKED_SEO_CRAWLERS against a hardcoded list, independent of the array itself (a token silently dropped from the source array would still pass the coverage test above, since that test iterates the same array it's checking)", () => {
    expect([...BLOCKED_SEO_CRAWLERS]).toEqual([
      "DataForSeoBot",
      "dotbot",
      "QlyzeBot",
      "SERankingBacklinksBot",
    ]);
  });

  it("carries the Content-Signal directive on the '*' rule, verbatim", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.other?.["Content-Signal"]).toBe(CONTENT_SIGNAL);
  });

  it("declares Content-Signal exactly once, and only on the '*' rule", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    // Scoping matters: Next emits an `other` entry inside the User-Agent
    // block it sits on, so the same directive on a blocked-crawler rule would
    // read as "ai-train=no applies to GPTBot only" -- narrower than intended.
    const carriers = ruleList.filter((r) => r.other?.["Content-Signal"] !== undefined);
    expect(carriers).toHaveLength(1);
    expect(carriers[0].userAgent).toBe("*");
  });

  it("emits Content-Signal into the served robots.txt, inside the '*' block", () => {
    const text = resolveRobots(robots());
    const blocks = text.split("\n\n");
    const wildcard = blocks.find((block) => block.startsWith("User-Agent: *\n"));

    expect(wildcard).toBeDefined();
    expect(wildcard).toContain(`Content-Signal: ${CONTENT_SIGNAL}`);
    // ...and nowhere else in the file.
    expect(text.match(/^Content-Signal:/gm)).toHaveLength(1);
  });

  it("keeps the '*' group's allow/disallow behavior intact alongside the AI-crawler rules", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const wildcard = ruleList[0];

    expect(wildcard.userAgent).toBe("*");
    expect(wildcard.allow).toBe("/");
    expect(wildcard.disallow).toEqual(["/admin/", "/api/"]);
  });

  it("carries the bulk-data and licence comments on the '*' rule, keyed with a leading '#'", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.userAgent).toBe("*");

    const bulkData = rule.other?.["# Bulk data"];
    const licence = rule.other?.["# Licence"];
    expect(typeof bulkData).toBe("string");
    expect(typeof licence).toBe("string");
    // Points at the human download page and the raw single-file export, not
    // at page-by-page HTML -- that's the entire point of this comment.
    expect(bulkData).toContain(`${siteConfig.url}/data`);
    expect(bulkData).toContain("raw.githubusercontent.com");
    expect(bulkData).toContain("data/facilities.json");
    // States the licence condition plainly, without inventing a URL.
    expect(licence).toContain(DATASET_LICENSE_URL);
    expect(licence).toContain("CC-BY-4.0");
  });

  it("gives every '#'-prefixed other-entry a defined value (a null/undefined value is silently dropped by the serializer)", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const commentEntries = Object.entries(rule.other ?? {}).filter(([key]) => key.startsWith("#"));

    // A filter that happened to match nothing would make every assertion
    // below vacuously pass -- pin the count so this test can't go quiet.
    expect(commentEntries).toHaveLength(2);
    for (const [key, value] of commentEntries) {
      expect(value, `"${key}" must carry a defined value`).not.toBeUndefined();
      expect(value, `"${key}" must carry a defined value`).not.toBeNull();
    }
  });

  it("emits the bulk-data and licence comments as '#'-prefixed lines in the served robots.txt, inside the '*' block", () => {
    const text = resolveRobots(robots());
    const blocks = text.split("\n\n");
    const wildcard = blocks.find((block) => block.startsWith("User-Agent: *\n"));
    expect(wildcard).toBeDefined();

    const lines = (wildcard as string).split("\n").filter((line) => line.length > 0);
    const bulkLine = lines.find((line) => line.startsWith("# Bulk data:"));
    const licenceLine = lines.find((line) => line.startsWith("# Licence:"));
    expect(bulkLine).toBeDefined();
    expect(licenceLine).toBeDefined();

    // Every non-blank line in this block is either a real directive or a
    // "#"-prefixed comment -- nothing that would confuse a real parser.
    for (const line of lines) {
      const isKnownDirective = /^(User-Agent|Allow|Disallow|Content-Signal):/.test(line);
      expect(isKnownDirective || line.startsWith("#")).toBe(true);
    }
  });

  it("pins the exact set and order of every blocked-crawler rule (AI + SEO), '*' rule unchanged", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const wildcard = ruleList[0];

    expect(wildcard.userAgent).toBe("*");
    expect(wildcard.allow).toBe("/");
    expect(wildcard.disallow).toEqual(["/admin/", "/api/"]);

    // Exact set AND order of every non-"*" rule -- catches a stray added or
    // dropped crawler rule that the per-entry check below wouldn't. AI
    // crawlers are listed first, then SEO-resale crawlers, matching the order
    // robots() builds the rules array in.
    const blockedAgents = ruleList.slice(1).map((rule) => rule.userAgent);
    expect(blockedAgents).toEqual([...BLOCKED_AI_CRAWLERS, ...BLOCKED_SEO_CRAWLERS]);
    for (const rule of ruleList.slice(1)) {
      expect(rule.disallow).toBe("/");
      expect(rule.allow).toBeUndefined();
    }
  });
});
