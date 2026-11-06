import { describe, it, expect } from "vitest";
import { SITEMAP_FAMILIES } from "@/lib/sitemap-families";

describe("SITEMAP_FAMILIES set equality (regrouping, not pruning)", () => {
  // This is a FLOOR, not an expected value — GSC reports 2,959 URLs in
  // today's flat sitemap, but this test does not need updating as the
  // dataset grows. It exists to catch a family silently returning `[]`,
  // which the set-equality check in sitemap-families.test.ts would NOT catch
  // on its own if a bug made both the family path and the direct-builder path
  // collapse to the same (wrong) empty result.
  it("totals more than 2900 URLs across all families", async () => {
    const familyResults = await Promise.all(SITEMAP_FAMILIES.map((f) => f.build()));
    const total = familyResults.reduce((sum, r) => sum + r.length, 0);
    expect(total).toBeGreaterThan(2900);
  });
});
