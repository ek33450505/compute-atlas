import { describe, it, expect } from "vitest";
import { generateStaticParams } from "./[county]/page";
import { getCounties } from "@/lib/data";

/**
 * Verifies that generateStaticParams produces exactly one { county } entry
 * per tracked county — including the single-facility counties the sitemap
 * deliberately does not submit (MIN_FACILITIES_FOR_COUNTY_SITEMAP), since
 * those routes still have to be generated, live and linkable. Pure data, no
 * renders. Mirrors app/metros/metro-params.test.ts.
 */
describe("generateStaticParams (county)", () => {
  it("returns one param per tracked county", async () => {
    const params = await generateStaticParams();
    const counties = await getCounties();
    expect(params).toHaveLength(counties.length);
  });

  it("each param's county is a slug from getCounties()", async () => {
    const params = await generateStaticParams();
    const slugs = (await getCounties()).map((c) => c.slug);
    for (const p of params) {
      expect(slugs).toContain(p.county);
    }
  });

  it("covers every county exactly once", async () => {
    const params = await generateStaticParams();
    const paramSlugs = params.map((p) => p.county).sort();
    const countySlugs = (await getCounties()).map((c) => c.slug).sort();
    expect(paramSlugs).toEqual(countySlugs);
  });

  it("includes single-facility counties, which the sitemap omits but the router must still generate", async () => {
    const params = await generateStaticParams();
    const singleFacilityCounty = (await getCounties()).find((c) => c.count === 1);
    expect(singleFacilityCounty).toBeDefined();
    expect(params.map((p) => p.county)).toContain(singleFacilityCounty!.slug);
  });
});
