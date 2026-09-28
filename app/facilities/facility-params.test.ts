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

  // The cases above run with VERCEL_ENV unset, which is the full-corpus path
  // (local build and GitHub-Actions CI). This one proves previewSubset is
  // actually wired in — without the wrapper it would return all ~1,700 ids.
  it("prerenders only a subset on a Vercel preview build", async () => {
    const original = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "preview";
    try {
      const params = await generateStaticParams();
      const ids = new Set((await getAllFacilities()).map((f) => f.id));
      expect(params).toHaveLength(10);
      for (const p of params) expect(ids.has(p.slug)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = original;
    }
  });
});
