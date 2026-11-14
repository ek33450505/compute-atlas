import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { applyBalancingAuthority, baSourceLabel, buildBaIndex, computeBalancingAuthority, RTO_BY_BA } from "./balancing-authority";
import { DEFAULT_EIA861_PATH, EIA861_2025, loadEia861, type Eia861Data } from "./eia861";

type Row = { id: number; state: string; serviceType: string; baCode: string };
const dataOf = (rows: Row[]): Eia861Data => ({
  provenance: EIA861_2025,
  utilities: new Map(),
  territory: [],
  salesBa: rows.map((r) => ({ ...r, part: "A" })),
});
const fac = (id: number | undefined, state = "VA") => ({
  location: { state },
  ...(id === undefined ? {} : { energy: { utilityEiaId: { id } } }),
});

describe("buildBaIndex", () => {
  it("routes Bundled/Delivery to primary and Energy to energy, dropping NA and blank codes", () => {
    const idx = buildBaIndex(
      dataOf([
        { id: 1, state: "VA", serviceType: "Bundled", baCode: "PJM" },
        { id: 2, state: "TX", serviceType: "Delivery", baCode: "ERCO" },
        { id: 3, state: "NY", serviceType: "Energy", baCode: "NYIS" },
        { id: 4, state: "NY", serviceType: "Bundled", baCode: "NA" },
        { id: 5, state: "NY", serviceType: "Bundled", baCode: "" },
        { id: 6, state: "NY", serviceType: "Other", baCode: "PJM" },
      ]),
    );
    expect([...idx.primary.keys()]).toEqual(["1|VA", "2|TX"]);
    expect([...idx.energy.keys()]).toEqual(["3|NY"]);
  });
});

describe("computeBalancingAuthority", () => {
  const idx = buildBaIndex(
    dataOf([
      { id: 1, state: "VA", serviceType: "Bundled", baCode: "PJM" },
      { id: 2, state: "NC", serviceType: "Bundled", baCode: "DUK" },
      { id: 3, state: "TX", serviceType: "Delivery", baCode: "ERCO" },
      { id: 4, state: "NY", serviceType: "Energy", baCode: "NYIS" },
      { id: 5, state: "ME", serviceType: "Bundled", baCode: "ISNE" },
      { id: 5, state: "ME", serviceType: "Delivery", baCode: "NBSO" },
      { id: 6, state: "NY", serviceType: "Bundled", baCode: "NA" },
      { id: 7, state: "NY", serviceType: "Bundled", baCode: "MISO" },
      { id: 7, state: "NY", serviceType: "Energy", baCode: "PJM" },
    ]),
  );
  it("maps a single RTO BA to its RTO", () => expect(computeBalancingAuthority(fac(1), idx)).toEqual({ balancingAuthority: "PJM", isoRto: "PJM" }));
  it("gives a non-RTO BA no isoRto key", () => expect(computeBalancingAuthority(fac(2, "NC"), idx)).toEqual({ balancingAuthority: "DUK" }));
  it("maps ERCO to ERCOT", () => expect(computeBalancingAuthority(fac(3, "TX"), idx)).toEqual({ balancingAuthority: "ERCO", isoRto: "ERCOT" }));
  it("falls back to Energy rows", () => expect(computeBalancingAuthority(fac(4, "NY"), idx)).toEqual({ balancingAuthority: "NYIS", isoRto: "NYISO" }));
  it("does not use Energy rows when a primary code exists", () => expect(computeBalancingAuthority(fac(7, "NY"), idx)).toEqual({ balancingAuthority: "MISO", isoRto: "MISO" }));
  it("flags more than one code", () => expect(computeBalancingAuthority(fac(5, "ME"), idx)).toEqual({ flag: "multiple_hits:balancingAuthority" }));
  it("flags a utility with no code, or in another state", () => {
    expect(computeBalancingAuthority(fac(6, "NY"), idx)).toEqual({ flag: "ba_unknown" });
    expect(computeBalancingAuthority(fac(1, "MD"), idx)).toEqual({ flag: "ba_unknown" });
  });
  it("returns null without a utility id", () => expect(computeBalancingAuthority(fac(undefined), idx)).toBeNull());
  it("covers the seven RTO codes", () => expect(Object.keys(RTO_BY_BA).sort()).toEqual(["CISO", "ERCO", "ISNE", "MISO", "NYIS", "PJM", "SWPP"]));
});

describe("applyBalancingAuthority", () => {
  const label = "EIA-861 2025 (x)";
  const base = {
    countyFips: "51107",
    pin: { lat: 39, lon: -77.5, precision: "exact" },
    flags: ["multiple_hits:county", "ba_unknown"],
    sources: { county: "c", egrid: "e", ba: "old" },
    computedAt: "2026-01-01",
    balancingAuthority: "STALE",
    isoRto: "PJM",
  };

  it("sets keys and sources.ba", () => {
    const out = applyBalancingAuthority({ pin: 1, sources: { county: "c" }, computedAt: "d" }, { balancingAuthority: "ERCO", isoRto: "ERCOT" }, label);
    expect(out).toEqual({ pin: 1, sources: { county: "c", ba: label }, computedAt: "d", balancingAuthority: "ERCO", isoRto: "ERCOT" });
  });

  it("removes stale keys and only the BA flags, leaving everything else byte-identical", () => {
    const out = applyBalancingAuthority(base, null, label);
    expect(out).toEqual({
      countyFips: "51107",
      pin: base.pin,
      flags: ["multiple_hits:county"],
      sources: { county: "c", egrid: "e" },
      computedAt: "2026-01-01",
    });
  });

  it("replaces a stale flag with the new one", () => {
    const out = applyBalancingAuthority(base, { flag: "multiple_hits:balancingAuthority" }, label);
    expect(out.flags).toEqual(["multiple_hits:county", "multiple_hits:balancingAuthority"]);
    expect(out).not.toHaveProperty("balancingAuthority");
    expect((out.sources as Record<string, string>).ba).toBe(label);
  });

  it("drops an emptied flags array", () => {
    const out = applyBalancingAuthority({ ...base, flags: ["ba_unknown"] }, { balancingAuthority: "DUK" }, label);
    expect(out).not.toHaveProperty("flags");
  });

  it("is idempotent and does not mutate its input", () => {
    const frozen = structuredClone(base);
    const result = { balancingAuthority: "PJM", isoRto: "PJM" as const };
    const once = applyBalancingAuthority(base, result, label);
    expect(base).toEqual(frozen);
    expect(applyBalancingAuthority(once, result, label)).toEqual(once);
    const flagged = applyBalancingAuthority(base, { flag: "ba_unknown" as const }, label);
    expect(applyBalancingAuthority(flagged, { flag: "ba_unknown" as const }, label)).toEqual(flagged);
  });

  it("preserves key order, with the BA keys placed just before pin", () => {
    const input = { countyFips: "1", egridSubregion: "X", pin: 1, flags: ["multiple_hits:county"], sources: { county: "c", egrid: "e" }, computedAt: "d" };
    const out = applyBalancingAuthority(input, { balancingAuthority: "PJM", isoRto: "PJM", flag: undefined }, label);
    expect(Object.keys(out)).toEqual(["countyFips", "egridSubregion", "balancingAuthority", "isoRto", "pin", "flags", "sources", "computedAt"]);
    expect(Object.keys(out.sources as object)).toEqual(["county", "egrid", "ba"]);
    // Re-applying a stale-ordered entry (BA keys at the end, ba mid-sources) normalises, and does so stably.
    const again = applyBalancingAuthority(out, { balancingAuthority: "PJM", isoRto: "PJM" as const }, label);
    expect(JSON.stringify(again)).toBe(JSON.stringify(out));
  });

  it("a null result on an entry with no BA data is byte-identical", () => {
    const input = { countyFips: "1", pin: { lat: 1, lon: 2 }, flags: ["multiple_hits:county"], sources: { county: "c", egrid: "e" }, computedAt: "d" };
    expect(JSON.stringify(applyBalancingAuthority(input, null, label))).toBe(JSON.stringify(input));
  });

  it("appends the BA flag last and keeps sources.ba in place when it exists", () => {
    const input = { pin: 1, flags: ["a", "ba_unknown", "b"], sources: { ba: "old", county: "c" }, computedAt: "d" };
    const out = applyBalancingAuthority(input, { flag: "multiple_hits:balancingAuthority" }, label);
    expect(out.flags).toEqual(["a", "b", "multiple_hits:balancingAuthority"]);
    expect(Object.keys(out.sources as object)).toEqual(["ba", "county"]);
  });

  it("creates a missing flags key where computeJoinKeysFor does: immediately before sources", () => {
    const f = { flag: "ba_unknown" as const };
    expect(Object.keys(applyBalancingAuthority({ countyFips: "1", pin: 1, sources: { county: "c" }, computedAt: "d" }, f, label))).toEqual(["countyFips", "pin", "flags", "sources", "computedAt"]);
  });

  it("throws when there is a result but no sources object", () => {
    expect(() => applyBalancingAuthority({ pin: 1 }, { balancingAuthority: "DUK" }, label)).toThrow(/sources/);
    expect(() => applyBalancingAuthority({ pin: 1, sources: [] }, { flag: "ba_unknown" }, label)).toThrow(/sources/);
    expect(applyBalancingAuthority({ pin: 1 }, null, label)).toEqual({ pin: 1 });
  });

  it("labels the source from the provenance year", () => {
    expect(baSourceLabel(EIA861_2025)).toBe("EIA-861 2025 (balancing authority of the utility's retail sales in the state)");
  });
});

const REAL = path.join(process.cwd(), DEFAULT_EIA861_PATH);

describe.skipIf(!existsSync(REAL))("real EIA-861 2025 file", () => {
  let idx: ReturnType<typeof buildBaIndex>;
  beforeAll(() => {
    idx = buildBaIndex(loadEia861(readFileSync(REAL)));
  });
  it.each([
    [19876, "VA", { balancingAuthority: "PJM", isoRto: "PJM" }],
    [5416, "NC", { balancingAuthority: "DUK" }],
    [7140, "GA", { balancingAuthority: "SOCO" }],
    [44372, "TX", { balancingAuthority: "ERCO", isoRto: "ERCOT" }], // Delivery_Companies
    [14354, "UT", { balancingAuthority: "PACE" }],
    [15296, "NY", { balancingAuthority: "NYIS", isoRto: "NYISO" }], // Energy fallback
  ])("utility %i in %s", (id, state, expected) => {
    expect(computeBalancingAuthority(fac(id, state), idx)).toEqual(expected);
  });
});
