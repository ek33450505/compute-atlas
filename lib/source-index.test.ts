import { describe, it, expect } from "vitest";
import { facilitySchema, remapSourceIndices, sourceIndexRefs } from "@/lib/schema";

const source = (n: number) => ({
  url: `https://example.com/${n}`,
  label: `Source ${n}`,
  retrievedAt: "2026-07-05",
  kind: "press" as const,
});

// Every sourceIndex-bearing field set, each to a distinct index.
function maximal() {
  const party = (name: string, sourceIndex: number) => ({ name, sourceIndex });
  return {
    id: "max-dc",
    name: "Max DC",
    operator: "Op",
    status: "operational" as const,
    facilityType: "data_center" as const,
    confidence: "reported" as const,
    location: { lat: 35, lon: -90, state: "TN" },
    sources: Array.from({ length: 30 }, (_, i) => source(i)),
    lastUpdated: "2026-07-05",
    statusHistory: [
      { status: "permitted" as const, date: "2025-01-01", sourceIndex: 1 },
      { status: "operational" as const, date: "2026-01-01", sourceIndex: 2 },
    ],
    emissions: { sourceIndex: 3 },
    subsidies: [{ program: "Abatement", sourceIndex: 4 }],
    stakeholders: [
      {
        name: "Example Holdings",
        kind: "organization" as const,
        role: "lender" as const,
        sourceIndex: 5,
        asOf: "2026-01",
      },
    ],
    jobs: { permanent: 10, sourceIndex: 6 },
    community: { notes: "n", sourceIndex: 7 },
    ids: { epaFrsId: { id: "110", sourceIndex: 8 }, eiaPlantId: { id: 5, sourceIndex: 9 } },
    energy: { utility: "Example Power", utilityEiaId: { id: 7, sourceIndex: 10 } },
    parties: {
      ownerEntity: [party("Owner LLC", 11)],
      tenant: [party("Tenant Co", 12)],
      endUser: [party("User Co", 13)],
      generalContractor: [party("Builder Co", 14)],
    },
    construction: {
      expectedStart: { date: "2026-01", sourceIndex: 15 },
      expectedCompletion: { date: "2027-01", sourceIndex: 16 },
      permitValuationUsd: { amountUsd: 10, sourceIndex: 17 },
      disturbedAcres: { value: 5, sourceIndex: 18 },
      receivingWater: { name: "Example Creek", sourceIndex: 19 },
      phases: [{ name: "Phase 1", sourceIndex: 20 }],
    },
  };
}

const norm = (path: string) => path.replace(/\[\d+\]/g, "[]");

// Walks the zod schema (all union branches; optional/default/nullable/array/
// object/record unwrapped) and returns the path template of every object
// shape that has a `sourceIndex` key.
function schemaSourceIndexPaths(): Set<string> {
  const found = new Set<string>();
  const walk = (schema: unknown, path: string, seen: Set<unknown>): void => {
    const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return;
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
        return walk(def.innerType, path, seen);
      case "array":
        return walk(def.element, `${path}[]`, seen);
      case "record":
        return walk(def.valueType, path, seen);
      case "union":
        for (const o of def.options as unknown[]) walk(o, path, seen);
        return;
      case "pipe":
        walk(def.in, path, seen);
        return walk(def.out, path, seen);
      case "object": {
        if (seen.has(schema)) return;
        const shape = def.shape as Record<string, unknown>;
        const next = new Set(seen).add(schema);
        for (const [key, child] of Object.entries(shape)) {
          if (key === "sourceIndex") found.add(`${path}.sourceIndex`.replace(/^\./, ""));
          else walk(child, path ? `${path}.${key}` : key, next);
        }
        return;
      }
      default:
        return;
    }
  };
  walk(facilitySchema, "", new Set());
  return found;
}

describe("sourceIndexRefs / remapSourceIndices", () => {
  it("the maximal fixture is a valid facility", () => {
    expect(facilitySchema.safeParse(maximal()).success).toBe(true);
  });

  it("enumerates every v1 and v2 ref with its path", () => {
    const refs = sourceIndexRefs(maximal());
    expect(Object.fromEntries(refs.map((r) => [r.path, r.index]))).toEqual({
      "statusHistory[0].sourceIndex": 1,
      "statusHistory[1].sourceIndex": 2,
      "emissions.sourceIndex": 3,
      "subsidies[0].sourceIndex": 4,
      "stakeholders[0].sourceIndex": 5,
      "jobs.sourceIndex": 6,
      "community.sourceIndex": 7,
      "ids.epaFrsId.sourceIndex": 8,
      "ids.eiaPlantId.sourceIndex": 9,
      "energy.utilityEiaId.sourceIndex": 10,
      "parties.ownerEntity[0].sourceIndex": 11,
      "parties.tenant[0].sourceIndex": 12,
      "parties.endUser[0].sourceIndex": 13,
      "parties.generalContractor[0].sourceIndex": 14,
      "construction.expectedStart.sourceIndex": 15,
      "construction.expectedCompletion.sourceIndex": 16,
      "construction.permitValuationUsd.sourceIndex": 17,
      "construction.disturbedAcres.sourceIndex": 18,
      "construction.receivingWater.sourceIndex": 19,
      "construction.phases[0].sourceIndex": 20,
    });
  });

  it("skips absent optional indices", () => {
    const jobs: { permanent: number; sourceIndex?: number } = { permanent: 1 };
    const f = { ...maximal(), emissions: {}, jobs, community: {}, subsidies: [{}] };
    const paths = sourceIndexRefs(f).map((r) => r.path);
    expect(paths).not.toContain("emissions.sourceIndex");
    expect(paths).not.toContain("jobs.sourceIndex");
    expect(paths).not.toContain("community.sourceIndex");
    expect(paths).not.toContain("subsidies[0].sourceIndex");
  });

  it("remaps every path, leaves absent fields absent, and does not mutate", () => {
    const f = maximal();
    const before = structuredClone(f);
    const seen: string[] = [];
    const out = remapSourceIndices(f, (path, index) => {
      seen.push(path);
      return index + 100;
    });
    expect(f).toEqual(before);
    expect(seen.sort()).toEqual(sourceIndexRefs(f).map((r) => r.path).sort());
    expect(sourceIndexRefs(out).map((r) => r.index).sort((a, b) => a - b)).toEqual(
      sourceIndexRefs(f).map((r) => r.index + 100).sort((a, b) => a - b)
    );
    expect(out.emissions).toEqual({ sourceIndex: 103 });

    const jobs: { permanent: number; sourceIndex?: number } = { permanent: 1 };
    const sparse = { ...maximal(), emissions: undefined, jobs };
    const sparseOut = remapSourceIndices(sparse, (_p, i) => i + 1);
    expect(sparseOut.jobs).toEqual({ permanent: 1 });
    expect("sourceIndex" in (sparseOut.jobs ?? {})).toBe(false);
    expect(sparseOut.emissions).toBeUndefined();
  });

  it("completeness guard: every sourceIndex field in facilitySchema is enumerated", () => {
    const fromSchema = schemaSourceIndexPaths();
    // The walk must actually find fields, or the equality below is vacuous.
    expect(fromSchema.size).toBeGreaterThanOrEqual(15);
    const fromRefs = new Set(sourceIndexRefs(maximal()).map((r) => norm(r.path)));
    expect([...fromSchema].sort()).toEqual([...fromRefs].sort());
  });
});
