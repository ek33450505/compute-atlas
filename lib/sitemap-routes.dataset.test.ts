import { describe, it, expect } from "vitest";
import { buildMetroRoutes } from "@/lib/sitemap-routes";
import { getAllFacilities, getFacilitiesByMetro } from "@/lib/data";
import { METROS } from "@/lib/metros";
import { siteConfig } from "@/lib/site";

// Real-dataset half (DATASET=real) of the metro lastModified test in
// sitemap-routes.test.ts: against the full dataset EVERY metro is populated, so
// every entry is checked (the fixture run skips empty metros).
describe("sitemap", () => {
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
});
