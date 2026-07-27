import { describe, it, expect } from "vitest";
import { generateStaticParams } from "./[metro]/page";
import { METROS } from "@/lib/metros";

/**
 * Verifies that generateStaticParams produces exactly one { metro } entry
 * per curated metro in METROS — pure data, no renders. Mirrors
 * app/status/status-params.test.ts.
 */
describe("generateStaticParams (metro)", () => {
  it("returns one param per metro in METROS", async () => {
    const params = await generateStaticParams();
    expect(params).toHaveLength(METROS.length);
  });

  it("each param's metro is a slug from METROS", async () => {
    const params = await generateStaticParams();
    const slugs = METROS.map((m) => m.slug);
    for (const p of params) {
      expect(slugs).toContain(p.metro);
    }
  });

  it("covers every metro exactly once", async () => {
    const params = await generateStaticParams();
    const paramSlugs = params.map((p) => p.metro).sort();
    const metroSlugs = METROS.map((m) => m.slug).sort();
    expect(paramSlugs).toEqual(metroSlugs);
  });
});
