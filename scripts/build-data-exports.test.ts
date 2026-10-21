import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import { facilitiesToCsv, facilitiesToJson } from "@/lib/export";
import type { Facility } from "@/lib/schema";
import { buildDataExports } from "./build-data-exports";

const SNAPSHOT_PATH = path.join(process.cwd(), "data", "facilities.json");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "data-exports-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildDataExports", () => {
  it("writes both files and reports the record count", () => {
    const out = path.join(dir, "out");
    const result = buildDataExports(SNAPSHOT_PATH, out);
    expect(result.count).toBe((facilitiesRaw as unknown[]).length);
    expect(readFileSync(path.join(out, "facilities.csv"), "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(path.join(out, "facilities.json"), "utf8").length).toBeGreaterThan(0);
    expect(result.csvBytes).toBe(readFileSync(result.csvPath).length);
    expect(result.jsonBytes).toBe(readFileSync(result.jsonPath).length);
  });

  it("golden: static CSV and JSON equal the client-side exporters' output byte for byte", () => {
    const facilities = facilitiesRaw as unknown as Facility[];
    const result = buildDataExports(SNAPSHOT_PATH, dir);
    expect(readFileSync(result.csvPath, "utf8")).toBe(facilitiesToCsv(facilities));
    expect(readFileSync(result.jsonPath, "utf8")).toBe(facilitiesToJson(facilities));
  });

  it("pins the published CSV header so a column change is a deliberate edit", () => {
    const result = buildDataExports(SNAPSHOT_PATH, dir);
    const header = readFileSync(result.csvPath, "utf8").split("\r\n")[0];
    expect(header).toBe(
      "id,name,operator,facility_type,status,ai_classification,confidence," +
        "city,county,state,lat,lon,capacity_operational_mw,capacity_planned_mw," +
        "offtaker,announced_date,last_updated,detail_url,source_count,primary_source_url",
    );
  });

  it("refuses to publish when the meta recordCount disagrees with the record count", () => {
    const facilities = facilitiesRaw as unknown as Facility[];
    const meta = path.join(dir, "meta.json");
    writeFileSync(meta, JSON.stringify({ recordCount: facilities.length + 1 }));
    expect(() => buildDataExports(SNAPSHOT_PATH, path.join(dir, "o"), meta)).toThrow(/recordCount/);
    writeFileSync(meta, JSON.stringify({ recordCount: facilities.length }));
    const ok = buildDataExports(SNAPSHOT_PATH, path.join(dir, "o"), meta);
    expect(ok.count).toBe(facilities.length);
    writeFileSync(meta, "{}");
    expect(() => buildDataExports(SNAPSHOT_PATH, path.join(dir, "o"), meta)).toThrow(/recordCount/);
  });

  it("warn mode (dev only) writes the files and reports the mismatch instead of throwing", () => {
    const facilities = facilitiesRaw as unknown as Facility[];
    const meta = path.join(dir, "meta.json");
    writeFileSync(meta, JSON.stringify({ recordCount: facilities.length + 1 }));
    const out = path.join(dir, "warn");
    const result = buildDataExports(SNAPSHOT_PATH, out, meta, true);
    expect(result.warning).toMatch(/recordCount/);
    expect(readFileSync(result.csvPath, "utf8").length).toBeGreaterThan(0);
    expect(() => buildDataExports(SNAPSHOT_PATH, out, meta, false)).toThrow(/recordCount/);
    writeFileSync(meta, JSON.stringify({ recordCount: facilities.length }));
    expect(buildDataExports(SNAPSHOT_PATH, out, meta, true).warning).toBeUndefined();
  });

  it("warn mode still refuses an empty array and a non-array file", () => {
    const meta = path.join(dir, "meta.json");
    writeFileSync(meta, JSON.stringify({ recordCount: 0 }));
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "[]");
    const emptyArgs = [bad, path.join(dir, "w1"), meta, true] as const;
    expect(() => buildDataExports(...emptyArgs)).toThrow(/non-empty array/);
    writeFileSync(bad, "{}");
    const objArgs = [bad, path.join(dir, "w2"), meta, true] as const;
    expect(() => buildDataExports(...objArgs)).toThrow(/non-empty array/);
  });

  it("agrees with the committed facilities.meta.json", () => {
    const meta = path.join(process.cwd(), "data", "facilities.meta.json");
    expect(() => buildDataExports(SNAPSHOT_PATH, dir, meta)).not.toThrow();
  });

  it("golden: literal CSV for quoting, formula guard, offtaker and negative lon", () => {
    const src = {
      url: "https://e.example/a",
      label: "A",
      retrievedAt: "2026-01-01",
      kind: "press" as const,
    };
    const base = {
      statusHistory: [],
      sources: [src],
      lastUpdated: "2026-02-03",
      confidence: "confirmed" as const,
    };
    const fixture: Facility[] = [
      {
        ...base,
        id: "dc-1",
        name: 'Big, "Quoted"\nName',
        operator: "=SUM(A1)",
        status: "operational",
        facilityType: "data_center",
        location: {
          lat: 40.5,
          lon: -90.0148,
          city: "Springfield",
          state: "IL",
          precision: "exact",
        },
      },
      {
        ...base,
        id: "pg-1",
        name: "Plant",
        operator: "Util Co",
        status: "proposed",
        facilityType: "power_generation",
        location: { lat: 31, lon: -97.25, state: "TX", precision: "exact" },
        generation: { offtaker: "Acme, Inc." },
      },
    ];
    const input = path.join(dir, "fixture.json");
    writeFileSync(input, JSON.stringify(fixture));
    const result = buildDataExports(input, path.join(dir, "g"));
    const header =
      "id,name,operator,facility_type,status,ai_classification,confidence," +
      "city,county,state,lat,lon,capacity_operational_mw,capacity_planned_mw," +
      "offtaker,announced_date,last_updated,detail_url,source_count,primary_source_url";
    const row1 =
      'dc-1,"Big, ""Quoted""\nName",\'=SUM(A1),data_center,operational,,confirmed,' +
      "Springfield,,IL,40.5,-90.0148," +
      ",,,,2026-02-03,https://www.compute-atlas.com/facilities/dc-1,1,https://e.example/a";
    const row2 =
      "pg-1,Plant,Util Co,power_generation,proposed,,confirmed,,,TX,31,-97.25,,," +
      '"Acme, Inc.",,2026-02-03,' +
      "https://www.compute-atlas.com/facilities/pg-1,1,https://e.example/a";
    expect(readFileSync(result.csvPath, "utf8")).toBe([header, row1, row2].join("\r\n"));
  });

  it("refuses an empty or non-array snapshot rather than publishing empty downloads", () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "[]");
    expect(() => buildDataExports(bad, path.join(dir, "o1"))).toThrow(/non-empty array/);
    writeFileSync(bad, "{}");
    expect(() => buildDataExports(bad, path.join(dir, "o2"))).toThrow(/non-empty array/);
  });
});
