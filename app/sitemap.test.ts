import { describe, it, expect } from "vitest";
import {
  buildStaticRoutes,
  buildStateRoutes,
  buildFacilityRoutes,
} from "@/app/sitemap";
import { getAllFacilities, getStates } from "@/lib/data";
import { stateSlugFromCode } from "@/lib/us-states";
import { siteConfig } from "@/lib/site";

describe("sitemap", () => {
  it("static routes include /, /map, /table, /states, /stats, and /about", () => {
    const routes = buildStaticRoutes();
    const urls = routes.map((r) => r.url);
    expect(urls).toContain(siteConfig.url);
    expect(urls).toContain(`${siteConfig.url}/map`);
    expect(urls).toContain(`${siteConfig.url}/table`);
    expect(urls).toContain(`${siteConfig.url}/states`);
    expect(urls).toContain(`${siteConfig.url}/stats`);
    expect(urls).toContain(`${siteConfig.url}/about`);
  });

  it("facility routes count equals facilities.length", () => {
    const facilityRoutes = buildFacilityRoutes();
    const facilities = getAllFacilities();
    expect(facilityRoutes).toHaveLength(facilities.length);
  });

  it("state routes count equals getStates().length, with no undefined slugs", () => {
    const stateRoutes = buildStateRoutes();
    const states = getStates();
    expect(stateRoutes).toHaveLength(states.length);
    for (const code of states) {
      const expectedUrl = `${siteConfig.url}/states/${stateSlugFromCode(code)}`;
      const entry = stateRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();
      expect(entry!.url).not.toContain("undefined");
    }
  });

  it("total route count equals the sum of all three builders", () => {
    const staticRoutes = buildStaticRoutes();
    const stateRoutes = buildStateRoutes();
    const facilityRoutes = buildFacilityRoutes();
    const total = staticRoutes.length + stateRoutes.length + facilityRoutes.length;
    expect(total).toBe(
      buildStaticRoutes().length +
        buildStateRoutes().length +
        buildFacilityRoutes().length
    );
  });

  it("all URLs are absolute and under siteConfig.url", () => {
    const allRoutes = [
      ...buildStaticRoutes(),
      ...buildStateRoutes(),
      ...buildFacilityRoutes(),
    ];
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
