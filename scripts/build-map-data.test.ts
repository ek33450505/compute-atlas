import { describe, it, expect, vi, afterEach } from "vitest";

import {
  fetchJSON,
  preflightNHD,
  preflightNHDQuorum,
  propGNISName,
  ISLAND_GRID_BBOX,
  nearestFromCandidates,
  resolveNearestWater,
  nearestWaterViaNHD,
  assessThroughput,
  nextThroughputWindow,
} from "./build-map-data.mjs";
import { point as turfPoint, lineString } from "@turf/helpers";

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  }));
}

describe("fetchJSON", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects on an ArcGIS error body returned with HTTP 200", async () => {
    // ArcGIS reports failures in the response BODY, not the status line — a
    // 200 with {"error":{...}} used to parse as a successful empty result.
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        error: { code: 400, message: "Unable to complete operation." },
      }),
    );
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).rejects.toThrow(
      /400.*Unable to complete operation\./,
    );
  });

  it("resolves with the body on an ordinary successful response (no false positive)", async () => {
    const body = { features: [{ id: 1 }] };
    vi.stubGlobal("fetch", mockFetchOnce(body));
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).resolves.toEqual(body);
  });

  it("does not throw when `error` is falsy or absent", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: null, features: [] }));
    await expect(
      fetchJSON("https://example.com/query", { retries: 0 }),
    ).resolves.toEqual({ error: null, features: [] });

    vi.stubGlobal("fetch", mockFetchOnce({ features: [] }));
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).resolves.toEqual({
      features: [],
    });
  });

  it("still rejects on a non-200 HTTP status (no regression)", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({}, 500));
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).rejects.toThrow(/500/);
  });
});

describe("propGNISName", () => {
  it("applies the editorial override for a renamed upstream waterbody", () => {
    expect(propGNISName({ GNIS_NAME: "Lake America" })).toBe("Lake Ontario");
  });

  it("trims before matching the override", () => {
    expect(propGNISName({ GNIS_NAME: "  Lake America  " })).toBe("Lake Ontario");
  });

  it("matches the override case-insensitively", () => {
    expect(propGNISName({ GNIS_NAME: "LAKE AMERICA" })).toBe("Lake Ontario");
  });

  it("passes a non-overridden name through untouched", () => {
    // Important: a broken override map that mangled every name would
    // otherwise still pass the two tests above.
    expect(propGNISName({ GNIS_NAME: "Lake Erie" })).toBe("Lake Erie");
  });

  it("applies the override via the lowercase-property fallback (NHD layers vary in casing)", () => {
    expect(propGNISName({ gnis_name: "Lake America" })).toBe("Lake Ontario");
  });

  it("still returns null for empty or missing names (override does not resurrect them)", () => {
    expect(propGNISName({ GNIS_NAME: "   " })).toBeNull();
    expect(propGNISName({})).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Island-grid reachability guard
// ---------------------------------------------------------------------------

/** A candidate in the shape buildCandidateIndex produces. */
function candidate(coords: [number, number][], voltageKv = 230) {
  const xs = coords.map((c) => c[0]);
  const ys = coords.map((c) => c[1]);
  return {
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    line: lineString(coords),
    extra: { voltageKv },
  };
}

// The real geometry these fixtures stand in for, read off public/data/power.geojson:
// St. Croix's nearest >=230 kV line is bounded by [-66.14, 18.00, -66.00, 18.05]
// — in Puerto Rico — and the PR records' line by [-66.46, 18.31, -66.14, 18.43].
const PR_LINE = candidate([
  [-66.46, 18.31],
  [-66.14, 18.43],
]);
const PR_SOUTH_LINE = candidate([
  [-66.14, 18.0],
  [-66.0, 18.05],
]);
const ST_CROIX = turfPoint([-64.75, 17.72]);
const SAN_JUAN = turfPoint([-66.1, 18.44]);
const WIDE_BBOX = [-180, -90, 180, 90];

describe("island-grid reachability guard", () => {
  it("suppresses a Puerto Rico line for a St. Croix facility", () => {
    // The defect verbatim: 230 kV "76 miles" away, measured across open ocean
    // to a grid St. Croix has no interconnection with.
    const unguarded = nearestFromCandidates(ST_CROIX, [PR_SOUTH_LINE], WIDE_BBOX, 250);
    expect(unguarded).not.toBeNull();
    expect(unguarded.dist).toBeGreaterThan(60);

    const guarded = nearestFromCandidates(
      ST_CROIX,
      [PR_SOUTH_LINE],
      WIDE_BBOX,
      250,
      ISLAND_GRID_BBOX.VI,
    );
    expect(guarded).toBeNull();
  });

  it("keeps a Puerto Rico line for a Puerto Rico facility", () => {
    // The guard must not be a blanket "islands get nothing" rule — PR's own
    // values (5.8 / 8.4 mi against the real data) are genuine and must survive.
    const guarded = nearestFromCandidates(
      SAN_JUAN,
      [PR_LINE],
      WIDE_BBOX,
      250,
      ISLAND_GRID_BBOX.PR,
    );
    expect(guarded).not.toBeNull();
    expect(guarded.voltageKv).toBe(230);
    expect(guarded.dist).toBeLessThan(25);
  });

  it("leaves mainland behaviour byte-identical when no region is given", () => {
    // Every mainland state passes regionBBox = null, so the guard must be a
    // pure no-op there. The mainland legitimately reaches 93.1 mi.
    const far = candidate([
      [-84.0, 46.4],
      [-83.9, 46.5],
    ]);
    const pt = turfPoint([-84.4, 46.35]);
    const withoutRegion = nearestFromCandidates(pt, [far], WIDE_BBOX, 250);
    const withNullRegion = nearestFromCandidates(pt, [far], WIDE_BBOX, 250, null);
    expect(withNullRegion).toEqual(withoutRegion);
    expect(withoutRegion).not.toBeNull();
  });

  it("excludes Alaska deliberately — the Railbelt is a real connected grid", () => {
    // Guarding AK would suppress the genuine 2.7 / 4.2 mi Anchorage values.
    expect(ISLAND_GRID_BBOX).not.toHaveProperty("AK");
  });

  it("covers every island jurisdiction the dataset can hold, and no others", () => {
    // A literal, not a re-derivation of the constant: renaming or dropping a
    // key has to fail here rather than silently widen the guard's scope.
    expect(Object.keys(ISLAND_GRID_BBOX).sort()).toEqual(["GU", "HI", "MP", "PR", "VI"]);
  });

  it("gives each island jurisdiction a box that actually contains it", () => {
    // The bounds are the kind of constant that silently encodes whatever
    // geography its author looked at — a prior bounds test in this repo
    // excluded both Guam and St. Croix. These are real coordinates in each.
    const inside: Record<string, [number, number]> = {
      PR: [-66.1, 18.44], // San Juan
      VI: [-64.75, 17.72], // St. Croix
      GU: [144.79, 13.47], // Hagatna
      MP: [145.75, 15.19], // Saipan
      HI: [-157.86, 21.31], // Honolulu
    };
    const boxes = ISLAND_GRID_BBOX as Record<string, number[]>;
    for (const [code, [lon, lat]] of Object.entries(inside)) {
      const [minX, minY, maxX, maxY] = boxes[code];
      expect(
        lon >= minX && lon <= maxX && lat >= minY && lat <= maxY,
        `${code} box must contain ${lon},${lat}`,
      ).toBe(true);
    }
  });

  it("keeps Puerto Rico and the Virgin Islands boxes disjoint", () => {
    // If these overlapped, a long PR line's bbox could still satisfy VI's
    // guard and the St. Croix defect would survive the fix.
    const [, , prMaxX] = ISLAND_GRID_BBOX.PR;
    const [viMinX] = ISLAND_GRID_BBOX.VI;
    expect(prMaxX).toBeLessThan(viMinX);
  });
});

// ---------------------------------------------------------------------------
// NHD pre-flight
// ---------------------------------------------------------------------------

/** Response spec per NHD layer id, keyed by the layer number in the URL. */
type LayerSpec = { status?: number; body?: unknown; networkError?: string };

function layerOf(url: string): string {
  return /MapServer\/(\d+)\/query/.exec(url)?.[1] ?? "?";
}

/** Stub fetch so each NHD layer can succeed or fail INDEPENDENTLY. */
function stubNHD(per: Record<string, LayerSpec>) {
  const fn = vi.fn(async (url: string) => {
    const spec = per[layerOf(url)];
    if (!spec) throw new Error(`test stub: unexpected NHD layer in ${url}`);
    if (spec.networkError) throw new Error(spec.networkError);
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => spec.body ?? { type: "FeatureCollection", features: [] },
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/**
 * Like stubNHD, but each layer gets a SEQUENCE of specs consumed one per call —
 * the only way to express "slow, then gone" across a re-probe. Running past the
 * end of a layer's sequence throws rather than repeating the last spec, so an
 * unexpected extra call is a test failure, not a silent pass.
 */
function stubNHDSequence(per: Record<string, LayerSpec[]>) {
  const calls: Record<string, number> = {};
  const fn = vi.fn(async (url: string) => {
    const layer = layerOf(url);
    const seq = per[layer];
    if (!seq) throw new Error(`test stub: unexpected NHD layer in ${url}`);
    const i = calls[layer] ?? 0;
    calls[layer] = i + 1;
    const spec = seq[i];
    if (!spec) throw new Error(`test stub: layer ${layer} called ${i + 1}x, only ${seq.length} spec(s) given`);
    if (spec.networkError) throw new Error(spec.networkError);
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => spec.body ?? { type: "FeatureCollection", features: [] },
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/**
 * Injectable clock: preflightNHD calls now() twice per ATTEMPT (start, end), so a
 * 4-element sequence controls both layers' measured latency. A latency-only
 * rejection re-probes that layer once, consuming two MORE readings — budget for
 * them or the sequence runs off its end (clock() then repeats its last value,
 * which reads as a 0ms attempt). Tests must never really sleep 8 seconds — a
 * test that does gets deleted.
 */
function clock(seq: number[]) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

// A fresh clock per call — `clock` is stateful, so sharing one instance across
// tests would leak its position and quietly zero the measured latencies.
const fast = () => clock([0, 120, 120, 240]);

describe("preflightNHD", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes when both layers answer a real query quickly", async () => {
    stubNHD({ "4": {}, "10": {} });
    const res = await preflightNHD({ now: fast() });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.layer)).toEqual([4, 10]);
    expect(res.results.every((r) => r.ok)).toBe(true);
  });

  it("probes a real QUERY on both layers, never the service root", async () => {
    // The root answered HTTP 200 in 307-441ms all through the 2026-09-23 outage
    // while every real query timed out or 502'd. Probing it is a false green.
    const fn = stubNHD({ "4": {}, "10": {} });
    await preflightNHD({ now: fast() });
    expect(fn).toHaveBeenCalledTimes(2);
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls.map(layerOf).sort()).toEqual(["10", "4"]);
    for (const url of urls) {
      expect(url).toContain("/query?");
      expect(url).toContain("f=geojson");
      expect(url).toContain("outFields=GNIS_NAME");
      expect(url).not.toMatch(/MapServer\?/);
    }
  });

  it("fails when layer 4 fails", async () => {
    stubNHD({ "4": { status: 502 }, "10": {} });
    const res = await preflightNHD({ now: fast() });
    expect(res.ok).toBe(false);
    const failed = res.results.filter((r) => !r.ok);
    expect(failed.map((r) => r.layer)).toEqual([4]);
    expect(failed[0].error).toMatch(/502/);
  });

  it("fails when layer 10 fails even though layer 4 succeeds", async () => {
    // The case that matters: on 2026-09-23 layer 10 (waterbodies) failed
    // INDEPENDENTLY of layer 4, so a one-layer probe proves nothing.
    stubNHD({ "4": {}, "10": { networkError: "fetch failed" } });
    const res = await preflightNHD({ now: fast() });
    expect(res.ok).toBe(false);
    expect(res.results.find((r) => r.layer === 4)?.ok).toBe(true);
    const failed = res.results.filter((r) => !r.ok);
    expect(failed.map((r) => r.layer)).toEqual([10]);
    expect(failed[0].error).toMatch(/fetch failed/);
  });

  it("fails a slow-but-200 response that exceeds the latency ceiling", async () => {
    // Both layers return a perfectly valid 200 body. The ONLY fault is latency
    // — the exact shape that let the 6h run keep grinding instead of aborting.
    // Layer 4 is slow TWICE (9000ms, then 9000ms again on the re-probe) because
    // a single slow sample only earns a retry, not a verdict.
    stubNHD({ "4": {}, "10": {} });
    const res = await preflightNHD({ now: clock([0, 9000, 9000, 18_000, 18_000, 18_120]) });
    expect(res.ok).toBe(false);
    const slow = res.results.find((r) => r.layer === 4);
    expect(slow?.ok).toBe(false);
    expect(slow?.ms).toBe(9000);
    expect(slow?.error).toMatch(/ceiling/);
    // The fast layer is unaffected — this is a per-layer verdict, not a blanket
    // "the whole probe took too long".
    expect(res.results.find((r) => r.layer === 10)?.ok).toBe(true);
  });

  it("records the measured latency so the abort message can state it", async () => {
    stubNHD({ "4": {}, "10": {} });
    const res = await preflightNHD({ now: clock([0, 120, 120, 240]) });
    expect(res.results.map((r) => r.ms)).toEqual([120, 120]);
  });

  it("fails a 200 whose body carries no feature array", async () => {
    stubNHD({ "4": { body: { type: "FeatureCollection" } }, "10": {} });
    const res = await preflightNHD({ now: fast() });
    expect(res.ok).toBe(false);
    expect(res.results.find((r) => r.layer === 4)?.error).toMatch(/features/);
  });

  it("returns a result instead of throwing, so the caller owns the policy", async () => {
    stubNHD({ "4": { networkError: "ECONNRESET" }, "10": { networkError: "ECONNRESET" } });
    await expect(preflightNHD({ now: fast() })).resolves.toMatchObject({ ok: false });
  });

  it("re-probes ONCE on a latency-only rejection and takes the faster sample", async () => {
    // A cold ArcGIS connection pool can make the FIRST query take seconds. With
    // retries: 0 and an 8s ceiling that is a plausible false abort — the
    // pre-flight blocking a healthy build, a failure mode this check would have
    // introduced itself. Layer 4: 9000ms, then 300ms on the re-probe.
    const fn = stubNHD({ "4": {}, "10": {} });
    const res = await preflightNHD({
      now: clock([0, 9000, 9000, 9300, 9300, 9420]),
    });
    expect(res.ok).toBe(true);
    const four = res.results.find((r) => r.layer === 4);
    expect(four?.ok).toBe(true);
    // The FASTER sample is what gets recorded — the log must not claim we
    // measured 9000ms and passed anyway.
    expect(four?.ms).toBe(300);
    expect(four?.error).toBeNull();
    // Exactly one extra call, for layer 4 only.
    expect(fn.mock.calls.map((c) => layerOf(String(c[0])))).toEqual(["4", "4", "10"]);
  });

  it("fails when BOTH samples are over the ceiling, and says so in the message", async () => {
    // Layer 4: 9000ms then 8500ms. Still degraded; the verdict stands.
    stubNHD({ "4": {}, "10": {} });
    const res = await preflightNHD({
      now: clock([0, 9000, 9000, 17_500, 17_500, 17_620]),
    });
    expect(res.ok).toBe(false);
    const four = res.results.find((r) => r.layer === 4);
    expect(four?.ok).toBe(false);
    expect(four?.ms).toBe(8500);
    expect(four?.error).toMatch(/ceiling/);
    // The message must state WHICH sample it is reporting, or the log is
    // misleading about what was actually measured.
    expect(four?.error).toMatch(/faster of 2 attempts/);
    expect(four?.error).toContain("9000ms");
    expect(res.results.find((r) => r.layer === 10)?.ok).toBe(true);
  });

  it("does NOT re-probe a hard failure — a 502 is answered in one call", async () => {
    // This is the assertion that pins "only LATENCY-only failures retry". A
    // service that is down must still fail in seconds; retrying it restores the
    // patience this check exists to remove.
    const fn = stubNHD({ "4": { status: 502 }, "10": {} });
    const res = await preflightNHD({ now: fast() });
    expect(res.ok).toBe(false);
    const layer4Calls = fn.mock.calls.filter((c) => layerOf(String(c[0])) === "4");
    expect(layer4Calls).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-probe a 200 that carries no feature array", async () => {
    // Same rule, the other hard-failure shape: the response is not an answer,
    // so a second identical non-answer buys nothing.
    const fn = stubNHD({ "4": { body: { type: "FeatureCollection" } }, "10": {} });
    const res = await preflightNHD({ now: fast() });
    expect(res.ok).toBe(false);
    const layer4Calls = fn.mock.calls.filter((c) => layerOf(String(c[0])) === "4");
    expect(layer4Calls).toHaveLength(1);
    expect(res.results.find((r) => r.layer === 4)?.error).toMatch(/features/);
  });

  it("reports the hard failure when a re-probe after a slow first attempt dies", async () => {
    // Slow, then gone. The verdict must name the ACTUAL fault (the failure),
    // not a latency ceiling the second attempt never reached.
    stubNHDSequence({ "4": [{}, { networkError: "fetch failed" }], "10": [{}] });
    const res = await preflightNHD({ now: clock([0, 9000, 9000, 9120, 9120, 9240]) });
    expect(res.ok).toBe(false);
    const four = res.results.find((r) => r.layer === 4);
    expect(four?.ok).toBe(false);
    expect(four?.error).toMatch(/fetch failed/);
    expect(four?.error).toMatch(/9000ms/); // the slow first attempt is still stated
    expect(four?.error).not.toMatch(/ceiling/);
  });
});

// ---------------------------------------------------------------------------
// nearestWaterViaNHD ring escalation
// ---------------------------------------------------------------------------

/** A minimal NAMED flowline close enough to the query point that pointToLineDistance succeeds. */
function namedFlowlineAt(lat: number, lon: number) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { GNIS_NAME: "Test Creek" },
        geometry: {
          type: "LineString",
          coordinates: [
            [lon - 0.01, lat],
            [lon + 0.01, lat],
          ],
        },
      },
    ],
  };
}

describe("nearestWaterViaNHD ring escalation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SILENT DATA LOSS regression: a terminating-ring failure after clean earlier rings must NOT read as confirmed absence", async () => {
    // Rings 0-2 answer cleanly with zero features; ring 3 — the ring the loop
    // CONCLUDES on — times out on BOTH layers. A failed query returns
    // features:[], byte-identical to a successful-empty one, which is exactly
    // what let this clear a good prior value on 2026-09-22. This test MUST
    // fail against the pre-correction code (no `absenceConfirmed` field at
    // all, so `toBe(false)` below fails against `undefined`).
    stubNHDSequence({
      "4": [{}, {}, {}, { networkError: "timeout" }, { networkError: "timeout" }],
      "10": [{}, {}, {}, { networkError: "timeout" }, { networkError: "timeout" }],
    });
    const res = await nearestWaterViaNHD(40, -75);
    expect(res.nearest).toBeNull();
    expect(res.allFailed).toBe(false); // some ring DID answer — this is the trap allFailed missed
    expect(res.absenceConfirmed).toBe(false); // must NOT be read as confirmed absence
  });

  it("an early-ring failure does not block a legitimate confirmed absence at a later ring", async () => {
    // Ring 0 fails both layers; rings 1-3 answer cleanly with zero features.
    // The rings are strict spatial supersets, so the clean wider answer
    // subsumes the narrower failed one — this must still confirm absence.
    stubNHDSequence({
      "4": [{ networkError: "timeout" }, { networkError: "timeout" }, {}, {}, {}],
      "10": [{ networkError: "timeout" }, { networkError: "timeout" }, {}, {}, {}],
    });
    const res = await nearestWaterViaNHD(40, -75);
    expect(res.nearest).toBeNull();
    expect(res.allFailed).toBe(false);
    expect(res.absenceConfirmed).toBe(true);
  });

  it("the terminating ring's waterbody layer failing alone still blocks confirmed absence (lakes were never checked)", async () => {
    // Flowlines answer clean-empty at every ring; waterbodies fail at every
    // ring. By the terminating ring, flow says "no rivers" but water never
    // answered, so absence cannot be confirmed even though a layer did.
    stubNHDSequence({
      "4": [{}, {}, {}, {}],
      "10": [
        { networkError: "timeout" }, { networkError: "timeout" },
        { networkError: "timeout" }, { networkError: "timeout" },
        { networkError: "timeout" }, { networkError: "timeout" },
        { networkError: "timeout" }, { networkError: "timeout" },
      ],
    });
    const res = await nearestWaterViaNHD(40, -75);
    expect(res.nearest).toBeNull();
    expect(res.allFailed).toBe(false); // flow answered every ring
    expect(res.absenceConfirmed).toBe(false);
  });

  it("every query at every ring failing yields allFailed AND an unconfirmed absence", async () => {
    const bothFail = Array(8).fill({ networkError: "timeout" });
    stubNHDSequence({ "4": bothFail, "10": bothFail });
    const res = await nearestWaterViaNHD(40, -75);
    expect(res.nearest).toBeNull();
    expect(res.allFailed).toBe(true);
    expect(res.absenceConfirmed).toBe(false);
  });

  it("finds a feature at ring 0 and stops — wider rings are never queried", async () => {
    const fn = stubNHD({
      "4": { body: namedFlowlineAt(40, -75) },
      "10": {},
    });
    const res = await nearestWaterViaNHD(40, -75);
    expect(res.nearest).not.toBeNull();
    expect(res.nearest?.name).toBe("Test Creek");
    expect(res.nearest?.kind).toBe("river");
    expect(res.absenceConfirmed).toBe(true);
    // Exactly one call per layer — rings 1-3 were never reached.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("resolveNearestWater", () => {
  it("returns the fresh value with carriedForward: false when the lookup finds a feature", () => {
    const waterOutcome = { nearest: { name: "Big Creek", kind: "river", dist: 3.14159 }, allFailed: false, absenceConfirmed: true };
    const res = resolveNearestWater(waterOutcome, undefined);
    expect(res).toEqual({
      value: { name: "Big Creek", kind: "river", distanceMi: 3.1 },
      carriedForward: false,
    });
  });

  it("CLEARS a stale nearestWater when the lookup answers and finds nothing (absenceConfirmed: true)", () => {
    // absenceConfirmed: true means NHD genuinely answered at this coordinate
    // at the terminating ring. A corrected coordinate must be able to clear a
    // stale value, so this must NOT carry forward even though an existing
    // entry is present.
    const waterOutcome = { nearest: null, allFailed: false, absenceConfirmed: true };
    const existingEntry = { nearestWater: { name: "Old River", kind: "river", distanceMi: 5.2 } };
    const res = resolveNearestWater(waterOutcome, existingEntry);
    expect(res).toEqual({ value: undefined, carriedForward: false });
  });

  it("carries forward the prior nearestWater verbatim when absence is not confirmed, even though allFailed is false", () => {
    // This is the exact regression shape: NOT every ring failed (allFailed:
    // false), but the TERMINATING ring did, so absence was never confirmed.
    // The old `allFailed === true` gate would have cleared this; the fix
    // must not.
    const waterOutcome = { nearest: null, allFailed: false, absenceConfirmed: false };
    const existingEntry = { nearestWater: { name: "Old River", kind: "river", distanceMi: 5.2 } };
    const res = resolveNearestWater(waterOutcome, existingEntry);
    expect(res.carriedForward).toBe(true);
    expect(res.value).toEqual(existingEntry.nearestWater);
  });

  it("fails OPEN to preservation when absenceConfirmed is missing entirely, even though allFailed is false", () => {
    // A malformed or out-of-date waterOutcome (no absenceConfirmed key at
    // all) must not be misread as confirmed absence — `!== true` must catch
    // `undefined`, matching this module's preserve-by-default bias.
    const waterOutcome = { nearest: null, allFailed: false };
    const existingEntry = { nearestWater: { name: "Old River", kind: "river", distanceMi: 5.2 } };
    const res = resolveNearestWater(waterOutcome, existingEntry);
    expect(res.carriedForward).toBe(true);
    expect(res.value).toEqual(existingEntry.nearestWater);
  });

  it("does not invent a value when absence is not confirmed and there is no existing entry", () => {
    const waterOutcome = { nearest: null, allFailed: true, absenceConfirmed: false };
    const res = resolveNearestWater(waterOutcome, undefined);
    expect(res).toEqual({ value: undefined, carriedForward: false });
  });

  it("returns undefined when the existing entry has nearestTransmission but no nearestWater", () => {
    const waterOutcome = { nearest: null, allFailed: true, absenceConfirmed: false };
    const existingEntry = { nearestTransmission: { voltageKv: 230, distanceMi: 12.4 } };
    const res = resolveNearestWater(waterOutcome, existingEntry);
    expect(res).toEqual({ value: undefined, carriedForward: false });
  });

  it("is safe when existingEntry is undefined or null", () => {
    const waterOutcome = { nearest: null, allFailed: true, absenceConfirmed: false };
    expect(resolveNearestWater(waterOutcome, undefined)).toEqual({ value: undefined, carriedForward: false });
    expect(resolveNearestWater(waterOutcome, null)).toEqual({ value: undefined, carriedForward: false });
  });
});

// ---------------------------------------------------------------------------
// preflightNHDQuorum — multi-coordinate quorum wrapper around preflightNHD
// ---------------------------------------------------------------------------

describe("preflightNHDQuorum", () => {
  const testCoords = [
    { label: "A", lat: 1, lon: 1 },
    { label: "B", lat: 2, lon: 2 },
    { label: "C", lat: 3, lon: 3 },
  ];

  const okOutcome = { ok: true, results: [{ layer: 4, ok: true, ms: 100, error: null }] };
  const failOutcome = (ms = 9000, error = "responded too slowly (ceiling)") => ({
    ok: false,
    results: [
      { layer: 4, ok: false, ms, error },
      { layer: 10, ok: true, ms: 150, error: null },
    ],
  });

  it("passes when every coordinate passes, probing each exactly once", async () => {
    const probe = vi.fn(async () => okOutcome);
    const res = await preflightNHDQuorum({ coords: testCoords, probe });
    expect(res.ok).toBe(true);
    expect(res.failedAt).toBeNull();
    expect(probe).toHaveBeenCalledTimes(testCoords.length);
    expect(res.results.map((c) => c.label)).toEqual(["A", "B", "C"]);
  });

  it("fails fast on the FIRST coordinate — the probe is called exactly once", async () => {
    const probe = vi.fn(async () => failOutcome());
    const res = await preflightNHDQuorum({ coords: testCoords, probe });
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe("A");
    // Pins fail-fast as REAL, not incidental: a probe that (wrongly) kept
    // going after the first failure would have called this 2 or 3 times.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("fails on a MIDDLE coordinate and never probes the ones after it", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(okOutcome)
      .mockResolvedValueOnce(failOutcome())
      .mockResolvedValueOnce(okOutcome); // must never be consumed — coordinate C is never reached
    const res = await preflightNHDQuorum({ coords: testCoords, probe });
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe("B");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(res.results.map((c) => c.label)).toEqual(["A", "B"]);
  });

  it("carries the failing coordinate's per-layer latency/error for the abort message", async () => {
    const probe = vi.fn(async () => failOutcome(9000, "responded in 9000ms, over the 8000ms ceiling"));
    const res = await preflightNHDQuorum({ coords: testCoords, probe });
    const failedEntry = res.results.find((c) => c.label === res.failedAt);
    expect(failedEntry?.results).toEqual([
      { layer: 4, ok: false, ms: 9000, error: "responded in 9000ms, over the 8000ms ceiling" },
      { layer: 10, ok: true, ms: 150, error: null },
    ]);
  });

  it("ships a default coordinate list with >=5 geographically distinct entries", async () => {
    // No `coords` override — exercises the TRUE default NHD_PREFLIGHT_COORDS,
    // proving `coords` is genuinely optional. `probe` is still stubbed so
    // this never touches the network.
    const probe = vi.fn(async () => okOutcome);
    const res = await preflightNHDQuorum({ probe });
    expect(res.ok).toBe(true);
    expect(res.results.length).toBeGreaterThanOrEqual(5);
    const lats = res.results.map((c) => c.lat);
    const lons = res.results.map((c) => c.lon);
    // No two coordinates may share a lat OR a lon — a copy-paste duplicate
    // must not silently reduce the geographic spread this guard depends on.
    expect(new Set(lats).size).toBe(lats.length);
    expect(new Set(lons).size).toBe(lons.length);
    // No two coordinates may share a label either — main() resolves the
    // failing coordinate via `.find((c) => c.label === preflight.failedAt)`,
    // so a duplicate label would make it name (and report the latency of)
    // the WRONG coordinate at exactly the moment someone is debugging an
    // outage, turning a diagnostic into a lie.
    const labels = res.results.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// assessThroughput — pure mid-run throughput/decay guard
// ---------------------------------------------------------------------------

describe("assessThroughput", () => {
  it("passes when the measured rate keeps the run comfortably inside the budget", () => {
    // 50 facilities in 60,000ms = 0.833/sec — the healthy START of the
    // 2026-09-23 run, before it collapsed.
    const res = assessThroughput({
      processed: 500,
      total: 1000,
      windowElapsedMs: 60_000,
      windowSize: 50,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(res.ok).toBe(true);
    expect(res.ratePerSec).toBeCloseTo(0.8333, 3);
  });

  it("aborts when the rolling window's rate projects past maxProjectedHours", () => {
    // ROLLING-window numbers: the last 50 facilities took 5,000,000ms, i.e. a
    // measured 0.01 facilities/sec over THAT recent window only.
    const res = assessThroughput({
      processed: 500,
      total: 1000,
      windowElapsedMs: 5_000_000,
      windowSize: 50,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(res.ok).toBe(false);
    // Hand-computed, NOT re-derived with the implementation's own expression
    // (that would be tautological): 500 facilities remain; at 0.01/sec that
    // is 50,000 seconds = 13 hours 53 minutes 20 seconds
    // = 13 + 53/60 + 20/3600 ~= 13.8889 hours.
    expect(res.projectedHours).toBeCloseTo(13.8889, 3);

    // DISCRIMINATES rolling from cumulative-average — the exact property Part
    // B exists to pin. If the SAME 500-processed point were instead measured
    // CUMULATIVELY since the run's start (500 facilities in 1,000,000ms
    // total — plausible if the first ~450 were fast and only a recent window
    // collapsed), the blended rate looks like a healthy 0.5/sec and the run
    // reads as fine. That is the exact false negative a cumulative-average
    // guard produces, and why computeSitingContext's wiring MUST feed this
    // function a per-window (rolling) elapsed time, never a since-start
    // cumulative one. These two calls give DIFFERENT verdicts on purpose.
    const cumulativeStyle = assessThroughput({
      processed: 500,
      total: 1000,
      windowElapsedMs: 1_000_000,
      windowSize: 500,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(cumulativeStyle.ok).toBe(true);
  });

  it("does not judge before the warm-up grace period, even at a catastrophic rate", () => {
    const res = assessThroughput({
      processed: 10,
      total: 1000,
      windowElapsedMs: 10_000_000, // would be catastrophic if judged
      windowSize: 5,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(res.ok).toBe(true);
  });

  it("does not abort on a bad (zero) elapsed-time measurement", () => {
    const res = assessThroughput({
      processed: 500,
      total: 1000,
      windowElapsedMs: 0,
      windowSize: 50,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(res.ok).toBe(true);
  });

  it("treats a stalled window (time elapsed, zero facilities progressed) as a hard abort, not Infinity/NaN weirdness", () => {
    const res = assessThroughput({
      processed: 500,
      total: 1000,
      windowElapsedMs: 60_000, // a full minute elapsed...
      windowSize: 0,           // ...but the window made no progress at all
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(res.ok).toBe(false);
    expect(res.ratePerSec).toBe(0);
    expect(res.projectedHours).toBe(Infinity);
  });

  it("REGRESSION 2026-09-23: 2,228 facilities, ~1,900 processed, 0.006/sec window rate — the old consecutive-failure guard never moved", () => {
    // Real incident numbers. NHD_CONSECUTIVE_FAILURE_BUDGET counts FAILED
    // lookups and resets to 0 on any success; every one of these queries
    // eventually answered, so that guard's counter stayed at 0 throughout —
    // the decay was invisible to it BY CONSTRUCTION. This guard catches it
    // because it measures RATE, not failure count.
    const res = assessThroughput({
      processed: 1900,
      total: 2228,
      windowElapsedMs: 10_000_000, // 60 facilities in 10,000s = 0.006/sec
      windowSize: 60,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(res.ratePerSec).toBeCloseTo(0.006, 5);
    expect(res.ok).toBe(false);
    // Hand-computed: 328 facilities remain; at 0.006/sec that is 54,666.67
    // seconds = 15 hours 11 minutes 6.67 seconds ~= 15.1852 hours.
    expect(res.projectedHours).toBeCloseTo(15.1852, 3);

    // Same discrimination as the previous test, grounded in THIS incident's
    // own reported shape (throughput decaying 0.83 -> 0.167 -> 0.006/sec): a
    // CUMULATIVE average across all 1,900 processed facilities (1,900 in
    // 3,800,000ms = a blended 0.5/sec, plausible given the fast early portion
    // of the run) reads as comfortably healthy and would NOT have aborted —
    // only the rolling, recent-window measurement catches the collapse.
    const cumulativeStyle = assessThroughput({
      processed: 1900,
      total: 2228,
      windowElapsedMs: 3_800_000,
      windowSize: 1900,
      graceFacilities: 100,
      maxProjectedHours: 5,
    });
    expect(cumulativeStyle.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nextThroughputWindow — pure window-boundary/reset bookkeeping that feeds
// assessThroughput above. Extracted from computeSitingContext because a
// mutation removing the `windowStartedAt = now()` reset (making the window
// cumulative-from-start instead of rolling) previously survived ALL tests:
// nothing asserted the reset itself, only assessThroughput's math given
// pre-computed inputs. This block pins the reset directly.
// ---------------------------------------------------------------------------

describe("nextThroughputWindow", () => {
  it("is not a boundary when processed is not a multiple of windowSize, and returns windowStartedAt unchanged", () => {
    const res = nextThroughputWindow({
      processed: 37,
      windowSize: 50,
      windowStartedAt: 1_000,
      nowMs: 90_000,
    });
    expect(res.isBoundary).toBe(false);
    expect(res.windowStartedAt).toBe(1_000);
    expect(res.windowElapsedMs).toBeNull();
  });

  it("ROLLING not cumulative: at a boundary, windowStartedAt resets to nowMs, NOT the incoming value — a cumulative window makes the measured rate decay on a perfectly healthy run", () => {
    const incomingStart = 1_000;
    const nowMs = 61_000;
    const res = nextThroughputWindow({
      processed: 50,
      windowSize: 50,
      windowStartedAt: incomingStart,
      nowMs,
    });
    expect(res.isBoundary).toBe(true);
    // Both halves, asserted explicitly with distinct values so neither can
    // pass by accident: the reset value IS nowMs, and is NOT the incoming one.
    expect(res.windowStartedAt).toBe(nowMs);
    expect(res.windowStartedAt).not.toBe(incomingStart);
  });

  it("consecutive boundaries measure only their OWN window's elapsed time, never a running total", () => {
    const windowSize = 50;
    let windowStartedAt = 0;

    // Window 1: 1,000ms elapsed.
    let res = nextThroughputWindow({ processed: 50, windowSize, windowStartedAt, nowMs: 1_000 });
    expect(res.isBoundary).toBe(true);
    expect(res.windowElapsedMs).toBe(1_000);
    windowStartedAt = res.windowStartedAt;

    // Window 2: 5,000ms elapsed. A cumulative (buggy) implementation would
    // read 1,000 + 5,000 = 6,000 here because it never reset windowStartedAt.
    res = nextThroughputWindow({ processed: 100, windowSize, windowStartedAt, nowMs: 1_000 + 5_000 });
    expect(res.isBoundary).toBe(true);
    expect(res.windowElapsedMs).toBe(5_000);
    windowStartedAt = res.windowStartedAt;

    // Window 3: 20,000ms elapsed. A cumulative implementation would read
    // 1,000 + 5,000 + 20,000 = 26,000 here.
    res = nextThroughputWindow({ processed: 150, windowSize, windowStartedAt, nowMs: 1_000 + 5_000 + 20_000 });
    expect(res.isBoundary).toBe(true);
    expect(res.windowElapsedMs).toBe(20_000);
  });

  it("processed: 0 is never a boundary (0 is a multiple of everything; the run must not judge before any work)", () => {
    const res = nextThroughputWindow({
      processed: 0,
      windowSize: 50,
      windowStartedAt: 5_000,
      nowMs: 5_000,
    });
    expect(res.isBoundary).toBe(false);
    expect(res.windowStartedAt).toBe(5_000);
  });

  it("windowSize <= 0 can never divide/modulo by zero: always inert, never a boundary, windowStartedAt unchanged", () => {
    const zero = nextThroughputWindow({
      processed: 50,
      windowSize: 0,
      windowStartedAt: 5_000,
      nowMs: 999_000,
    });
    expect(zero.isBoundary).toBe(false);
    expect(zero.windowElapsedMs).toBeNull();
    expect(zero.windowStartedAt).toBe(5_000);

    const negative = nextThroughputWindow({
      processed: 50,
      windowSize: -10,
      windowStartedAt: 5_000,
      nowMs: 999_000,
    });
    expect(negative.isBoundary).toBe(false);
    expect(negative.windowStartedAt).toBe(5_000);
  });
});
