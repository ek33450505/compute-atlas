import { describe, it, expect } from "vitest";
import robots, { BLOCKED_AI_CRAWLERS } from "@/app/robots";
import { siteConfig } from "@/lib/site";

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
    expect(result.sitemap).toBe(`${siteConfig.url}/sitemap.xml`);
  });

  it("does NOT block Google-Extended (regression guard: this dataset wants to be cited in Gemini/AI Overviews)", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const userAgents = ruleList.map((rule) => rule.userAgent);
    expect(userAgents).not.toContain("Google-Extended");
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

  it("keeps the '*' group's allow/disallow behavior intact alongside the AI-crawler rules", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const wildcard = ruleList[0];

    expect(wildcard.userAgent).toBe("*");
    expect(wildcard.allow).toBe("/");
    expect(wildcard.disallow).toEqual(["/admin/", "/api/"]);
  });
});
