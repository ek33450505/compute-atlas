import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import meta from "@/data/facilities.meta.json";
import { MIN_FACILITIES } from "../scripts/export";

// Guard for the whole `test:dataset` run (DATASET=real): `pretest:dataset` runs
// prebuild, which silently fills the ~68-record fixture when data/ is empty, and
// every other dataset test would then assert real-data invariants on fixture data.
const REMEDY = "test:dataset needs the real snapshot: run `npm run db:export`";

describe("data snapshot is the real dataset, not the fixture", () => {
  it("data/facilities.json holds at least the export floor", () => {
    expect(
      (facilitiesRaw as unknown[]).length,
      `${REMEDY} (found ${(facilitiesRaw as unknown[]).length} records, floor ${MIN_FACILITIES})`,
    ).toBeGreaterThanOrEqual(MIN_FACILITIES);
  });

  it("data/facilities.meta.json recordCount matches facilities.json", () => {
    expect(meta.recordCount, `${REMEDY} (meta recordCount does not match facilities.json)`).toBe(
      (facilitiesRaw as unknown[]).length,
    );
  });
});
