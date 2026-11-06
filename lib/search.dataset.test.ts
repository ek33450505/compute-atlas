import { describe, it, expect } from "vitest";
import { getAllFacilities } from "@/lib/data";
import { buildNavSearchIndex } from "@/lib/search-index";

// Real-dataset half (DATASET=real) of search.test.ts: the nav index is bounded
// by operators + states, not by dataset size.
describe("buildNavSearchIndex", () => {
  it("ships fewer entries than there are facilities — the payload win", async () => {
    const facilities = await getAllFacilities();
    const navIndex = await buildNavSearchIndex();
    // The invariant the old ratio was reaching for, stated without a magic factor.
    // Also guards a silently tiny import: with a few facilities this is trivially
    // false, so the floor makes the comparison mean something.
    expect(facilities.length).toBeGreaterThan(1000);
    expect(navIndex.length).toBeLessThan(facilities.length);
  });
});
