import { describe, expect, it } from "vitest";

import {
  CODEBOOK_CONVENTIONS,
  CODEBOOK_ENTRIES,
  LOCATION_PRECISION_VALUES,
  STABLE_ID_STATEMENT,
} from "@/lib/dataset-codebook";
import { CSV_COLUMNS, CSV_COLUMN_NOTES } from "@/lib/dataset-csv";
import { capacityMwSchema, communityStatusEnum, confidenceEnum, facilitySchema, facilityTypeEnum, NOT_RECORDABLE_FIELDS, permittedTpySchema, statusEnum } from "@/lib/schema";

const byPath = (path: string) => CODEBOOK_ENTRIES.find((e) => e.path === path);

describe("CODEBOOK_ENTRIES", () => {
  it("has no duplicate paths", () => {
    const paths = CODEBOOK_ENTRIES.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("has exactly one inCsv entry per CSV column, and no other inCsv entries", () => {
    const csvPaths = CODEBOOK_ENTRIES.filter((e) => e.inCsv).map((e) => e.path);
    expect([...csvPaths].sort()).toEqual([...CSV_COLUMNS].sort());
    expect(csvPaths).toEqual([...CSV_COLUMNS]);
  });

  it("reuses the CSV column notes verbatim", () => {
    for (const e of CODEBOOK_ENTRIES.filter((x) => x.inCsv)) {
      expect(e.meaning).toBe(CSV_COLUMN_NOTES[e.path]);
    }
  });

  it("lists the JSON-only fields as not in the CSV", () => {
    for (const path of ["statusHistory[]", "sources[]", "emissions", "subsidies[]", "stakeholders[]", "notRecorded", "construction.phases[]", "notes"]) {
      expect(byPath(path)?.inCsv).toBe(false);
    }
  });

  it("takes enum values from the schema", () => {
    expect(byPath("status")?.values).toEqual(statusEnum.options);
    expect(byPath("confidence")?.values).toEqual(confidenceEnum.options);
    expect(byPath("facilityType")?.values).toEqual(facilityTypeEnum.options);
    expect(byPath("community.status")?.values).toEqual(communityStatusEnum.options);
    expect(byPath("capacityMw.basis")?.values).toEqual(capacityMwSchema.shape.basis.unwrap().options);
  });

  it("pins every schema-read inline enum: each member parses on a minimal facility of the right type, a bogus value does not", () => {
    const base = {
      id: "x",
      name: "X",
      operator: "Op",
      status: "proposed",
      confidence: "reported",
      lastUpdated: "2026-01-01",
      location: { lat: 1, lon: 1, state: "TX" },
      sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01" }],
    };
    const cases: [path: string, build: (v: string) => unknown][] = [
      ["location.precision", (v) => ({ ...base, facilityType: "data_center", location: { ...base.location, precision: v } })],
      ["environmental.waterStress", (v) => ({ ...base, facilityType: "data_center", environmental: { waterStress: v } })],
      ["mining.hardwareType", (v) => ({ ...base, facilityType: "crypto_mining", mining: { hardwareType: v } })],
      ["mining.coolingType", (v) => ({ ...base, facilityType: "crypto_mining", mining: { coolingType: v } })],
      ["mining.powerArrangement", (v) => ({ ...base, facilityType: "crypto_mining", mining: { powerArrangement: v } })],
      ["environmental.carbonIntensityBasis", (v) => ({ ...base, facilityType: "crypto_mining", environmental: { carbonIntensityBasis: v } })],
      ["generation.technology", (v) => ({ ...base, facilityType: "power_generation", generation: { technology: v } })],
    ];
    for (const [path, build] of cases) {
      const values = byPath(path)?.values;
      expect(values?.length, path).toBeGreaterThan(1);
      for (const v of values ?? []) expect(facilitySchema.safeParse(build(v)).success, `${path}=${v}`).toBe(true);
      expect(facilitySchema.safeParse(build("bogus")).success, `${path}=bogus`).toBe(false);
    }
    expect(byPath("location.precision")?.values).toEqual(LOCATION_PRECISION_VALUES);
  });

  it("pins the literal member lists the codebook is expected to carry", () => {
    expect(byPath("mining.hardwareType")?.values).toEqual(["asic", "gpu", "mixed", "unknown"]);
    expect(byPath("mining.coolingType")?.values).toEqual(["immersion", "air", "hydro", "hybrid", "unknown"]);
    expect(byPath("environmental.waterStress")?.values).toEqual(["low", "medium", "high", "extreme", "unknown"]);
  });
});

/** Whole lowercase tokens of a note: split on anything outside [a-z0-9_], so "it" never matches inside "facility". */
const tokens = (text: string): string[] => text.split(/[^a-z0-9_]+/).filter(Boolean);

describe("CSV column notes vs schema enums", () => {
  const enumEntries = CODEBOOK_ENTRIES.filter((e) => e.inCsv && e.values);

  it("every note for an enum column names every schema option as a whole token", () => {
    expect(enumEntries.length).toBeGreaterThan(15);
    for (const e of enumEntries) {
      const noteTokens = new Set(tokens(CSV_COLUMN_NOTES[e.path]));
      for (const v of e.values ?? []) expect(noteTokens.has(v), `${e.path} note is missing ${v}`).toBe(true);
    }
  });

  it("no note carries a snake_case token that is not a schema option of its column", () => {
    for (const e of enumEntries) {
      const stray = tokens(CSV_COLUMN_NOTES[e.path]).filter((tok) => tok.includes("_") && !(e.values ?? []).includes(tok));
      expect(stray, `${e.path} note has tokens outside the schema enum`).toEqual([]);
    }
  });

  it("matches whole tokens, not substrings (the check bites)", () => {
    expect(tokens("facility, it or utility_service")).toContain("it");
    expect(tokens("facility or utility_service")).not.toContain("it");
    expect(tokens("nuclear_smr")).not.toContain("nuclear");
  });
});

describe("derived lists", () => {
  it("renders notRecorded, emissions values and pollutant keys from the schema", () => {
    expect(byPath("notRecorded")?.meaning).toContain(NOT_RECORDABLE_FIELDS.join(", "));
    const emissions = byPath("emissions")?.meaning ?? "";
    expect(emissions).toContain("calendar_year, rolling_12_month, other");
    expect(emissions).toContain("group_wide");
    expect(emissions).toContain(Object.keys(permittedTpySchema.shape).join(", "));
  });
});

describe("codebook text", () => {
  it("carries the approved stable-id statement verbatim", () => {
    expect(STABLE_ID_STATEMENT).toBe(
      "By policy, a record id is never reused, a retired id is listed as removed in the changelog.json of the edition that removes it, and its web page redirects to a successor record where one has been named.",
    );
  });

  it("states the conventions", () => {
    expect(CODEBOOK_CONVENTIONS.length).toBeGreaterThanOrEqual(7);
    expect(CODEBOOK_CONVENTIONS.join(" ")).toMatch(/is not a zero/);
  });
});
