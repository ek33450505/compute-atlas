import { describe, it, expect } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import metaRaw from "@/data/facilities.meta.json";
import { HERO_PLATE } from "@/components/home/hero-plate-paths";
import {
  buildPlateData,
  assertUsableAsOf,
  OMITTED_JURISDICTIONS,
  WIDTH,
  HEIGHT,
} from "./build-hero-plate.mjs";

// Real-dataset invariants (DATASET=real, npm run test:dataset). The default run
// checks the same logic against the committed fixture plus a few synthetic
// Hawaii and territory records in build-hero-plate.test.ts.

interface PlateFacility {
  id: string;
  status: string;
  location: { lat: number; lon: number; state: string };
}

const facilities = facilitiesRaw as unknown as PlateFacility[];

describe("buildPlateData — the real dataset", () => {
  const data = buildPlateData(facilities, WIDTH, HEIGHT);
  const territoryFacilities = facilities.filter((f) => OMITTED_JURISDICTIONS.has(f.location.state));

  it("has Alaska and Hawaii facilities to place", () => {
    expect(facilities.some((f) => f.location.state === "AK")).toBe(true);
    expect(facilities.some((f) => f.location.state === "HI")).toBe(true);
  });

  it("omits exactly the territory facilities, and reports them", () => {
    expect(territoryFacilities).toHaveLength(9);
    expect(data.omitted).toBe(9);
    expect(data.omittedJurisdictions).toEqual(["GU", "MP", "PR", "VI"]);
  });

  it("omits each territory facility individually", () => {
    const byCode: Record<string, number> = {};
    for (const f of territoryFacilities) {
      byCode[f.location.state] = (byCode[f.location.state] ?? 0) + 1;
    }
    expect(byCode).toEqual({ GU: 4, MP: 2, PR: 2, VI: 1 });
  });
});

describe("hero-plate-paths.ts — the committed artifact is current", () => {
  // Mirrors lib/siting-context.dataset.test.ts: a data wave that forgets
  // `npm run build:heroplate` fails these (when run with DATASET=real) instead
  // of leaving a plate that silently disagrees with the dataset it claims to
  // draw. Whether CI runs them is a separate decision.
  const data = buildPlateData(facilities, WIDTH, HEIGHT);

  it("matches the paths the generator produces from data/facilities.json", () => {
    expect(HERO_PLATE.paths).toEqual(data.paths);
  });

  it("matches the generator's counts and reconciliation", () => {
    expect({
      counts: { ...HERO_PLATE.counts },
      plotted: HERO_PLATE.plotted,
      deduped: HERO_PLATE.deduped,
      omitted: HERO_PLATE.omitted,
      total: HERO_PLATE.total,
      omittedJurisdictions: [...HERO_PLATE.omittedJurisdictions],
    }).toEqual({
      counts: data.counts,
      plotted: data.plotted,
      deduped: data.deduped,
      omitted: data.omitted,
      total: data.total,
      omittedJurisdictions: data.omittedJurisdictions,
    });
  });

  it("records the snapshot it drew", () => {
    expect(HERO_PLATE.asOf).toBe((metaRaw as { asOf: string }).asOf);
  });

  it("accepts the shape data/facilities.meta.json actually ships", () => {
    const realAsOf = (metaRaw as { asOf: string }).asOf;
    expect(assertUsableAsOf(realAsOf)).toBe(realAsOf);
  });
});
