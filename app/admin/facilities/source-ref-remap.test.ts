import { describe, it, expect } from "vitest";

import {
  describeCarriedIssuePaths,
  findSourceCitations,
  joinWords,
  remapRefsForRemove,
  remapRefsForSwap,
  type SourceRefs,
} from "./source-ref-remap";

function makeRefs(overrides: Partial<SourceRefs> = {}): SourceRefs {
  return {
    statusHistory: [
      { status: "proposed", date: "2026-01-01", sourceIndex: 0 },
      { status: "operational", date: "2026-02-01", sourceIndex: 2 },
      { status: "operational", date: "2026-03-01" },
    ],
    subsidies: [{ program: "P", sourceIndex: 1 }] as SourceRefs["subsidies"],
    jobs: { sourceIndex: 2 } as SourceRefs["jobs"],
    community: {},
    energy: { utilityEiaId: { id: 5, sourceIndex: 1 } } as SourceRefs["energy"],
    ...overrides,
  };
}

describe("remapRefsForSwap", () => {
  it("swaps every ref to i and j across all five ref sites", () => {
    const out = remapRefsForSwap(makeRefs(), 1, 2);
    expect(out.statusHistory.map((h) => h.sourceIndex)).toEqual([0, 1, undefined]);
    expect(out.subsidies[0].sourceIndex).toBe(2);
    expect((out.jobs as { sourceIndex?: number }).sourceIndex).toBe(1);
    expect((out.energy as { utilityEiaId?: { sourceIndex: number } }).utilityEiaId?.sourceIndex).toBe(2);
  });

  it("leaves absent indices absent (no sourceIndex key added)", () => {
    const out = remapRefsForSwap(makeRefs(), 0, 1);
    expect("sourceIndex" in out.statusHistory[2]).toBe(false);
    expect(out.community).toEqual({});
  });

  it("does not mutate its input", () => {
    const refs = makeRefs();
    const snapshot = structuredClone(refs);
    remapRefsForSwap(refs, 0, 2);
    expect(refs).toEqual(snapshot);
  });
});

describe("remapRefsForRemove", () => {
  it("decrements refs above the removed index and leaves lower ones alone", () => {
    const out = remapRefsForRemove(makeRefs(), 0 + 1);
    expect(out.statusHistory.map((h) => h.sourceIndex)).toEqual([0, 1, undefined]);
    expect((out.jobs as { sourceIndex?: number }).sourceIndex).toBe(1);
  });

  it("decrements energy.utilityEiaId.sourceIndex", () => {
    const out = remapRefsForRemove(makeRefs(), 0);
    expect((out.energy as { utilityEiaId?: { sourceIndex: number } }).utilityEiaId?.sourceIndex).toBe(0);
  });

  it("does not mutate its input", () => {
    const refs = makeRefs();
    const snapshot = structuredClone(refs);
    remapRefsForRemove(refs, 0);
    expect(refs).toEqual(snapshot);
  });
});

describe("findSourceCitations", () => {
  it("names every citing ref in one-based plain words", () => {
    expect(findSourceCitations(makeRefs(), 2)).toEqual(["status history entry 2", "jobs"]);
    expect(findSourceCitations(makeRefs(), 1)).toEqual(["subsidy 1", "utility EIA id"]);
  });

  it("returns [] for an uncited source", () => {
    expect(findSourceCitations(makeRefs(), 7)).toEqual([]);
  });
});

describe("joinWords", () => {
  it("joins with commas and a final 'and'", () => {
    expect(joinWords(["a"])).toBe("a");
    expect(joinWords(["a", "b"])).toBe("a and b");
    expect(joinWords(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("describeCarriedIssuePaths", () => {
  it("describes carried sourceIndex paths one-based and skips form-stated ones", () => {
    const out = describeCarriedIssuePaths([
      { path: ["stakeholders", 1, "sourceIndex"], message: "m" },
      { path: ["construction", "disturbedAcres", "sourceIndex"], message: "m" },
      { path: ["statusHistory", 0, "sourceIndex"], message: "m" },
      { path: ["name"], message: "m" },
    ]);
    expect(out).toEqual(["stakeholders entry 2", "construction disturbed acres"]);
  });

  it("lists energy.utilityEiaId, which the form strips so the server carries it", () => {
    expect(
      describeCarriedIssuePaths([{ path: ["energy", "utilityEiaId", "sourceIndex"], message: "m" }])
    ).toEqual(["energy utility eia id"]);
  });

  it("returns [] for non-array input", () => {
    expect(describeCarriedIssuePaths(undefined)).toEqual([]);
  });
});
