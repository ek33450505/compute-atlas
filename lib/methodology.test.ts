import { describe, it, expect } from "vitest";

import {
  METHODOLOGY_MARKDOWN,
  METHODOLOGY_BODY_MARKDOWN,
  resolveMethodologyLink,
} from "@/lib/methodology";
import { siteConfig } from "@/lib/site";

describe("METHODOLOGY_MARKDOWN", () => {
  it("reads a non-empty docs/methodology.md", () => {
    expect(METHODOLOGY_MARKDOWN.length).toBeGreaterThan(0);
    expect(METHODOLOGY_MARKDOWN).toContain("# Methodology");
    expect(METHODOLOGY_MARKDOWN).toContain("## Cooling type");
  });
});

describe("METHODOLOGY_BODY_MARKDOWN", () => {
  it("drops only the leading # Methodology line, keeping the rest verbatim", () => {
    expect(METHODOLOGY_BODY_MARKDOWN).not.toMatch(/^# Methodology/);
    expect(METHODOLOGY_BODY_MARKDOWN).toContain("## Cooling type");
    // Every character after the first line survives unchanged.
    const firstNewline = METHODOLOGY_MARKDOWN.indexOf("\n");
    expect(METHODOLOGY_BODY_MARKDOWN).toBe(
      METHODOLOGY_MARKDOWN.slice(firstNewline + 1)
    );
  });
});

describe("resolveMethodologyLink", () => {
  it("rewrites a docs-relative parent link to the repo root's GitHub blob URL", () => {
    expect(resolveMethodologyLink("../CONTRIBUTING.md")).toBe(
      `${siteConfig.repoUrl}/blob/main/CONTRIBUTING.md`
    );
    expect(resolveMethodologyLink("../lib/schema.ts")).toBe(
      `${siteConfig.repoUrl}/blob/main/lib/schema.ts`
    );
  });

  it("rewrites a docs-sibling link to a docs/ GitHub blob URL", () => {
    expect(resolveMethodologyLink("discovery-pipeline.md")).toBe(
      `${siteConfig.repoUrl}/blob/main/docs/discovery-pipeline.md`
    );
  });

  it("preserves an in-file fragment on a rewritten link", () => {
    expect(resolveMethodologyLink("../README.md#how-the-data-is-built")).toBe(
      `${siteConfig.repoUrl}/blob/main/README.md#how-the-data-is-built`
    );
  });

  it("leaves absolute URLs and same-page fragments unchanged", () => {
    expect(resolveMethodologyLink("https://epochai.org")).toBe("https://epochai.org");
    expect(resolveMethodologyLink("#cooling-type")).toBe("#cooling-type");
  });
});
