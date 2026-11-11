import { describe, it, expect } from "vitest";
import { siteConfig } from "@/lib/site";

describe("siteConfig.metaDescription", () => {
  it("stays within the SERP-safe length budget", () => {
    // Google renders ~155 chars on desktop, ~120 on mobile — this must be
    // short enough that the terms people search land before the cut.
    expect(siteConfig.metaDescription.length).toBeLessThanOrEqual(160);
  });

  it("is distinct from the long JSON-LD description", () => {
    // Guards against "tidying" the two back into one string — description
    // is deliberately long (it feeds Dataset/WebSite JSON-LD, where length
    // is an asset), metaDescription is deliberately short.
    expect(siteConfig.metaDescription).not.toBe(siteConfig.description);
  });

  it("description stays long enough to remain useful for Dataset JSON-LD", () => {
    // description must stay well over the meta-description budget — if it
    // ever shrinks to fit that budget, the split has silently been undone.
    expect(siteConfig.description.length).toBeGreaterThan(160);
  });
});
