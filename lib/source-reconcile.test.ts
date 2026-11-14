import { describe, it, expect } from "vitest";
import { reconcileSourceIndices, refPathToIssuePath } from "@/lib/source-reconcile";

const src = (label: string) => ({
  url: `https://example.com/${label}`,
  label,
  retrievedAt: "2026-07-05",
  kind: "press",
});
const sources = (...labels: string[]) => labels.map(src);

type Loose = { sourceIndex: number };
interface OutDoc {
  stakeholders: Loose[];
  emissions: Loose;
  jobs: Loose;
  energy: { utilityEiaId: Loose };
  construction: { disturbedAcres: Loose };
  parties: { tenant: Loose[] };
  statusHistory: Loose[];
}

function ok(r: ReturnType<typeof reconcileSourceIndices>): OutDoc {
  if (!r.ok) throw new Error(`expected ok, got ${r.status} citing ${r.citing.join(",")}`);
  return r.doc as unknown as OutDoc;
}

// Stored doc: stakeholders->0, emissions->1, disturbedAcres->2, tenant->1.
function stored(labels: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "x",
    sources: sources(...labels),
    stakeholders: [{ name: "Example Holdings", role: "lender", sourceIndex: 0, asOf: "2026-01" }],
    emissions: { sourceIndex: 1 },
    construction: { disturbedAcres: { value: 5, sourceIndex: 2 } },
    parties: { tenant: [{ name: "Tenant Co", sourceIndex: 1 }] },
    ...extra,
  };
}

describe("reconcileSourceIndices", () => {
  it("fast path: identical source urls return the merged doc unchanged", () => {
    const existing = stored(["a", "b", "c"]);
    const merged = { ...existing, name: "renamed" };
    expect(reconcileSourceIndices(existing, { name: "renamed" }, merged)).toEqual({ ok: true, doc: merged });
  });

  it("a pure append passes without origins", () => {
    const existing = stored(["a", "b", "c"]);
    const merged = { ...existing, sources: sources("a", "b", "c", "d") };
    expect(reconcileSourceIndices(existing, { sources: merged.sources }, merged)).toEqual({ ok: true, doc: merged });
  });

  it("an in-place url edit that keeps carried urls at their indexes passes without origins", () => {
    const existing = stored(["a", "b", "c", "d"]);
    // d is uncited at index 3 (nothing cites it) and is corrected in place.
    const merged = { ...existing, sources: sources("a", "b", "c", "d-fixed") };
    expect(reconcileSourceIndices(existing, { sources: merged.sources }, merged).ok).toBe(true);
  });

  it("without origins, a reorder 409s on the carried refs only", () => {
    const existing = stored(["a", "b", "c"]);
    const patch = { sources: sources("c", "a", "b"), jobs: { sourceIndex: 0 } };
    const merged = { ...existing, ...patch };
    const r = reconcileSourceIndices(existing, patch, merged);
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (r.ok) return;
    // jobs is patch-stated, so it is not named.
    expect(r.citing).toEqual([
      "construction.disturbedAcres.sourceIndex",
      "emissions.sourceIndex",
      "parties.tenant[0].sourceIndex",
      "stakeholders[0].sourceIndex",
    ]);
  });

  it("H1: stored [A,B] ref->1, patched to [A,D] with no origins, 409s instead of citing D", () => {
    const existing = { id: "x", sources: sources("A", "B"), emissions: { sourceIndex: 1 } };
    const patch = { sources: sources("A", "D") };
    const r = reconcileSourceIndices(existing, patch, { ...existing, ...patch });
    expect(r).toMatchObject({ ok: false, status: 409, citing: ["emissions.sourceIndex"] });
  });

  it("H1 with origins [0, null]: the removed source is refused, never re-pointed to D", () => {
    const existing = { id: "x", sources: sources("A", "B"), emissions: { sourceIndex: 1 } };
    const patch = { sources: sources("A", "D") };
    const r = reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [0, null]);
    expect(r).toMatchObject({ ok: false, status: 409, citing: ["emissions.sourceIndex"] });
  });

  it("H1 with origins [0, null]: a ref to the kept source still remaps correctly", () => {
    const existing = { id: "x", sources: sources("A", "B"), emissions: { sourceIndex: 0 } };
    const patch = { sources: sources("A", "D") };
    const out = ok(reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [0, null]));
    expect(out.emissions.sourceIndex).toBe(0);
  });

  // Stated refs are the patch author's responsibility; the admin form remaps
  // its own refs (separate unit), so reconcile never rewrites them.
  it("H2: a patch-stated statusHistory ref stays as written, never remapped by url", () => {
    const existing = { id: "x", sources: sources("A", "B"), statusHistory: [{ status: "permitted", date: "2025", sourceIndex: 0 }] };
    const patch = {
      sources: sources("B", "A"),
      statusHistory: [{ status: "permitted", date: "2025", sourceIndex: 0 }], // means B
    };
    const merged = { ...existing, ...patch };
    expect(reconcileSourceIndices(existing, patch, merged)).toEqual({ ok: true, doc: merged });
    const withOrigins = ok(reconcileSourceIndices(existing, patch, merged, [1, 0]));
    expect(withOrigins.statusHistory[0].sourceIndex).toBe(0);
  });

  it("with origins, a reorder remaps carried stakeholders, emissions and disturbedAcres", () => {
    const existing = stored(["a", "b", "c"]);
    const patch = { sources: sources("c", "a", "b") };
    const out = ok(reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [2, 0, 1]));
    expect(out.stakeholders[0].sourceIndex).toBe(1); // a
    expect(out.emissions.sourceIndex).toBe(2); // b
    expect(out.construction.disturbedAcres.sourceIndex).toBe(0); // c
    expect(out.parties.tenant[0].sourceIndex).toBe(2); // b
  });

  it("a url fix plus an append, with origins, keeps the citation", () => {
    const existing = { id: "x", sources: sources("a", "b"), emissions: { sourceIndex: 1 } };
    const patch = { sources: sources("a", "b-fixed", "c") };
    const out = ok(reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [0, 1, null]));
    expect(out.emissions.sourceIndex).toBe(1);
  });

  it("identical duplicate urls, with origins, remap by origin not url", () => {
    const existing = { id: "x", sources: sources("a", "a", "b"), emissions: { sourceIndex: 1 } };
    const patch = { sources: sources("b", "a", "a") };
    const out = ok(reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [2, 0, 1]));
    expect(out.emissions.sourceIndex).toBe(2);
  });

  it("with origins, a removed source cited by a carried ref 409s with its path", () => {
    const existing = stored(["a", "b", "c"]);
    const patch = { sources: sources("a", "c") };
    const r = reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [0, 2]);
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (r.ok) return;
    expect(r.citing).toEqual(["emissions.sourceIndex", "parties.tenant[0].sourceIndex"]);
  });

  it.each([
    ["wrong length", [0]],
    ["out of range", [0, 5]],
    ["negative", [0, -1]],
    ["non-integer", [0, 0.5]],
    ["duplicate", [1, 1]],
  ])("invalid origins (%s) give 400", (_label, origins) => {
    const existing = { id: "x", sources: sources("a", "b"), emissions: { sourceIndex: 0 } };
    const patch = { sources: sources("b", "a") };
    const r = reconcileSourceIndices(existing, patch, { ...existing, ...patch }, origins);
    expect(r).toMatchObject({ ok: false, status: 400, error: "Invalid sourceOrigins" });
  });

  it("a carried energy.utilityEiaId (carryCuratedKeys) counts as carried", () => {
    const existing = { id: "x", sources: sources("a", "b"), energy: { utility: "U", utilityEiaId: { id: 7, sourceIndex: 1 } } };
    const patch = { sources: sources("b", "a"), energy: { utility: "U" } };
    // merge carries utilityEiaId back in, as carryCuratedKeys does
    const merged = { ...existing, sources: patch.sources, energy: { utility: "U", utilityEiaId: { id: 7, sourceIndex: 1 } } };
    expect(reconcileSourceIndices(existing, patch, merged)).toMatchObject({
      ok: false,
      status: 409,
      citing: ["energy.utilityEiaId.sourceIndex"],
    });
    const out = ok(reconcileSourceIndices(existing, patch, merged, [1, 0]));
    expect(out.energy.utilityEiaId.sourceIndex).toBe(0);
  });

  it("does not mutate its inputs", () => {
    const existing = stored(["a", "b", "c"]);
    const patch = { sources: sources("c", "a", "b") };
    const merged = { ...existing, ...patch };
    const snap = structuredClone(merged);
    reconcileSourceIndices(existing, patch, merged, [2, 0, 1]);
    expect(merged).toEqual(snap);
  });

  it("a malformed shape is a 400, not left for later checks", () => {
    const existing = stored(["a", "b"]);
    const patch = { sources: sources("b", "a"), parties: { tenant: "nope" } };
    const merged = { ...existing, ...patch };
    expect(reconcileSourceIndices(existing, patch, merged)).toEqual({
      ok: false,
      status: 400,
      citing: [],
      error: "Invalid facility",
    });
  });

  describe("fail-closed rules", () => {
    it("swapping two different unique-url sources moves the cited ref: 409 without origins", () => {
      const existing = { id: "x", sources: sources("a", "b"), emissions: { sourceIndex: 0 } };
      const patch = { sources: sources("b", "a") };
      expect(reconcileSourceIndices(existing, patch, { ...existing, ...patch })).toMatchObject({
        ok: false,
        status: 409,
        citing: ["emissions.sourceIndex"],
      });
    });

    it("a duplicate-url swap of different sources: 409 without origins", () => {
      const dup = (label: string) => ({ ...src("x"), label });
      const existing = { id: "x", sources: [dup("first"), dup("second")], emissions: { sourceIndex: 0 } };
      const patch = { sources: [dup("second"), dup("first")] };
      expect(reconcileSourceIndices(existing, patch, { ...existing, ...patch })).toMatchObject({
        ok: false,
        status: 409,
        citing: ["emissions.sourceIndex"],
      });
    });

    it("the same duplicate-url swap with honest origins remaps correctly", () => {
      const dup = (label: string) => ({ ...src("x"), label });
      const existing = { id: "x", sources: [dup("first"), dup("second"), src("z")], emissions: { sourceIndex: 0 } };
      const patch = { sources: [src("z"), dup("second"), dup("first")] };
      const out = ok(reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [2, 1, 0]));
      expect(out.emissions.sourceIndex).toBe(2);
    });

    it("origins always remap: deep-equal sources arrays with swapped origins still move refs", () => {
      const existing = { id: "x", sources: [src("x"), src("x")], emissions: { sourceIndex: 0 } };
      const patch = { sources: [src("x"), src("x")] };
      const out = ok(reconcileSourceIndices(existing, patch, { ...existing, ...patch }, [1, 0]));
      expect(out.emissions.sourceIndex).toBe(1);
    });

    it("a url fix on a CITED carried source: 409 without origins, kept with identity origins", () => {
      const existing = { id: "x", sources: sources("a", "b"), emissions: { sourceIndex: 1 } };
      const patch = { sources: sources("a", "b-fixed") };
      const merged = { ...existing, ...patch };
      expect(reconcileSourceIndices(existing, patch, merged)).toMatchObject({ ok: false, status: 409 });
      expect(ok(reconcileSourceIndices(existing, patch, merged, [0, 1])).emissions.sourceIndex).toBe(1);
    });

    it("a label/retrievedAt refresh on a unique-url cited source passes without origins", () => {
      const existing = { id: "x", sources: sources("a", "b"), emissions: { sourceIndex: 1 } };
      const refreshed = { ...src("b"), label: "renamed", retrievedAt: "2026-11-01" };
      const patch = { sources: [src("a"), refreshed] };
      const merged = { ...existing, ...patch };
      expect(reconcileSourceIndices(existing, patch, merged)).toEqual({ ok: true, doc: merged });
    });

    it("identical duplicate sources swapped without origins pass (deep-equal at each index)", () => {
      const existing = { id: "x", sources: [src("x"), src("x"), src("y")], emissions: { sourceIndex: 0 } };
      const patch = { sources: [src("x"), src("x"), src("y"), src("w")] };
      const merged = { ...existing, ...patch };
      expect(reconcileSourceIndices(existing, patch, merged)).toEqual({ ok: true, doc: merged });
    });
  });
});

describe("refPathToIssuePath", () => {
  it.each([
    ["statusHistory[0].sourceIndex", ["statusHistory", 0, "sourceIndex"]],
    ["emissions.sourceIndex", ["emissions", "sourceIndex"]],
    ["subsidies[3].sourceIndex", ["subsidies", 3, "sourceIndex"]],
    ["stakeholders[12].sourceIndex", ["stakeholders", 12, "sourceIndex"]],
    ["jobs.sourceIndex", ["jobs", "sourceIndex"]],
    ["community.sourceIndex", ["community", "sourceIndex"]],
    ["ids.epaFrsId.sourceIndex", ["ids", "epaFrsId", "sourceIndex"]],
    ["ids.eiaPlantId.sourceIndex", ["ids", "eiaPlantId", "sourceIndex"]],
    ["energy.utilityEiaId.sourceIndex", ["energy", "utilityEiaId", "sourceIndex"]],
    ["parties.ownerEntity[1].sourceIndex", ["parties", "ownerEntity", 1, "sourceIndex"]],
    ["parties.generalContractor[0].sourceIndex", ["parties", "generalContractor", 0, "sourceIndex"]],
    ["construction.expectedStart.sourceIndex", ["construction", "expectedStart", "sourceIndex"]],
    ["construction.phases[2].sourceIndex", ["construction", "phases", 2, "sourceIndex"]],
  ])("%s is an array path", (path, expected) => {
    expect(refPathToIssuePath(path)).toEqual(expected);
  });
});
