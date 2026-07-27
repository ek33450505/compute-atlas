import { describe, it, expect } from "vitest";
import robots from "@/app/robots";
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
});
