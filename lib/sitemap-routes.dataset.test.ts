import { describe, it, expect } from "vitest";
import { buildMetroRoutes } from "@/lib/sitemap-routes";
import { getAllFacilities, getFacilitiesByMetro } from "@/lib/data";
import { METROS } from "@/lib/metros";
import { siteConfig } from "@/lib/site";

// Real-dataset half (DATASET=real) of the metro lastModified test in
// sitemap-routes.test.ts: against the full dataset EVERY metro is populated, so
// every entry is checked (the fixture run skips empty metros).
describe("sitemap", () => {
  it("metro hub lastModified equals the max lastUpdated of that metro's OWN facilities (getFacilitiesByMetro)", async () => {
    const testStart = Date.now();
    const metroRoutes = await buildMetroRoutes();

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
    }
  });

  // If every metro contains a facility updated on the exact dataset-max date,
  // the "own facilities, not the whole-dataset max" claim above is
  // unfalsifiable by this snapshot. That is reported as a skip, not a pass or a
  // failure: lib/sitemap-routes.test.ts still proves the claim on the fixture
  // in CI. 2026-09-08: 25 of 27 metros were strictly earlier. 2026-11-14: a
  // publish that moved lastUpdated on 824 records put all 27 at the dataset
  // max, so this reports a skip until a later update moves the max.
  it("the real dataset can tell a metro's own max from the whole-dataset max", async (ctx) => {
    const facilities = await getAllFacilities();
    const datasetMax = Math.max(
      ...facilities.map((f) => new Date(f.lastUpdated).getTime())
    );

    let sawEntryEarlierThanDatasetMax = false;
    for (const m of METROS) {
      const metroFacilities = await getFacilitiesByMetro(m.slug);
      const metroMax = Math.max(
        ...metroFacilities.map((f) => new Date(f.lastUpdated).getTime())
      );
      if (metroMax < datasetMax) sawEntryEarlierThanDatasetMax = true;
    }

    if (!sawEntryEarlierThanDatasetMax) {
      ctx.skip(
        "every metro contains a record updated on the dataset-max date, so the real data cannot falsify the claim; lib/sitemap-routes.test.ts proves it on the fixture in CI"
      );
    }
    expect(sawEntryEarlierThanDatasetMax).toBe(true);
  });
});
