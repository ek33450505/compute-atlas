import { describe, it, expect } from "vitest";
import {
  buildStaticRoutes,
  buildStateRoutes,
  buildOperatorRoutes,
  buildFacilityRoutes,
} from "@/app/sitemap";
import { getAllFacilities, getStates, getOperators, operatorSlug } from "@/lib/data";
import { stateSlugFromCode } from "@/lib/us-states";
import { siteConfig } from "@/lib/site";

describe("sitemap", () => {
  it("static routes include /, /map, /table, /states, /power, /opposition, /stats, /about, and /explore", () => {
    const routes = buildStaticRoutes();
    const urls = routes.map((r) => r.url);
    expect(urls).toContain(siteConfig.url);
    expect(urls).toContain(`${siteConfig.url}/map`);
    expect(urls).toContain(`${siteConfig.url}/table`);
    expect(urls).toContain(`${siteConfig.url}/states`);
    expect(urls).toContain(`${siteConfig.url}/operators`);
    expect(urls).toContain(`${siteConfig.url}/power`);
    expect(urls).toContain(`${siteConfig.url}/opposition`);
    expect(urls).toContain(`${siteConfig.url}/stats`);
    expect(urls).toContain(`${siteConfig.url}/about`);
    expect(urls).toContain(`${siteConfig.url}/explore`);
  });

  it("facility routes count equals facilities.length", async () => {
    const facilityRoutes = await buildFacilityRoutes();
    const facilities = await getAllFacilities();
    expect(facilityRoutes).toHaveLength(facilities.length);
  });

  it("state routes count equals getStates().length, with no undefined slugs", async () => {
    const stateRoutes = await buildStateRoutes();
    const states = await getStates();
    expect(stateRoutes).toHaveLength(states.length);
    for (const code of states) {
      const expectedUrl = `${siteConfig.url}/states/${stateSlugFromCode(code)}`;
      const entry = stateRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();
      expect(entry!.url).not.toContain("undefined");
    }
  });

  it("operator routes count equals getOperators().length, with no undefined slugs", async () => {
    const operatorRoutes = await buildOperatorRoutes();
    const operators = await getOperators();
    expect(operatorRoutes).toHaveLength(operators.length);
    for (const name of operators) {
      const expectedUrl = `${siteConfig.url}/operators/${operatorSlug(name)}`;
      const entry = operatorRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();
      expect(entry!.url).not.toContain("undefined");
    }
  });

  it("total route count equals the sum of all four builders", async () => {
    const staticRoutes = buildStaticRoutes();
    const stateRoutes = await buildStateRoutes();
    const operatorRoutes = await buildOperatorRoutes();
    const facilityRoutes = await buildFacilityRoutes();
    const total =
      staticRoutes.length +
      stateRoutes.length +
      operatorRoutes.length +
      facilityRoutes.length;
    expect(total).toBe(
      buildStaticRoutes().length +
        (await buildStateRoutes()).length +
        (await buildOperatorRoutes()).length +
        (await buildFacilityRoutes()).length
    );
  });

  it("all URLs are absolute and under siteConfig.url", async () => {
    const allRoutes = [
      ...buildStaticRoutes(),
      ...(await buildStateRoutes()),
      ...(await buildOperatorRoutes()),
      ...(await buildFacilityRoutes()),
    ];
    for (const route of allRoutes) {
      expect(route.url).toMatch(/^https?:\/\//);
      expect(route.url).toContain(siteConfig.url);
    }
  });

  it("facility routes use /facilities/:id pattern under siteConfig.url", async () => {
    const facilityRoutes = await buildFacilityRoutes();
    const facilities = await getAllFacilities();
    for (const f of facilities) {
      const entry = facilityRoutes.find((r) =>
        r.url.endsWith(`/facilities/${f.id}`)
      );
      expect(entry).toBeDefined();
      expect(entry!.url).toBe(`${siteConfig.url}/facilities/${f.id}`);
    }
  });
});
