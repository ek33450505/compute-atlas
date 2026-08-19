import { describe, it, expect } from "vitest";
import {
  buildStaticRoutes,
  buildStateRoutes,
  buildOperatorRoutes,
  buildFacilityRoutes,
  buildStatusRoutes,
  buildMetroRoutes,
  buildLearnRoutes,
} from "@/app/sitemap";
import { getAllFacilities, getStates, getOperators, operatorSlug } from "@/lib/data";
import { stateSlugFromCode } from "@/lib/us-states";
import { STATUS_ORDER } from "@/lib/status";
import { METROS } from "@/lib/metros";
import { GLOSSARY_TOPICS } from "@/lib/glossary";
import { siteConfig } from "@/lib/site";

describe("sitemap", () => {
  it("static routes include /, /map, /table, /states, /power, /opposition, /stats, /about, /explore, /activity, and /contribute", async () => {
    const routes = await buildStaticRoutes();
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
    expect(urls).toContain(`${siteConfig.url}/activity`);
    expect(urls).toContain(`${siteConfig.url}/contribute`);
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

  it("status routes include /status and all 5 /status/:value routes", async () => {
    const statusRoutes = await buildStatusRoutes();
    const urls = statusRoutes.map((r) => r.url);
    expect(urls).toContain(`${siteConfig.url}/status`);
    expect(urls).toContain(`${siteConfig.url}/status/proposed`);
    for (const status of STATUS_ORDER) {
      expect(urls).toContain(`${siteConfig.url}/status/${status}`);
    }
    // 1 index + 5 per-status entries, no duplicates.
    expect(statusRoutes).toHaveLength(STATUS_ORDER.length + 1);
  });

  it("metro routes include /metros and all 27 /metros/:slug routes, including northern-virginia", async () => {
    const metroRoutes = await buildMetroRoutes();
    const urls = metroRoutes.map((r) => r.url);
    expect(urls).toContain(`${siteConfig.url}/metros`);
    expect(urls).toContain(`${siteConfig.url}/metros/northern-virginia`);
    for (const m of METROS) {
      expect(urls).toContain(`${siteConfig.url}/metros/${m.slug}`);
    }
    // 1 index + 27 per-metro entries, no duplicates.
    expect(metroRoutes).toHaveLength(METROS.length + 1);
  });

  it("learn routes include /learn and all 5 /learn/:slug routes, derived from GLOSSARY_TOPICS", () => {
    const learnRoutes = buildLearnRoutes();
    const urls = learnRoutes.map((r) => r.url);
    expect(urls).toContain(`${siteConfig.url}/learn`);
    for (const topic of GLOSSARY_TOPICS) {
      expect(urls).toContain(`${siteConfig.url}/learn/${topic.slug}`);
    }
    // 1 index + 5 per-topic entries, no duplicates.
    expect(learnRoutes).toHaveLength(GLOSSARY_TOPICS.length + 1);
  });

  it("state hub lastModified is derived from the state's facilities, not 'new Date()' now", async () => {
    const testStart = Date.now();
    const stateRoutes = await buildStateRoutes();
    const facilities = await getAllFacilities();
    const states = await getStates();
    for (const code of states) {
      const expectedUrl = `${siteConfig.url}/states/${stateSlugFromCode(code)}`;
      const entry = stateRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();

      const stateFacilities = facilities.filter((f) => f.location.state === code);
      const expectedMax = Math.max(
        ...stateFacilities.map((f) => new Date(f.lastUpdated).getTime())
      );
      const actual = entry!.lastModified as Date;
      expect(actual.getTime()).toBe(expectedMax);
      // Proves the value is real facility data, not build-time "now".
      expect(actual.getTime()).toBeLessThan(testStart);
    }
  });

  it("operator hub lastModified is derived from the operator's facilities, not 'new Date()' now", async () => {
    const testStart = Date.now();
    const operatorRoutes = await buildOperatorRoutes();
    const facilities = await getAllFacilities();
    const operators = await getOperators();
    for (const name of operators) {
      const expectedUrl = `${siteConfig.url}/operators/${operatorSlug(name)}`;
      const entry = operatorRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();

      const operatorFacilities = facilities.filter((f) => f.operator === name);
      const expectedMax = Math.max(
        ...operatorFacilities.map((f) => new Date(f.lastUpdated).getTime())
      );
      const actual = entry!.lastModified as Date;
      expect(actual.getTime()).toBe(expectedMax);
      // Proves the value is real facility data, not build-time "now".
      expect(actual.getTime()).toBeLessThan(testStart);
    }
  });

  it("total route count equals the sum of all five builders", async () => {
    const staticRoutes = await buildStaticRoutes();
    const stateRoutes = await buildStateRoutes();
    const operatorRoutes = await buildOperatorRoutes();
    const facilityRoutes = await buildFacilityRoutes();
    const statusRoutes = await buildStatusRoutes();
    const total =
      staticRoutes.length +
      stateRoutes.length +
      operatorRoutes.length +
      facilityRoutes.length +
      statusRoutes.length;
    expect(total).toBe(
      (await buildStaticRoutes()).length +
        (await buildStateRoutes()).length +
        (await buildOperatorRoutes()).length +
        (await buildFacilityRoutes()).length +
        (await buildStatusRoutes()).length
    );
  });

  it("all URLs are absolute and under siteConfig.url", async () => {
    const allRoutes = [
      ...(await buildStaticRoutes()),
      ...(await buildStateRoutes()),
      ...(await buildOperatorRoutes()),
      ...(await buildFacilityRoutes()),
      ...(await buildStatusRoutes()),
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

  it("static routes' lastModified does not change across two calls made at different wall-clock times", async () => {
    const first = await buildStaticRoutes();
    // A real, non-zero clock advance between calls — the bug this guards
    // against is `new Date()` baked into every entry, which would differ
    // between these two calls even a millisecond apart.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await buildStaticRoutes();

    expect(first).toHaveLength(second.length);
    for (let i = 0; i < first.length; i++) {
      expect(first[i].url).toBe(second[i].url);
      const a = first[i].lastModified as Date;
      const b = second[i].lastModified as Date;
      expect(a.getTime()).toBe(b.getTime());
    }
  });

  it("dataset-backed static routes (e.g. /) use the dataset's real max lastUpdated, not 'now'", async () => {
    const testStart = Date.now();
    const routes = await buildStaticRoutes();
    const facilities = await getAllFacilities();
    const expectedMax = Math.max(
      ...facilities.map((f) => new Date(f.lastUpdated).getTime())
    );

    const home = routes.find((r) => r.url === siteConfig.url);
    expect(home).toBeDefined();
    const actual = home!.lastModified as Date;
    expect(actual.getTime()).toBe(expectedMax);
    // Proves the value is real facility data, not build-time "now".
    expect(actual.getTime()).toBeLessThan(testStart);
  });

  it("genuinely static editorial routes (/about, /api, /contribute) use a stable date, not 'now'", async () => {
    const testStart = Date.now();
    const routes = await buildStaticRoutes();
    for (const path of ["/about", "/api", "/contribute"]) {
      const entry = routes.find((r) => r.url === `${siteConfig.url}${path}`);
      expect(entry).toBeDefined();
      const actual = entry!.lastModified as Date;
      expect(actual.getTime()).toBeLessThan(testStart);
    }
  });
});
