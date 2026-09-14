import { describe, it, expect, vi, afterEach } from "vitest";

import {
  fetchJSON,
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
