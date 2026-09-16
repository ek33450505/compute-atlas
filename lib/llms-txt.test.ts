import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import robots from "@/app/robots";
import { DATASET_DOI_URL } from "@/lib/seo";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

/**
 * `public/llms.txt` is hand-written and served verbatim — nothing regenerates
 * it, so every fact it restates can go stale in silence. These tests are the
 * substitute for that missing build step: each one pins the file against the
 * code that owns the fact, so changing the DOI, the licence deed, the site URL
 * or the Content-Signal directive turns this file red instead of leaving a
 * published document quietly wrong.
 */
const LLMS_TXT = readFileSync(path.join(process.cwd(), "public/llms.txt"), "utf8");

describe("public/llms.txt", () => {
  it("cites the canonical DOI that lib/seo.ts owns", () => {
    expect(LLMS_TXT).toContain(DATASET_DOI_URL);
  });

  it("names the licence deed that the JSON-LD and the API Link header use", () => {
    expect(LLMS_TXT).toContain(DATASET_LICENSE_URL);
  });

  it("keeps the dual licence intact — MIT for code, CC BY 4.0 for data", () => {
    expect(LLMS_TXT).toContain("MIT");
    expect(LLMS_TXT).toContain("CC BY 4.0");
    expect(LLMS_TXT).toContain("LICENSE-DATA");
  });

  it("uses the site's own canonical URL", () => {
    expect(LLMS_TXT).toContain(siteConfig.url);
  });

  it("restates the Content-Signal directive exactly as robots.txt emits it", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const signal = ruleList[0].other?.["Content-Signal"];

    expect(typeof signal).toBe("string");
    expect(LLMS_TXT).toContain(`Content-Signal: ${signal}`);
  });

  it("carries no facility, source or other moving count", () => {
    // The file has no build step, so a live number in it goes stale silently.
    // Every number it may legitimately contain is part of a fixed token: the
    // licence version (CC BY 4.0), the DOI (10.5281/zenodo.22284476). Anything
    // else that reads like a tally — "1,929 facilities", "934 records" — is a
    // figure that will drift. Point at /api/stats instead.
    expect(LLMS_TXT).not.toMatch(/\d[\d,]*\s+(facilities|records|sites|sources|operators|states)\b/i);
    expect(LLMS_TXT).toMatch(/\/api\/stats/);
  });
});
