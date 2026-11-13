import { describe, it, expect, vi } from "vitest";

import { sitingContextSchema } from "../lib/siting-context-schema";
import {
  pointQueryUrl,
  parseSingleAttribute,
  needsRecompute,
  computeJoinKeysFor,
  buildEgridLocator,
  computeAllJoinKeys,
  preflightJoinKeys,
  COUNTY_URL,
  TRACT_URL,
  EGRID_URL,
  EGRID_MULTI_URL,
} from "./join-keys.mjs";

const feats = (...attrs: Record<string, string>[]) => ({ features: attrs.map((attributes) => ({ attributes })) });
const none = { features: [] };

const fac = (over: Record<string, unknown> = {}, id = "f1") => ({
  id,
  location: { lat: 39.0438, lon: -77.4875, precision: "exact", county: "Loudoun", ...over },
});

type Handlers = Partial<Record<"county" | "tract", unknown>>;
// eGRID is a local lookup now: any query to an eGRID layer is a bug, so the fake fails loudly on one.
function fakeQuery(h: Handlers = {}) {
  const defaults: Required<Handlers> = {
    county: feats({ GEOID: "51107", NAME: "Loudoun" }),
    tract: feats({ GEOID: "51107611005" }),
  };
  const fn = vi.fn(async (url: string) => {
    if (url.startsWith(EGRID_URL) || url.startsWith(EGRID_MULTI_URL)) throw new Error("unexpected eGRID network query");
    const kind = url.startsWith(COUNTY_URL) ? "county" : "tract";
    const v = kind in h ? h[kind as keyof Handlers] : defaults[kind as keyof Handlers];
    if (v instanceof Error) throw v;
    return v;
  });
  return fn;
}
const fakeLocator = ({ subregions = ["SRVC"], inMultiple = false }: { subregions?: string[]; inMultiple?: boolean } = {}) =>
  vi.fn((_lon: number, _lat: number) => ({ subregions, inMultiple }));
const opts = (query: unknown, egridLocator: unknown = fakeLocator()) =>
  ({ query, delayMs: 0, today: "2026-11-13", egridLocator }) as { query: never; delayMs: number; today: string; egridLocator: never; skipKeys?: never };

// A square [x0,x1]x[y0,y1] ring, closed.
const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feature = (geometry: unknown, properties: Record<string, unknown> = { Subregion: "AAAA" }) => ({ type: "Feature", properties, geometry });
const multiFeature = (rings = sq(100, 0, 110, 10)) => feature({ type: "Polygon", coordinates: [rings] }, { MultipleSu: "X/Y" });

describe("pointQueryUrl / parseSingleAttribute", () => {
  it("builds a point query url", () => {
    const u = pointQueryUrl("https://x/query", -77.4, 39.1, "GEOID,NAME");
    expect(u).toContain("geometry=-77.4,39.1");
    expect(u).toContain("outFields=GEOID%2CNAME");
    expect(u).toContain("returnGeometry=false");
  });
  it("distinguishes one, zero and many features", () => {
    expect(parseSingleAttribute(feats({ A: "1" }), "A")).toEqual({ value: "1" });
    expect(parseSingleAttribute(none, "A")).toEqual({ none: true });
    expect(parseSingleAttribute(feats({ A: "1" }, { A: "2" }), "A")).toEqual({ multiple: ["1", "2"] });
  });
  it("throws on malformed bodies", () => {
    expect(() => parseSingleAttribute({}, "A")).toThrow();
    expect(() => parseSingleAttribute(null, "A")).toThrow();
    expect(() => parseSingleAttribute(feats({ B: "1" }), "A")).toThrow();
  });
});

describe("computeJoinKeysFor", () => {
  it("exact pin yields every key", async () => {
    const { joinKeys, failures } = await computeJoinKeysFor(fac(), undefined, opts(fakeQuery()));
    expect(failures).toEqual([]);
    expect(joinKeys).toMatchObject({
      countyFips: "51107",
      tractGeoid: "51107611005",
      egridSubregion: "SRVC",
      pin: { lat: 39.0438, lon: -77.4875, precision: "exact" },
      computedAt: "2026-11-13",
    });
    expect(joinKeys.flags).toBeUndefined();
    expect(joinKeys.egridMultiple).toBeUndefined();
    expect(joinKeys.sources.tract).toBeDefined();
  });

  it("approximate pin makes no tract query", async () => {
    const q = fakeQuery();
    const { joinKeys } = await computeJoinKeysFor(fac({ precision: "approximate" }), undefined, opts(q));
    expect(q.mock.calls.some(([u]) => u.startsWith(TRACT_URL))).toBe(false);
    expect(joinKeys.tractGeoid).toBeUndefined();
    expect(joinKeys.sources.tract).toBeUndefined();
    expect(joinKeys.countyFips).toBe("51107");
  });

  it("zero features clears the value and flags, never null", async () => {
    const prev = { countyFips: "51107", egridSubregion: "SRVC", pin: { lat: 39.0438, lon: -77.4875, precision: "exact" } };
    const { joinKeys, failures } = await computeJoinKeysFor(
      fac(),
      prev,
      opts(fakeQuery({ county: none }), fakeLocator({ subregions: [] })),
    );
    expect(failures).toEqual([]);
    expect(joinKeys.countyFips).toBeUndefined();
    expect(joinKeys.egridSubregion).toBeUndefined();
    expect(joinKeys.flags).toEqual(expect.arrayContaining(["county_no_polygon", "egrid_no_polygon"]));
    expect(JSON.stringify(joinKeys)).not.toContain("null");
  });

  it("a throwing query carries the previous value forward and records the failure", async () => {
    const prev = { countyFips: "51107", tractGeoid: "51107611005", egridSubregion: "SRVC", pin: { lat: 39.0438, lon: -77.4875, precision: "exact" } };
    const { joinKeys, failures } = await computeJoinKeysFor(
      fac(),
      prev,
      opts(fakeQuery({ county: new Error("boom"), tract: new Error("boom") })),
    );
    expect(joinKeys.countyFips).toBe("51107");
    expect(joinKeys.tractGeoid).toBe("51107611005");
    expect(joinKeys.egridSubregion).toBe("SRVC");
    expect(failures.map((f: { key: string }) => f.key)).toEqual(["countyFips", "tractGeoid"]);
    expect(JSON.stringify(joinKeys)).not.toContain("null");
  });

  it("a throwing query with no previous value leaves the key absent", async () => {
    const { joinKeys, failures } = await computeJoinKeysFor(fac(), undefined, opts(fakeQuery({ county: new Error("boom") })));
    expect("countyFips" in joinKeys).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it("multiple hits keep no value and flag", async () => {
    const { joinKeys } = await computeJoinKeysFor(
      fac(),
      undefined,
      opts(fakeQuery({ tract: feats({ GEOID: "51107611005" }, { GEOID: "51107611006" }) })),
    );
    expect(joinKeys.tractGeoid).toBeUndefined();
    expect(joinKeys.flags).toContain("multiple_hits:tractGeoid");
  });

  it("flags a tract whose county prefix disagrees", async () => {
    const { joinKeys } = await computeJoinKeysFor(fac(), undefined, opts(fakeQuery({ tract: feats({ GEOID: "51153611005" }) })));
    expect(joinKeys.flags).toContain("tract_county_mismatch");
  });

  it("sets egridMultiple on a multiple-subregions hit", async () => {
    const { joinKeys } = await computeJoinKeysFor(fac(), undefined, opts(fakeQuery(), fakeLocator({ inMultiple: true })));
    expect(joinKeys.egridMultiple).toBe(true);
  });

  it("flags several eGRID subregions and keeps no value", async () => {
    const { joinKeys } = await computeJoinKeysFor(fac(), undefined, opts(fakeQuery(), fakeLocator({ subregions: ["A", "B"] })));
    expect(joinKeys.egridSubregion).toBeUndefined();
    expect(joinKeys.flags).toContain("multiple_hits:egridSubregion");
  });

  it("makes no eGRID network query and never asks the locator twice", async () => {
    const q = fakeQuery();
    const loc = fakeLocator();
    await computeJoinKeysFor(fac(), undefined, opts(q, loc));
    expect(q.mock.calls.some(([u]) => u.startsWith(EGRID_URL) || u.startsWith(EGRID_MULTI_URL))).toBe(false);
    expect(loc).toHaveBeenCalledTimes(1);
    expect(loc).toHaveBeenCalledWith(-77.4875, 39.0438);
  });

  it("throws without a locator unless egrid is skipped", async () => {
    const o = { query: fakeQuery(), delayMs: 0 } as never;
    await expect(computeJoinKeysFor(fac(), undefined, o)).rejects.toThrow(/egridLocator is required/);
    await expect(computeJoinKeysFor(fac(), undefined, { query: fakeQuery(), egridLocator: "x" } as never)).rejects.toThrow(/egridLocator/);
    await expect(computeJoinKeysFor(fac(), undefined, { query: fakeQuery(), skipKeys: ["egrid"] } as never)).resolves.toBeDefined();
  });

  it.each([
    ["Loudoun County", "Loudoun", false],
    ["Orleans Parish", "Orleans", false],
    ["Loudoun", "loudoun county", false],
    ["Richmond city", "Richmond", false],
    ["Anchorage Municipality", "Anchorage", false],
    ["Juneau", "Juneau City and Borough", false],
    ["Charles City", "Charles City County", false],
    ["Capitol", "Capitol Planning Region", false],
    ["Fairfax", "Loudoun", true],
  ])("county name %s vs %s (mismatch=%s)", async (facilityCounty, tigerName, mismatch) => {
    const q = fakeQuery({ county: feats({ GEOID: "51107", NAME: tigerName }) });
    const { joinKeys } = await computeJoinKeysFor(fac({ county: facilityCounty }), undefined, opts(q));
    expect(joinKeys.flags?.includes("county_name_mismatch") ?? false).toBe(mismatch);
  });
});

describe("carry-forward vs moved pins and egridMultiple retries", () => {
  const prev = {
    countyFips: "51107",
    egridSubregion: "SRVC",
    pin: { lat: 39.0438, lon: -77.4875, precision: "exact" },
    sources: {},
    computedAt: "2026-11-01",
  };
  it("moved pin + failing county keeps the old pin, flags it, and stays stale", async () => {
    const moved = fac({ lat: 39.5 });
    const { joinKeys } = await computeJoinKeysFor(moved, prev, opts(fakeQuery({ county: new Error("down") })));
    expect(joinKeys.countyFips).toBe("51107");
    expect(joinKeys.pin).toEqual(prev.pin);
    expect(joinKeys.flags).toContain("carried_forward:countyFips");
    expect(needsRecompute(moved, joinKeys)).toBe(true);
  });
  it("moved pin with all queries succeeding adopts the new pin", async () => {
    const moved = fac({ lat: 39.5 });
    const { joinKeys } = await computeJoinKeysFor(moved, prev, opts(fakeQuery()));
    expect(joinKeys.pin.lat).toBe(39.5);
    expect(joinKeys.flags).toBeUndefined();
    expect(needsRecompute(moved, joinKeys)).toBe(false);
  });
  it("moved pin with two failing keys and one success keeps the old pin, then adopts the new pin on retry", async () => {
    const moved = fac({ lat: 39.5 });
    const first = (
      await computeJoinKeysFor(
        moved,
        { ...prev, tractGeoid: "51107611005" },
        opts(fakeQuery({ county: new Error("down"), tract: new Error("down") })),
      )
    ).joinKeys;
    expect(first.pin).toEqual(prev.pin);
    expect(first.egridSubregion).toBe("SRVC");
    expect(first.flags).toEqual(expect.arrayContaining(["carried_forward:countyFips", "carried_forward:tractGeoid"]));
    expect(needsRecompute(moved, first)).toBe(true);
    const second = (await computeJoinKeysFor(moved, first, opts(fakeQuery()))).joinKeys;
    expect(second.pin.lat).toBe(39.5);
    expect(second.flags).toBeUndefined();
    expect(needsRecompute(moved, second)).toBe(false);
  });
  it("keeps county_name_mismatch when the county query fails", async () => {
    const flagged = { ...prev, flags: ["county_name_mismatch"] };
    const { joinKeys } = await computeJoinKeysFor(fac(), flagged, opts(fakeQuery({ county: new Error("down") })));
    expect(joinKeys.countyFips).toBe("51107");
    expect(joinKeys.flags).toEqual(["county_name_mismatch"]);
  });
  it("keeps tract_county_mismatch (once) when the tract query failed", async () => {
    const flagged = { ...prev, tractGeoid: "51153611005", flags: ["tract_county_mismatch"] };
    const { joinKeys } = await computeJoinKeysFor(fac(), flagged, opts(fakeQuery({ tract: new Error("down") })));
    expect(joinKeys.tractGeoid).toBe("51153611005");
    expect(joinKeys.flags?.filter((f: string) => f === "tract_county_mismatch")).toHaveLength(1);
  });
  it("drops a prior tract_county_mismatch when the tract succeeded and agrees with a carried county", async () => {
    const flagged = { ...prev, flags: ["tract_county_mismatch"] };
    const { joinKeys } = await computeJoinKeysFor(fac(), flagged, opts(fakeQuery({ county: new Error("down") })));
    expect(joinKeys.countyFips).toBe("51107");
    expect(joinKeys.tractGeoid).toBe("51107611005");
    expect(joinKeys.flags).toBeUndefined();
  });
  it("a stale egrid_multi_unknown flag is retried and a recompute with a locator clears it", async () => {
    const f = fac();
    const stale = { ...prev, tractGeoid: "51107611005", flags: ["egrid_multi_unknown"] };
    expect(needsRecompute(f, stale)).toBe(true);
    expect(needsRecompute(f, stale, { skipKeys: ["egrid"] })).toBe(false);
    const { joinKeys } = await computeJoinKeysFor(f, stale, opts(fakeQuery()));
    expect(joinKeys.flags).toBeUndefined();
    expect(needsRecompute(f, joinKeys)).toBe(false);
  });
  it("recomputing with egrid skipped keeps a previous egridMultiple true", async () => {
    const { joinKeys } = await computeJoinKeysFor(fac(), { ...prev, egridMultiple: true }, {
      query: fakeQuery(),
      skipKeys: ["egrid"],
    } as never);
    expect(joinKeys.egridMultiple).toBe(true);
  });
});

describe("needsRecompute", () => {
  const existing = {
    countyFips: "51107",
    tractGeoid: "51107611005",
    egridSubregion: "SRVC",
    pin: { lat: 39.0438, lon: -77.4875, precision: "exact" },
  };
  it("reuses an unchanged pin", () => expect(needsRecompute(fac(), existing)).toBe(false));
  it("ignores sub-6dp drift", () => expect(needsRecompute(fac({ lat: 39.04380000001 }), existing)).toBe(false));
  it("recomputes with no entry, a moved pin, or a precision change", () => {
    expect(needsRecompute(fac(), undefined)).toBe(true);
    expect(needsRecompute(fac({ lat: 39.05 }), existing)).toBe(true);
    expect(needsRecompute(fac({ precision: "approximate" }), existing)).toBe(true);
  });
  it("retries a key missing because its query failed, but not a confirmed absence", () => {
    const failed = { ...existing, countyFips: undefined };
    expect(needsRecompute(fac(), failed)).toBe(true);
    expect(needsRecompute(fac(), { ...failed, flags: ["county_no_polygon"] })).toBe(false);
  });
});

describe("computeAllJoinKeys", () => {
  it("reuses unchanged pins and queries only new ones", async () => {
    const q = fakeQuery();
    const a = fac({}, "a");
    const b = fac({ lat: 40 }, "b");
    const existing = { a: (await computeJoinKeysFor(a, undefined, opts(fakeQuery()))).joinKeys };
    const { byId, stats } = await computeAllJoinKeys([a, b], existing, opts(q));
    expect(stats).toMatchObject({ recomputed: 1, reused: 1, failures: 0 });
    expect(Object.keys(byId)).toEqual(["a", "b"]);
  });

  it("stops querying once the failure budget is exceeded and carries forward", async () => {
    const q = fakeQuery({ county: new Error("down"), tract: new Error("down") });
    const facs = Array.from({ length: 10 }, (_, i) => fac({ lat: 30 + i }, `f${i}`));
    const { stats } = await computeAllJoinKeys(facs, {}, { ...opts(q), maxFailures: 3 } as never);
    // 2 failures per facility: exceeded after the second facility, so the rest are skipped.
    expect(stats.recomputed).toBe(2);
    expect(stats.skipped).toBe(8);
    expect(q).toHaveBeenCalledTimes(4);
  });

  it("stops when the run exceeds maxRunMs", async () => {
    let t = 0;
    const q = fakeQuery();
    const facs = [fac({ lat: 31 }, "a"), fac({ lat: 32 }, "b")];
    const { stats } = await computeAllJoinKeys(facs, {}, {
      ...opts(q),
      maxRunMs: 10,
      now: () => (t += 20),
    } as never);
    expect(stats.recomputed).toBe(0);
    expect(stats.skipped).toBe(2);
  });
});

describe("preflightJoinKeys", () => {
  it("passes when every service answers as expected", async () => {
    expect(await preflightJoinKeys({ query: fakeQuery(), egridLocator: fakeLocator() })).toEqual({ ok: true, failed: [] });
  });
  it("names the failing service", async () => {
    expect(await preflightJoinKeys({ query: fakeQuery({ tract: new Error("down") }), egridLocator: fakeLocator() })).toEqual({
      ok: false,
      failed: ["tract"],
    });
  });
  it.each([
    ["no locator", undefined],
    ["a wrong code", fakeLocator({ subregions: ["XXXX"] })],
    ["two codes", fakeLocator({ subregions: ["SRVC", "SRSO"] })],
    ["no code", fakeLocator({ subregions: [] })],
    ["a throwing locator", () => { throw new Error("boom"); }],
  ])("fails egrid with %s", async (_name, egridLocator) => {
    expect(await preflightJoinKeys({ query: fakeQuery(), egridLocator } as never)).toEqual({ ok: false, failed: ["egrid"] });
  });
  it("makes no eGRID network query", async () => {
    const q = fakeQuery();
    await preflightJoinKeys({ query: q, egridLocator: fakeLocator() });
    expect(q).toHaveBeenCalledTimes(2);
    expect(q.mock.calls.some(([u]) => u.startsWith(EGRID_URL) || u.startsWith(EGRID_MULTI_URL))).toBe(false);
  });
});

describe("buildEgridLocator", () => {
  const outer = sq(0, 0, 10, 10);
  const hole = sq(4, 4, 6, 6);
  const multi = [multiFeature()];
  const locate = (features: unknown[], m: unknown[] = multi) => buildEgridLocator(features as never, m as never);

  it("(a) a Polygon hole is not a hit; the surrounding band is", () => {
    const l = locate([feature({ type: "Polygon", coordinates: [outer, hole] })]);
    expect(l(5, 5).subregions).toEqual([]);
    expect(l(2, 2).subregions).toEqual(["AAAA"]);
  });

  it("(b) REGRESSION: a hole emitted as a separate MultiPolygon part is not a hit", () => {
    const l = locate([feature({ type: "MultiPolygon", coordinates: [[outer], [hole]] })]);
    expect(l(5, 5).subregions).toEqual([]);
    expect(l(2, 2).subregions).toEqual(["AAAA"]);
  });

  it("(c) overlapping features report both subregions, deduped, in feature order", () => {
    const l = locate([
      feature({ type: "Polygon", coordinates: [outer] }, { Subregion: "AAAA" }),
      feature({ type: "Polygon", coordinates: [sq(5, 5, 15, 15)] }, { Subregion: "BBBB" }),
      feature({ type: "Polygon", coordinates: [sq(5, 5, 9, 9)] }, { Subregion: "BBBB" }),
    ]);
    expect(l(7, 7).subregions).toEqual(["AAAA", "BBBB"]);
    expect(l(2, 2).subregions).toEqual(["AAAA"]);
  });

  it("(d) a point outside every feature has no subregion", () => {
    const l = locate([feature({ type: "Polygon", coordinates: [outer] })]);
    expect(l(50, 50).subregions).toEqual([]);
  });

  it("(e) antimeridian: parts pre-split at +-180 hit on both sides, not elsewhere", () => {
    const l = locate([
      feature({ type: "MultiPolygon", coordinates: [[sq(172, 51, 180, 53)], [sq(-180, 51, -170, 53)]] }, { Subregion: "AKMS" }),
    ]);
    expect(l(179.5, 52).subregions).toEqual(["AKMS"]);
    expect(l(-179.5, 52).subregions).toEqual(["AKMS"]);
    expect(l(-100, 52).subregions).toEqual([]);
    expect(l(0, 52).subregions).toEqual([]);
  });

  it("(f) the multiple-subregions layer sets inMultiple", () => {
    const l = locate([feature({ type: "Polygon", coordinates: [outer] })]);
    expect(l(105, 5).inMultiple).toBe(true);
    expect(l(5, 5).inMultiple).toBe(false);
  });

  it("(h) a point exactly on a ring's minX edge follows parity, not the bbox", () => {
    const l = locate([feature({ type: "Polygon", coordinates: [sq(0, 0, 1, 1)] })]);
    expect(l(0, 0.5).subregions).toEqual(["AAAA"]);
    expect(l(1, 0.5).subregions).toEqual([]);
  });

  it("(i) overlapping outer parts of one feature read as outside (documents the parity assumption)", () => {
    const l = locate([feature({ type: "MultiPolygon", coordinates: [[sq(0, 0, 6, 6)], [sq(4, 4, 10, 10)]] })]);
    expect(l(2, 2).subregions).toEqual(["AAAA"]);
    expect(l(8, 8).subregions).toEqual(["AAAA"]);
    expect(l(5, 5).subregions).toEqual([]);
  });

  it("(g) rejects empty inputs, a missing Subregion and non-polygon geometry", () => {
    const good = feature({ type: "Polygon", coordinates: [outer] });
    expect(() => locate([])).toThrow(/empty/);
    expect(() => locate([good], [])).toThrow(/empty/);
    expect(() => locate([feature({ type: "Polygon", coordinates: [outer] }, {})])).toThrow(/Subregion/);
    expect(() => locate([feature({ type: "Polygon", coordinates: [outer] }, { Subregion: "" })])).toThrow(/Subregion/);
    expect(() => locate([feature({ type: "Point", coordinates: [0, 0] })])).toThrow(/Polygon/);
    expect(() => locate([good], [feature({ type: "LineString", coordinates: [] })])).toThrow(/Polygon/);
    expect(() => locate([{ type: "Feature", properties: { Subregion: "A" }, geometry: null }])).toThrow(/Polygon/);
  });
});

describe("joinKeys schema", () => {
  const full = {
    countyFips: "51107",
    tractGeoid: "51107611005",
    egridSubregion: "SRVC",
    egridMultiple: true,
    pin: { lat: 39.0438, lon: -77.4875, precision: "exact" },
    flags: ["county_name_mismatch"],
    sources: { county: "Census TIGERweb", tract: "Census TIGERweb", egrid: "EPA eGRID2023 (geographic approximation)" },
    computedAt: "2026-11-13",
  };
  it("accepts a full object", () => {
    expect(sitingContextSchema.safeParse({ joinKeys: full }).success).toBe(true);
  });
  it("rejects a 4-digit countyFips", () => {
    expect(sitingContextSchema.safeParse({ joinKeys: { ...full, countyFips: "1107" } }).success).toBe(false);
  });
  it("rejects a 10-digit tract", () => {
    expect(sitingContextSchema.safeParse({ joinKeys: { ...full, tractGeoid: "5110761100" } }).success).toBe(false);
  });
});

describe("required query", () => {
  it("throws when query is missing", async () => {
    await expect(computeJoinKeysFor(fac(), undefined, {} as never)).rejects.toThrow(/query/);
    await expect(computeAllJoinKeys([fac()], {}, {} as never)).rejects.toThrow(/query/);
    await expect(preflightJoinKeys({} as never)).rejects.toThrow(/query/);
  });
});

describe("skipKeys", () => {
  const prev = {
    countyFips: "51107",
    tractGeoid: "51107611005",
    egridSubregion: "SRVC",
    egridMultiple: true,
    pin: { lat: 39.0438, lon: -77.4875, precision: "exact" },
    flags: ["tract_county_mismatch"],
    sources: {},
    computedAt: "2026-11-01",
  };
  it("skipping tract keeps the tract and flags, with no tract call and no failure", async () => {
    const q = fakeQuery();
    const { joinKeys, failures } = await computeJoinKeysFor(fac(), prev, { ...opts(q), skipKeys: new Set(["tract"]) } as never);
    expect(q.mock.calls.some(([u]) => u.startsWith(TRACT_URL))).toBe(false);
    expect(joinKeys.tractGeoid).toBe("51107611005");
    expect(joinKeys.flags).toEqual(["tract_county_mismatch"]);
    expect(failures).toEqual([]);
  });
  it("skipping egrid never consults the locator and keeps egridMultiple", async () => {
    const q = fakeQuery();
    const loc = fakeLocator({ subregions: ["ZZZZ"] });
    const { joinKeys } = await computeJoinKeysFor(fac(), prev, { ...opts(q, loc), skipKeys: ["egrid"] } as never);
    expect(loc).not.toHaveBeenCalled();
    expect(joinKeys.egridSubregion).toBe("SRVC");
    expect(joinKeys.egridMultiple).toBe(true);
  });
  it("rejects an unknown key name", async () => {
    await expect(computeJoinKeysFor(fac(), prev, { query: fakeQuery(), skipKeys: ["water"] } as never)).rejects.toThrow(/skipKey/);
  });
  it("skipped keys do not consume the failure budget or trigger a retry", async () => {
    // A key absent only because its group is skipped must not make needsRecompute true.
    const noTract = { ...prev, tractGeoid: undefined, flags: undefined };
    expect(needsRecompute(fac(), noTract)).toBe(true);
    expect(needsRecompute(fac(), noTract, { skipKeys: ["tract"] })).toBe(false);
    // Failures only come from the non-skipped group: skipping the three failing keys leaves nothing to fail.
    const q = fakeQuery({ county: new Error("d"), tract: new Error("d") });
    const facs = Array.from({ length: 5 }, (_, i) => fac({ lat: 30 + i }, `f${i}`));
    const { stats } = await computeAllJoinKeys(facs, {}, {
      query: q,
      delayMs: 0,
      maxFailures: 1,
      skipKeys: ["county", "tract", "egrid"],
    } as never);
    expect(stats).toMatchObject({ recomputed: 5, failures: 0, skipped: 0 });
    expect(q).not.toHaveBeenCalled();
  });
});
