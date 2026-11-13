import { describe, it, expect } from "vitest";
import {
  facilitySchema,
  partialIsoDateSchema,
  v2SourceIndexRefs,
  remapV2SourceIndices,
  type Facility,
} from "@/lib/schema";

const source = (n: number) => ({
  url: `https://example.com/${n}`,
  label: `Source ${n}`,
  retrievedAt: "2026-07-05",
  kind: "press" as const,
});

const dataCenter = {
  id: "v2-dc",
  name: "V2 DC",
  operator: "Op",
  status: "operational" as const,
  facilityType: "data_center" as const,
  confidence: "reported" as const,
  location: { lat: 35, lon: -90, state: "TN" },
  sources: [source(0), source(1), source(2)],
  lastUpdated: "2026-07-05",
};

const power = {
  id: "v2-power",
  name: "V2 Power",
  operator: "Op",
  status: "operational" as const,
  facilityType: "power_generation" as const,
  confidence: "reported" as const,
  location: { lat: 35, lon: -90, state: "TN" },
  sources: [source(0), source(1), source(2)],
  lastUpdated: "2026-07-05",
};

function issuePaths(doc: unknown): string[] {
  const r = facilitySchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("partialIsoDateSchema", () => {
  it.each(["2027", "2027-05", "2027-05-01"])("accepts %s", (d) => {
    expect(partialIsoDateSchema.safeParse(d).success).toBe(true);
  });
  it.each(["Q3 2027", "2027/05", "27-05", "2027-5", "2027-05-1", ""])("rejects %s", (d) => {
    expect(partialIsoDateSchema.safeParse(d).success).toBe(false);
  });
});

// [field label, patch builder given a sourceIndex, expected issue path]
const cases: [string, (i?: number) => Record<string, unknown>, string][] = [
  ["ids.epaFrsId", (i) => ({ ids: { epaFrsId: { id: "110000123", sourceIndex: i } } }), "ids.epaFrsId.sourceIndex"],
  ["ids.eiaPlantId", (i) => ({ ids: { eiaPlantId: { id: 3, sourceIndex: i } } }), "ids.eiaPlantId.sourceIndex"],
  [
    "energy.utilityEiaId",
    (i) => ({ energy: { utility: "TVA", utilityEiaId: { id: 18642, sourceIndex: i } } }),
    "energy.utilityEiaId.sourceIndex",
  ],
  ["parties.ownerEntity", (i) => ({ parties: { ownerEntity: [{ name: "Proj LLC", sourceIndex: i }] } }), "parties.ownerEntity.0.sourceIndex"],
  ["parties.tenant", (i) => ({ parties: { tenant: [{ name: "Tenant", sourceIndex: i }] } }), "parties.tenant.0.sourceIndex"],
  ["parties.endUser", (i) => ({ parties: { endUser: [{ name: "User", sourceIndex: i }] } }), "parties.endUser.0.sourceIndex"],
  [
    "parties.generalContractor",
    (i) => ({ parties: { generalContractor: [{ name: "GC", sourceIndex: i }] } }),
    "parties.generalContractor.0.sourceIndex",
  ],
  [
    "construction.expectedStart",
    (i) => ({ construction: { expectedStart: { date: "2027-05", sourceIndex: i } } }),
    "construction.expectedStart.sourceIndex",
  ],
  [
    "construction.expectedCompletion",
    (i) => ({ construction: { expectedCompletion: { date: "2028", sourceIndex: i } } }),
    "construction.expectedCompletion.sourceIndex",
  ],
  [
    "construction.permitValuationUsd",
    (i) => ({ construction: { permitValuationUsd: { amountUsd: 5e6, permitNumber: "B-1", sourceIndex: i } } }),
    "construction.permitValuationUsd.sourceIndex",
  ],
  [
    "construction.phases",
    (i) => ({ construction: { phases: [{ name: "Phase 1", mw: 50, expectedStart: "2027-01-15", sourceIndex: i }] } }),
    "construction.phases.0.sourceIndex",
  ],
];

describe("facilitySchema v2 fields: sourceIndex", () => {
  it.each(cases)("%s: valid doc parses", (_l, build) => {
    expect(facilitySchema.safeParse({ ...dataCenter, ...build(1) }).success).toBe(true);
  });
  it.each(cases)("%s: missing sourceIndex fails", (_l, build, path) => {
    expect(issuePaths({ ...dataCenter, ...build(undefined) })).toContain(path);
  });
  it.each(cases)("%s: out-of-range sourceIndex fails with the path", (_l, build, path) => {
    expect(issuePaths({ ...dataCenter, ...build(3) })).toEqual([path]);
  });
});

describe("facilitySchema v2 fields: shape rules", () => {
  it("rejects non-digit epaFrsId and non-positive eiaPlantId", () => {
    expect(facilitySchema.safeParse({ ...dataCenter, ids: { epaFrsId: { id: "11a", sourceIndex: 0 } } }).success).toBe(false);
    expect(facilitySchema.safeParse({ ...dataCenter, ids: { eiaPlantId: { id: 0, sourceIndex: 0 } } }).success).toBe(false);
  });
  it("rejects empty party arrays and blank names", () => {
    expect(facilitySchema.safeParse({ ...dataCenter, parties: { tenant: [] } }).success).toBe(false);
    expect(facilitySchema.safeParse({ ...dataCenter, parties: { tenant: [{ name: "  ", sourceIndex: 0 }] } }).success).toBe(false);
  });
  it("rejects bad construction dates and empty phases", () => {
    expect(
      facilitySchema.safeParse({ ...dataCenter, construction: { expectedStart: { date: "Q3 2027", sourceIndex: 0 } } }).success
    ).toBe(false);
    expect(facilitySchema.safeParse({ ...dataCenter, construction: { phases: [] } }).success).toBe(false);
  });
  it("rejects a bad phase date at the phase path", () => {
    const phase = (extra: Record<string, unknown>) => ({
      ...dataCenter,
      construction: { phases: [{ name: "P1", sourceIndex: 0, ...extra }] },
    });
    expect(issuePaths(phase({ expectedStart: "Q3 2027" }))).toEqual(["construction.phases.0.expectedStart"]);
    expect(issuePaths(phase({ expectedCompletion: "2027/05" }))).toEqual(["construction.phases.0.expectedCompletion"]);
  });
});

describe("facilitySchema v2 fields: cross-field rules", () => {
  it("rejects utilityEiaId without utility", () => {
    expect(
      issuePaths({ ...dataCenter, energy: { utilityEiaId: { id: 1, sourceIndex: 0 } } })
    ).toEqual(["energy.utilityEiaId"]);
  });
  it("rejects tenant/endUser on power_generation, accepts on data_center", () => {
    const parties = { tenant: [{ name: "T", sourceIndex: 0 }], endUser: [{ name: "E", sourceIndex: 0 }] };
    expect(issuePaths({ ...power, parties }).sort()).toEqual(["parties.endUser", "parties.tenant"]);
    expect(facilitySchema.safeParse({ ...dataCenter, parties }).success).toBe(true);
    expect(
      facilitySchema.safeParse({ ...power, parties: { ownerEntity: [{ name: "O", sourceIndex: 0 }] } }).success
    ).toBe(true);
  });
  it("rejects capacityMw.basis without planned or operational", () => {
    expect(issuePaths({ ...dataCenter, capacityMw: { basis: "it" } })).toEqual(["capacityMw.basis"]);
    expect(issuePaths({ ...dataCenter, capacityMw: { basis: "it", itPlanned: 5 } })).toEqual(["capacityMw.basis"]);
  });
  it("reports only the power-specific error for basis alone on power_generation", () => {
    const r = facilitySchema.safeParse({ ...power, capacityMw: { basis: "it" } });
    expect(r.success).toBe(false);
    const issues = r.success ? [] : r.error.issues;
    expect(issues.map((i) => i.path.join("."))).toEqual(["capacityMw.basis"]);
    expect(issues[0].message).toContain("not allowed on power_generation");
  });
  it("accepts basis with a figure, and IT figures standing alone", () => {
    expect(facilitySchema.safeParse({ ...dataCenter, capacityMw: { basis: "it", operational: 5 } }).success).toBe(true);
    expect(facilitySchema.safeParse({ ...dataCenter, capacityMw: { basis: "facility", planned: 5 } }).success).toBe(true);
    expect(facilitySchema.safeParse({ ...dataCenter, capacityMw: { itOperational: 4 } }).success).toBe(true);
  });
  it("rejects capacityMw basis/IT fields on power_generation, accepts on data_center", () => {
    const capacityMw = { operational: 10, basis: "it" as const, itPlanned: 5, itOperational: 4 };
    expect(issuePaths({ ...power, capacityMw }).sort()).toEqual([
      "capacityMw.basis",
      "capacityMw.itOperational",
      "capacityMw.itPlanned",
    ]);
    expect(facilitySchema.safeParse({ ...dataCenter, capacityMw }).success).toBe(true);
  });
});

describe("facilitySchema v2 fields: legacy compatibility", () => {
  it("a doc without any v2 field parses with no new keys", () => {
    const r = facilitySchema.parse({ ...dataCenter, capacityMw: { operational: 5 }, energy: { utility: "TVA" } });
    for (const k of ["ids", "parties", "construction"]) expect(r).not.toHaveProperty(k);
    expect(r.capacityMw).toEqual({ operational: 5 });
    expect(r.energy).toEqual({ utility: "TVA" });
  });
});

describe("v2SourceIndexRefs / remapV2SourceIndices", () => {
  const full = facilitySchema.parse({
    ...dataCenter,
    ids: { epaFrsId: { id: "1", sourceIndex: 0 }, eiaPlantId: { id: 2, sourceIndex: 1 } },
    energy: { utility: "TVA", utilityEiaId: { id: 3, sourceIndex: 2 } },
    parties: {
      ownerEntity: [{ name: "A", sourceIndex: 0 }, { name: "B", sourceIndex: 1 }],
      tenant: [{ name: "C", sourceIndex: 0 }, { name: "D", sourceIndex: 1 }],
      endUser: [{ name: "E", sourceIndex: 0 }, { name: "F", sourceIndex: 1 }],
      generalContractor: [{ name: "G", sourceIndex: 0 }, { name: "H", sourceIndex: 1 }],
    },
    construction: {
      expectedStart: { date: "2027", sourceIndex: 0 },
      expectedCompletion: { date: "2028", sourceIndex: 1 },
      permitValuationUsd: { amountUsd: 1, permitNumber: "B-1", sourceIndex: 2 },
      phases: [
        { name: "P1", mw: 50, expectedStart: "2027-01", expectedCompletion: "2027-12-31", sourceIndex: 0 },
        { name: "P2", sourceIndex: 1 },
      ],
    },
  });
  const expectedPaths = [
    "ids.epaFrsId.sourceIndex",
    "ids.eiaPlantId.sourceIndex",
    "energy.utilityEiaId.sourceIndex",
    ...["ownerEntity", "tenant", "endUser", "generalContractor"].flatMap((r) => [
      `parties.${r}[0].sourceIndex`,
      `parties.${r}[1].sourceIndex`,
    ]),
    "construction.expectedStart.sourceIndex",
    "construction.expectedCompletion.sourceIndex",
    "construction.permitValuationUsd.sourceIndex",
    "construction.phases[0].sourceIndex",
    "construction.phases[1].sourceIndex",
  ];

  it("enumerates every v2 path", () => {
    expect(v2SourceIndexRefs(full).map((r) => r.path).sort()).toEqual([...expectedPaths].sort());
  });

  it("returns nothing for a legacy doc", () => {
    expect(v2SourceIndexRefs(facilitySchema.parse(dataCenter))).toEqual([]);
  });

  it("remaps every index and leaves everything else untouched, without mutating", () => {
    const before = JSON.stringify(full);
    const out: Facility = remapV2SourceIndices(full, (_p, i) => i + 100);
    expect(JSON.stringify(full)).toBe(before);
    const refs = v2SourceIndexRefs(out);
    expect(refs.map((r) => r.path).sort()).toEqual([...expectedPaths].sort());
    const orig = new Map(v2SourceIndexRefs(full).map((r) => [r.path, r.index]));
    for (const r of refs) expect(r.index).toBe(orig.get(r.path)! + 100);
    // Undoing the remap must reproduce the original exactly.
    expect(remapV2SourceIndices(out, (_p, i) => i - 100)).toEqual(full);
    expect(out.energy?.utility).toBe("TVA");
    expect(out.parties?.tenant?.map((p) => p.name)).toEqual(["C", "D"]);
  });

  it("keeps absent fields absent", () => {
    const out = remapV2SourceIndices(facilitySchema.parse(dataCenter), (_p, i) => i + 1);
    for (const k of ["ids", "parties", "construction"]) expect(out).not.toHaveProperty(k);
  });
});
