import { describe, it, expect } from "vitest";
import { buildStaticRoutes, buildFacilityRoutes } from "@/app/sitemap";
import { getAllFacilities } from "@/lib/data";
import { siteConfig } from "@/lib/site";

describe("sitemap", () => {
  it("static routes include /, /map, /table, /stats, and /about", () => {
    const routes = buildStaticRoutes();
    const urls = routes.map((r) => r.url);
    expect(urls).toContain(siteConfig.url);
    expect(urls).toContain(`${siteConfig.url}/map`);
    expect(urls).toContain(`${siteConfig.url}/table`);
    expect(urls).toContain(`${siteConfig.url}/stats`);
    expect(urls).toContain(`${siteConfig.url}/about`);
  });

  it("facility routes count equals facilities.length", () => {
    const facilityRoutes = buildFacilityRoutes();
    const facilities = getAllFacilities();
    expect(facilityRoutes).toHaveLength(facilities.length);
  });

  it("total route count equals facilities.length + 5", () => {
    const staticRoutes = buildStaticRoutes();
    const facilityRoutes = buildFacilityRoutes();
    const total = staticRoutes.length + facilityRoutes.length;
    const facilities = getAllFacilities();
    expect(total).toBe(facilities.length + 5);
  });

  it("all URLs are absolute and under siteConfig.url", () => {
    const allRoutes = [...buildStaticRoutes(), ...buildFacilityRoutes()];
    for (const route of allRoutes) {
      expect(route.url).toMatch(/^https?:\/\//);
      expect(route.url).toContain(siteConfig.url);
    }
  });

  it("facility routes use /facilities/:id pattern under siteConfig.url", () => {
    const facilityRoutes = buildFacilityRoutes();
    const facilities = getAllFacilities();
    for (const f of facilities) {
      const entry = facilityRoutes.find((r) =>
        r.url.endsWith(`/facilities/${f.id}`)
      );
      expect(entry).toBeDefined();
      expect(entry!.url).toBe(`${siteConfig.url}/facilities/${f.id}`);
    }
  });
});
