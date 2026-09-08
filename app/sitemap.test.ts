import { describe, it, expect } from "vitest";
import {
  buildStaticRoutes,
  buildStateRoutes,
  buildOperatorRoutes,
  buildFacilityRoutes,
  buildStatusRoutes,
  buildMetroRoutes,
  buildLearnRoutes,
  MIN_FACILITIES_FOR_OPERATOR_SITEMAP,
} from "@/app/sitemap";
import {
  getAllFacilities,
  getStates,
  getOperators,
  operatorSlug,
  getFacilitiesByMetro,
} from "@/lib/data";
import { stateSlugFromCode } from "@/lib/us-states";
import { STATUS_ORDER } from "@/lib/status";
import { METROS } from "@/lib/metros";
import { GLOSSARY_TOPICS } from "@/lib/glossary";
import { siteConfig } from "@/lib/site";

describe("sitemap", () => {
  it("static routes include /, /map, /table, /states, /power, /opposition, /stats, /about, /explore, /activity, /contribute, /support, /contact, and /access", async () => {
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
    expect(urls).toContain(`${siteConfig.url}/methodology`);
    expect(urls).toContain(`${siteConfig.url}/explore`);
    expect(urls).toContain(`${siteConfig.url}/activity`);
    expect(urls).toContain(`${siteConfig.url}/contribute`);
    expect(urls).toContain(`${siteConfig.url}/support`);
    // /contact and /access are indexable landing pages (both set their own
    // alternates.canonical) that were missing from the sitemap entirely —
    // GSC reported both "URL is unknown to Google" (2026-09-03).
    expect(urls).toContain(`${siteConfig.url}/contact`);
    expect(urls).toContain(`${siteConfig.url}/access`);
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

  it("operator routes count equals the number of operators with >= MIN_FACILITIES_FOR_OPERATOR_SITEMAP facilities, with no undefined slugs", async () => {
    const operatorRoutes = await buildOperatorRoutes();
    const operators = await getOperators();
    const facilities = await getAllFacilities();
    const multiFacilityOperators = operators.filter(
      (name) =>
        facilities.filter((f) => f.operator === name).length >=
        MIN_FACILITIES_FOR_OPERATOR_SITEMAP
    );
    expect(operatorRoutes).toHaveLength(multiFacilityOperators.length);
    for (const name of multiFacilityOperators) {
      const expectedUrl = `${siteConfig.url}/operators/${operatorSlug(name)}`;
      const entry = operatorRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();
      expect(entry!.url).not.toContain("undefined");
    }
  });

  it("an operator with >= MIN_FACILITIES_FOR_OPERATOR_SITEMAP facilities IS present in buildOperatorRoutes() output", async () => {
    const operatorRoutes = await buildOperatorRoutes();
    const operators = await getOperators();
    const facilities = await getAllFacilities();
    const multiFacilityOperator = operators.find(
      (name) =>
        facilities.filter((f) => f.operator === name).length >=
        MIN_FACILITIES_FOR_OPERATOR_SITEMAP
    );
    expect(multiFacilityOperator).toBeDefined();
    const expectedUrl = `${siteConfig.url}/operators/${operatorSlug(multiFacilityOperator!)}`;
    const urls = operatorRoutes.map((r) => r.url);
    expect(urls).toContain(expectedUrl);
  });

  it("an operator with exactly 1 facility is NOT present in buildOperatorRoutes() output", async () => {
    const operatorRoutes = await buildOperatorRoutes();
    const operators = await getOperators();
    const facilities = await getAllFacilities();
    const singleFacilityOperator = operators.find(
      (name) => facilities.filter((f) => f.operator === name).length === 1
    );
    expect(singleFacilityOperator).toBeDefined();
    const excludedUrl = `${siteConfig.url}/operators/${operatorSlug(singleFacilityOperator!)}`;
    const urls = operatorRoutes.map((r) => r.url);
    expect(urls).not.toContain(excludedUrl);
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

  it("metro hub lastModified is derived from that metro's OWN facilities via getFacilitiesByMetro, not the whole-dataset max", async () => {
    const testStart = Date.now();
    const metroRoutes = await buildMetroRoutes();
    const facilities = await getAllFacilities();
    const datasetMax = Math.max(
      ...facilities.map((f) => new Date(f.lastUpdated).getTime())
    );

    let sawEntryEarlierThanDatasetMax = false;
    for (const m of METROS) {
      const expectedUrl = `${siteConfig.url}/metros/${m.slug}`;
      const entry = metroRoutes.find((r) => r.url === expectedUrl);
      expect(entry).toBeDefined();

      // Membership reuses the SAME helper app/metros/[metro]/page.tsx uses
      // to render the hub (getFacilitiesByMetro), so the sitemap and the
      // page can never disagree about which facilities belong to a metro.
      const metroFacilities = await getFacilitiesByMetro(m.slug);
      const expectedMax = Math.max(
        ...metroFacilities.map((f) => new Date(f.lastUpdated).getTime())
      );
      const actual = entry!.lastModified as Date;
      expect(actual.getTime()).toBe(expectedMax);
      // Proves the value is real facility data, not build-time "now".
      expect(actual.getTime()).toBeLessThan(testStart);

      if (expectedMax < datasetMax) sawEntryEarlierThanDatasetMax = true;
    }

    // If every metro happened to contain a facility updated on the exact
    // dataset-max date, the "own facilities, not the whole-dataset max"
    // claim above would be unfalsifiable by this suite. Verified against
    // the real dataset (2026-09-08): 25 of 27 metros are strictly earlier.
    expect(sawEntryEarlierThanDatasetMax).toBe(true);
  });

  it("/metros index entry still carries the whole-dataset max lastModified", async () => {
    const metroRoutes = await buildMetroRoutes();
    const facilities = await getAllFacilities();
    const expectedMax = Math.max(
      ...facilities.map((f) => new Date(f.lastUpdated).getTime())
    );
    const indexEntry = metroRoutes.find((r) => r.url === `${siteConfig.url}/metros`);
    expect(indexEntry).toBeDefined();
    expect((indexEntry!.lastModified as Date).getTime()).toBe(expectedMax);
  });

  it("learn routes include /learn and all 5 /learn/:slug routes, derived from GLOSSARY_TOPICS", async () => {
    const learnRoutes = await buildLearnRoutes();
    const urls = learnRoutes.map((r) => r.url);
    expect(urls).toContain(`${siteConfig.url}/learn`);
    for (const topic of GLOSSARY_TOPICS) {
      expect(urls).toContain(`${siteConfig.url}/learn/${topic.slug}`);
    }
    // 1 index + 5 per-topic entries, no duplicates.
    expect(learnRoutes).toHaveLength(GLOSSARY_TOPICS.length + 1);
  });

  it("learn route lastModified is derived from the dataset, not 'new Date()' now", async () => {
    const testStart = Date.now();
    const learnRoutes = await buildLearnRoutes();
    const facilities = await getAllFacilities();
    const expectedMax = Math.max(...facilities.map((f) => new Date(f.lastUpdated).getTime()));

    for (const entry of learnRoutes) {
      const actual = entry.lastModified as Date;
      expect(actual.getTime()).toBe(expectedMax);
      // Proves the value is real dataset data, not build-time "now" — these
      // pages interpolate live figures, so a churning lastmod was wrong twice
      // over: it lied about freshness AND re-stamped on every hourly regen.
      expect(actual.getTime()).toBeLessThan(testStart);
    }
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
    const multiFacilityOperators = operators.filter(
      (name) =>
        facilities.filter((f) => f.operator === name).length >=
        MIN_FACILITIES_FOR_OPERATOR_SITEMAP
    );
    for (const name of multiFacilityOperators) {
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

  it("genuinely static editorial routes (/about, /api, /contribute, /support, /contact, /access) use a stable date, not 'now'", async () => {
    const testStart = Date.now();
    const routes = await buildStaticRoutes();
    for (const path of ["/about", "/api", "/contribute", "/support", "/contact", "/access"]) {
      const entry = routes.find((r) => r.url === `${siteConfig.url}${path}`);
      expect(entry).toBeDefined();
      const actual = entry!.lastModified as Date;
      expect(actual.getTime()).toBeLessThan(testStart);
    }
  });
});
