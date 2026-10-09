import { describe, it, expect } from "vitest";

import { isCommunityDiscoveredBy } from "./community-provenance";

describe("isCommunityDiscoveredBy", () => {
  it.each([
    "public-contribution",
    "public-correction",
    "leads-lane",
    "lead:123e4567-e89b-12d3-a456-426614174000",
    "lead:x",
  ])("is true for %s", (value) => {
    expect(isCommunityDiscoveredBy(value)).toBe(true);
  });

  it.each(["discovery-pipeline", "manual", "", "leads", "lead", " lead:x", "Public-Contribution"])(
    "is false for %j",
    (value) => {
      expect(isCommunityDiscoveredBy(value)).toBe(false);
    }
  );

  it("is false for null and undefined", () => {
    expect(isCommunityDiscoveredBy(null)).toBe(false);
    expect(isCommunityDiscoveredBy(undefined)).toBe(false);
  });
});
