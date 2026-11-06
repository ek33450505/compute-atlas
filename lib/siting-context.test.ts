import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import sitingContextRaw from "@/data/siting-context.json";
import {
  missingNearestWaterOffenders,
  NON_CONUS,
  planLedgerUpdate,
  type FacilityStateRow,
} from "./nhd-debt";
import { ratchetVerdict } from "./test-fixtures/nhd-ratchet";
import {
  loadSitingContextUncached,
  sitingContextSchema,
  loadWaterStressByIdUncached,
  splitRiskLabel,
  type SitingContext,
  type SitingSource,
} from "./siting-context";

describe("splitRiskLabel", () => {
  it("splits a label with a trailing parenthetical detail", () => {
    expect(splitRiskLabel("Extremely High (>80%)")).toEqual({
      category: "Extremely High",
      detail: ">80%",
    });
  });

  it("splits a label with a hyphenated range detail", () => {
    expect(splitRiskLabel("High (4-8 cm/y)")).toEqual({
      category: "High",
      detail: "4-8 cm/y",
    });
  });

  it("returns no detail when the label has no parenthetical", () => {
    expect(splitRiskLabel("Extremely High")).toEqual({
      category: "Extremely High",
    });
  });

  it("trims surrounding whitespace from category and detail", () => {
    expect(splitRiskLabel("  Medium  ( 20-40% ) ")).toEqual({
      category: "Medium",
      detail: "20-40%",
    });
  });
});

describe("data-integrity: siting-context coverage (fixture)", () => {
  // Only forward coverage (facility -> siting entry) is asserted here.
  // The reverse is expected and legitimate: retiring a facility requires a
  // raw Neon delete (see CLAUDE.md) that leaves a stale siting-context entry
  // behind on purpose. Do NOT add an orphan-entry assertion — that would
  // break retirements, not catch a real bug.
  // The real-dataset equivalent lives in siting-context.dataset.test.ts.
  it("has a data/siting-context.json entry for every facility in data/facilities.json (fixture)", () => {
    const sitingIds = new Set(Object.keys(sitingContextRaw));
    const missingIds = (facilitiesRaw as Array<{ id: string }>)
      .map((facility) => facility.id)
      .filter((id) => !sitingIds.has(id));

    if (missingIds.length > 0) {
      const shown = missingIds.slice(0, 20);
      const more = missingIds.length - shown.length;
      const suffix = more > 0 ? `, and ${more} more` : "";
      throw new Error(
        `${missingIds.length} facilit${missingIds.length === 1 ? "y is" : "ies are"} missing ` +
          `from data/siting-context.json: ${shown.join(", ")}${suffix}. ` +
          "This happens when a data wave runs db:export but skips `npm run build:mapdata` " +
          "before committing. Run `npm run build:mapdata` and commit the regenerated " +
          "data/siting-context.json. " +
          "It can also happen after build:mapdata HAS run: a facility may match no siting " +
          "dataset at all (NHD, HIFLD, Aqueduct and the USGS principal aquifers are " +
          "CONUS-only, so a non-CONUS point can miss every one). That is not an excuse to " +
          "omit it — scripts/build-map-data.mjs must still record `{}` for such a facility.",
      );
    }

    expect(missingIds).toEqual([]);
  });
});

describe("data-integrity: NHD backfill debt helpers", () => {
  it("keeps NON_CONUS scoped to exactly the six CONUS-excluded jurisdictions", () => {
    // Widening this set is the cheapest way to make a failing debt test above
    // pass without paying down any real debt: every added state's offenders
    // would be silently excluded instead of fixed. Pin the exact membership so
    // that route is closed off.
    expect(Array.from(NON_CONUS).sort()).toEqual(["AK", "GU", "HI", "MP", "PR", "VI"]);
  });

  it("does not count an orphan (siting entry with no matching facility) as debt", () => {
    // Regression test for a reviewer-flagged bug: an id present in
    // siting-context.json but absent from facilities.json used to fall back to
    // state "(unknown)", which is not in NON_CONUS, so it was miscounted as
    // debt. An orphan has no facility page, so it never renders a partial
    // "Siting context" panel — it isn't debt. Retiring a facility takes a raw
    // Neon delete that deliberately leaves a stale siting entry behind (see
    // CLAUDE.md and the coverage-test comment above), so this is a sanctioned
    // case, not an error state.
    //
    // The real dataset has zero orphans, so this can
    // only be exercised with injected data — hence
    // missingNearestWaterOffenders() takes facilities/sitingContext as params
    // instead of this test mutating the imported JSON.
    const facilities: FacilityStateRow[] = [{ id: "known-1", location: { state: "TX" } }];
    const sitingContext: Record<string, SitingContext> = {
      "known-1": {}, // real facility, missing nearestWater -> IS debt
      "orphan-1": {}, // no matching facility -> must NOT be counted as debt
    };

    const offenders = missingNearestWaterOffenders(facilities, sitingContext);

    expect(offenders).toEqual([{ id: "known-1", state: "TX" }]);
  });

  it("excludes non-CONUS records from the debt count", () => {
    // The fixture deliberately carries 3 Alaska records with no nearestWater.
    // They are non-CONUS, so the debt is 0; if the exclusion broke, they would
    // surface as offenders. The fixture has no CONUS record lacking nearestWater.
    // Same `!== undefined` semantics as missingNearestWaterOffenders.
    const facilities = facilitiesRaw as FacilityStateRow[];
    const siting = sitingContextRaw as Record<string, SitingContext>;
    const lacking = facilities.filter((f) => siting[f.id]?.nearestWater === undefined);
    expect(lacking.length).toBeGreaterThan(0);
    expect(lacking.every((f) => NON_CONUS.has(f.location.state))).toBe(true);
    expect(missingNearestWaterOffenders(facilities, siting)).toEqual([]);
  });

  it("counts a CONUS record lacking nearestWater, and ignores one that has it", () => {
    const has = { nearestWater: { name: "x", distanceKm: 1 } } as unknown as SitingContext;
    const rows: FacilityStateRow[] = [
      { id: "lacks", location: { state: "TX" } },
      { id: "has", location: { state: "TX" } },
      { id: "ak", location: { state: "AK" } },
    ];
    expect(missingNearestWaterOffenders(rows, { lacks: {}, has, ak: {} })).toEqual([
      { id: "lacks", state: "TX" },
    ]);
  });
});

describe("data-integrity: NHD debt ratchet decision (pure inputs)", () => {
  // The dataset run (siting-context.dataset.test.ts) applies ratchetVerdict to
  // the real ledger and dataset; here the same shared helper
  // (test-fixtures/nhd-ratchet.ts) is tested on pure inputs so the default run
  // proves it bites in BOTH directions. A passing check while the bug is present
  // would be a ratchet that only guards growth: the "paid down" case below would
  // also read "ok". planLedgerUpdate (the script's side) is cross-checked for
  // its equality branch only: it writes nothing exactly when the verdict is ok.
  it("ratchetVerdict: equal is ok, more is grew, fewer is paid_down", () => {
    expect(ratchetVerdict(2, 2)).toBe("ok");
    expect(ratchetVerdict(3, 2)).toBe("grew");
    expect(ratchetVerdict(1, 2)).toBe("paid_down");
    expect(ratchetVerdict(0, 0)).toBe("ok");
  });

  const facilities: FacilityStateRow[] = [
    { id: "a", location: { state: "TX" } },
    { id: "b", location: { state: "OH" } },
    { id: "c", location: { state: "PA" } },
    { id: "ak", location: { state: "AK" } }, // non-CONUS: never counted
  ];
  const ledger = { ceiling: 2, asOf: "2026-01-01", note: "test" };
  const decide = (siting: Record<string, SitingContext>) => {
    const count = missingNearestWaterOffenders(facilities, siting).length;
    return { count, plan: planLedgerUpdate(count, ledger, undefined, "2026-02-02") };
  };
  const water = { nearestWater: { name: "x", distanceKm: 1 } } as unknown as SitingContext;

  it("passes (no ledger change) when the debt equals the ceiling", () => {
    const { count, plan } = decide({ a: {}, b: {}, c: water, ak: {} });
    expect(count).toBe(2);
    expect(ratchetVerdict(count, ledger.ceiling)).toBe("ok");
    expect(plan.next).toBeNull();
  });

  it("fails when the debt exceeds the ceiling (unrecorded growth)", () => {
    const { count, plan } = decide({ a: {}, b: {}, c: {}, ak: {} });
    expect(count).toBe(3);
    expect(ratchetVerdict(count, ledger.ceiling)).toBe("grew");
    expect(plan.next?.ceiling).toBe(3);
  });

  it("fails when the debt drops below the ceiling (silent paydown)", () => {
    const { count, plan } = decide({ a: {}, b: water, c: water, ak: {} });
    expect(count).toBe(1);
    expect(ratchetVerdict(count, ledger.ceiling)).toBe("paid_down");
    expect(plan.next?.ceiling).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Neon loaders, with an injected fake source. The fallback is the bundled
// snapshot; `neon` rows below deliberately DIFFER from it so a hit is
// distinguishable from a fallback.
// ---------------------------------------------------------------------------
const snapshot = sitingContextRaw as Record<string, SitingContext>;
const REAL_ID = "xai-colossus-memphis-tn";
const NEON_ENTRY: SitingContext = { waterStress: { cat: 4, label: "From Neon (>80%)" } };

function fakeSource(overrides: Partial<SitingSource> = {}): SitingSource {
  return {
    one: async () => NEON_ENTRY,
    waterStress: async () => new Map([[REAL_ID, NEON_ENTRY.waterStress]]),
    ...overrides,
  };
}

describe("Neon siting loaders", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the Neon row on a hit, not the snapshot", async () => {
    expect(await loadSitingContextUncached(REAL_ID, fakeSource())).toEqual(NEON_ENTRY);
  });

  it("falls back to the snapshot (and warns with a SQLSTATE only) when Neon throws", async () => {
    const source = fakeSource({
      one: async () => {
        throw Object.assign(new Error("Failed query: select ... params: secret@example.com"), {
          code: "08006",
        });
      },
    });
    expect(await loadSitingContextUncached(REAL_ID, source)).toEqual(snapshot[REAL_ID]);
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("08006");
    expect(logged).not.toContain("secret@example.com");
  });

  it("a missing Neon row means no data: undefined, NOT the snapshot", async () => {
    const source = fakeSource({ one: async () => undefined });
    expect(snapshot[REAL_ID]).toBeDefined();
    expect(await loadSitingContextUncached(REAL_ID, source)).toBeUndefined();
  });

  it("falls back to the snapshot (and warns) when the Neon row is invalid", async () => {
    const source = fakeSource({ one: async () => "not an object" });
    expect(await loadSitingContextUncached(REAL_ID, source)).toEqual(snapshot[REAL_ID]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back when a row's waterStress lacks its label (it would throw at render)", async () => {
    const source = fakeSource({ one: async () => ({ waterStress: { cat: 4 } }) });
    expect(await loadSitingContextUncached(REAL_ID, source)).toEqual(snapshot[REAL_ID]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back when a row's distanceMi is not a number", async () => {
    const source = fakeSource({ one: async () => ({ nearestWater: { name: "x", kind: "river", distanceMi: "far" } }) });
    expect(await loadSitingContextUncached(REAL_ID, source)).toEqual(snapshot[REAL_ID]);
  });

  it("accepts an unknown extra key and returns it untouched", async () => {
    const row = { ...NEON_ENTRY, futureField: { a: 1 } };
    expect(await loadSitingContextUncached(REAL_ID, fakeSource({ one: async () => row }))).toEqual(row);
  });

  it("water-stress map: an entry without a label falls back to the snapshot values", async () => {
    const source = fakeSource({ waterStress: async () => new Map<string, unknown>([[REAL_ID, { cat: 4 }]]) });
    const out = await loadWaterStressByIdUncached(source);
    expect(out[REAL_ID]).toEqual(snapshot[REAL_ID]?.waterStress);
  });

  it("treats a JSON-null field as absent, with no fallback", async () => {
    const row = { nearestWater: null, waterStress: NEON_ENTRY.waterStress };
    const out = await loadSitingContextUncached(REAL_ID, fakeSource({ one: async () => row }));
    expect(out).toEqual({ waterStress: NEON_ENTRY.waterStress });
    expect(out).not.toHaveProperty("nearestWater");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("water-stress map: a JSON-null projection row is skipped, not a failure", async () => {
    const source = fakeSource({
      waterStress: async () =>
        new Map<string, unknown>([
          [REAL_ID, NEON_ENTRY.waterStress],
          ["null-row", null],
        ]),
    });
    expect(await loadWaterStressByIdUncached(source)).toEqual({ [REAL_ID]: NEON_ENTRY.waterStress });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("water-stress map: a non-object value (string) is invalid and falls back to the snapshot values", async () => {
    const source = fakeSource({ waterStress: async () => new Map<string, unknown>([[REAL_ID, "high"]]) });
    const out = await loadWaterStressByIdUncached(source);
    expect(out[REAL_ID]).toEqual(snapshot[REAL_ID]?.waterStress);
    expect(console.warn).toHaveBeenCalled();
  });

  it("every entry in the bundled siting file passes the schema", () => {
    const failures = Object.entries(snapshot)
      .filter(([, v]) => !sitingContextSchema.safeParse(v).success)
      .map(([id]) => id);
    expect(failures).toEqual([]);
    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
  });

  it("returns undefined for an id absent from both Neon and the snapshot", async () => {
    const source = fakeSource({ one: async () => undefined });
    expect(await loadSitingContextUncached("no-such-facility", source)).toBeUndefined();
  });

  it("does not touch Neon when reads are not allowed to use the database", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const one = vi.fn(async () => NEON_ENTRY);
    expect(await loadSitingContextUncached(REAL_ID, fakeSource({ one }))).toEqual(snapshot[REAL_ID]);
    expect(one).not.toHaveBeenCalled();
  });

  it("water-stress map: hit returns the Neon projection", async () => {
    expect(await loadWaterStressByIdUncached(fakeSource())).toEqual({
      [REAL_ID]: NEON_ENTRY.waterStress,
    });
  });

  it("water-stress map: throw falls back to the snapshot's waterStress values", async () => {
    const source = fakeSource({
      waterStress: async () => {
        throw new Error("fetch failed");
      },
    });
    const result = await loadWaterStressByIdUncached(source);
    expect(result[REAL_ID]).toEqual(snapshot[REAL_ID].waterStress);
    expect(Object.keys(result).length).toBeGreaterThan(10);
  });

  it("water-stress map: an empty result falls back to the snapshot", async () => {
    const source = fakeSource({ waterStress: async () => new Map() });
    const result = await loadWaterStressByIdUncached(source);
    expect(result[REAL_ID]).toEqual(snapshot[REAL_ID].waterStress);
  });
});

describe("unstable_cache entry sizes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // unstable_cache refuses entries over 2 MiB, envelope (~2.3KB) included, and
  // fails silently: every read then misses and hits Neon. Measured on the
  // fixture; the aggregate is a waterStress-only projection because the whole
  // table (~420 B/record at full scale) would cross the limit near 4,700 records.
  const LIMIT = 2 * 1024 * 1024;
  const ENVELOPE = 4 * 1024;
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

  it("every per-facility entry is far under the limit", () => {
    const largest = Math.max(...Object.values(snapshot).map(bytes));
    expect(largest + ENVELOPE).toBeLessThan(LIMIT);
    expect(largest).toBeLessThan(8 * 1024);
  });

  it("the aggregate water-stress entry stays under the limit even at 10,000 facilities", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const map = await loadWaterStressByIdUncached();
    const perRecord = bytes(map) / Object.keys(map).length;
    expect(perRecord * 10_000 + ENVELOPE).toBeLessThan(LIMIT);
  });
});
