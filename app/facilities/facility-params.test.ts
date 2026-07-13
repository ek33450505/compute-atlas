import { describe, it, expect } from "vitest";
import { generateStaticParams } from "./[slug]/page";
import { getAllFacilities } from "@/lib/data";

/**
 * Verifies that generateStaticParams produces exactly one { slug } entry
 * per facility — no renders, no WebGL, pure data.
 */
describe("generateStaticParams", () => {
  it("returns one slug per facility", async () => {
    const params = await generateStaticParams();
    const facilities = await getAllFacilities();
    expect(params).toHaveLength(facilities.length);
  });

  it("each param has a slug field", async () => {
    const params = await generateStaticParams();
    for (const p of params) {
      expect(p).toHaveProperty("slug");
      expect(typeof p.slug).toBe("string");
      expect(p.slug.length).toBeGreaterThan(0);
    }
  });

  it("slug values match facility ids", async () => {
    const params = await generateStaticParams();
    const facilities = await getAllFacilities();
    const slugs = params.map((p) => p.slug).sort();
    const ids = facilities.map((f) => f.id).sort();
    expect(slugs).toEqual(ids);
  });
});
