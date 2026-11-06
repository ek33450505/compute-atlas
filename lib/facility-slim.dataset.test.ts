import { describe, it, expect } from "vitest";
import { brotliCompressSync, constants } from "node:zlib";

import facilitiesRaw from "@/data/facilities.json";
import { facilitiesSchema } from "@/lib/schema";
import { toMapFacility, toTableRow } from "@/lib/facility-slim";

// Real-dataset payload budgets (DATASET=real). The ceilings were measured on the
// full dataset and do not transfer to the small committed fixture (it compresses
// worse per record), so there is no fixture-level equivalent in the default run.

describe("map payload size budget", () => {
  // Measures brotli q5 of JSON.stringify(projected corpus), NOT the RSC wire
  // format; real wire bytes are measured post-deploy. Per-record so data
  // growth cannot trip it, while adding a field to the projection still does.
  // It is a corpus average: a field added to only a few records is diluted and
  // can slip under the ceiling. The allow-list test above is what catches that.
  // Measured 2026-10-21: 255,024 B / 2,745 records = 92.9 B per record
  // (full records: 495 B). Ceiling = measured x ~1.2. Mutation-tested:
  // projecting `sources: f.sources` gives ~194 B per record and fails.
  // The PERF-1 brief's 0.2 MB estimate used 3 dp coordinates; 4 dp costs the rest.
  const MAX_BR_BYTES_PER_RECORD = 112;

  it("brotli-compressed projection stays within the per-record ceiling", () => {
    const all = facilitiesSchema.parse(facilitiesRaw);
    const json = JSON.stringify(all.map(toMapFacility));
    const br = brotliCompressSync(Buffer.from(json), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    }).length;
    const perRecord = br / all.length;
    expect(
      perRecord,
      `map payload is ${br} B brotli (q5) over ${all.length} records = ${perRecord.toFixed(1)} B/record`
    ).toBeLessThanOrEqual(MAX_BR_BYTES_PER_RECORD);
  });
});

describe("table payload size budget", () => {
  // Same method and caveats as the map budget above. Measured 2026-10-21:
  // 284,870 B / 2,745 records = 103.8 B per record (full records: 495 B,
  // 1,359,639 B). Ceiling = measured x ~1.2. Mutation-tested: projecting
  // `sources: f.sources` pushes it well past the ceiling.
  const MAX_BR_BYTES_PER_RECORD = 125;

  it("brotli-compressed projection stays within the per-record ceiling", () => {
    const all = facilitiesSchema.parse(facilitiesRaw);
    const json = JSON.stringify(all.map(toTableRow));
    const br = brotliCompressSync(Buffer.from(json), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    }).length;
    const perRecord = br / all.length;
    expect(
      perRecord,
      `table payload is ${br} B brotli (q5) over ${all.length} records = ${perRecord.toFixed(1)} B/record`
    ).toBeLessThanOrEqual(MAX_BR_BYTES_PER_RECORD);
  });
});

