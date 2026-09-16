import { describe, it, expect } from "vitest";
// Next's own robots.txt serializer, the function the build actually runs on
// this route's return value. Imported from a private path deliberately: the
// object-shape assertions below prove what we return, only this proves the
// line reaches the file. If a Next upgrade moves it, the import error is the
// signal to re-verify that `other` still emits what we think it does.
import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import robots, { BLOCKED_AI_CRAWLERS } from "@/app/robots";
import { siteConfig } from "@/lib/site";

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
});
