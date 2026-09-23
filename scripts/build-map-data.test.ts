import { describe, it, expect, vi, afterEach } from "vitest";

import {
  fetchJSON,
  preflightNHD,
  propGNISName,
  ISLAND_GRID_BBOX,
  nearestFromCandidates,
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
