import { describe, it, expect } from "vitest";
import { clusterFacilities, lonToX, latToY } from "@/lib/cluster";
import { getAllFacilities } from "@/lib/data";
import { INITIAL_VIEW_STATE } from "@/lib/map";
import type { Facility } from "@/lib/schema";

// --- Shared fixtures ---

const SOURCE = {
  url: "https://example.com",
  label: "Example",
  retrievedAt: "2024-01",
  kind: "press" as const,
};

function makeFacility(id: string, lat: number, lon: number): Facility {
  return {
    id,
    name: id,
    operator: "Test",
    status: "operational",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat, lon, state: "TX" },
    statusHistory: [],
    sources: [SOURCE],
    lastUpdated: "2024-01",
  };
}

// --- lonToX / latToY sanity checks ---

describe("lonToX", () => {
  it("returns 0 for longitude -180 at any zoom", () => {
    expect(lonToX(-180, 3)).toBeCloseTo(0, 0);
  });

  it("returns the tile width * 2^zoom for longitude 180", () => {
    const zoom = 3;
    expect(lonToX(180, zoom)).toBeCloseTo(256 * 2 ** zoom, 0);
  });

  it("returns half the world width for longitude 0", () => {
    const zoom = 4;
    expect(lonToX(0, zoom)).toBeCloseTo((256 * 2 ** zoom) / 2, 0);
  });
});

describe("latToY", () => {
  it("returns a finite positive value for typical US latitudes", () => {
    const y = latToY(39.5, 3.4);
    expect(isFinite(y)).toBe(true);
    expect(y).toBeGreaterThan(0);
  });

  it("is monotonically decreasing (higher lat → smaller y in Mercator)", () => {
    const zoom = 4;
    expect(latToY(50, zoom)).toBeLessThan(latToY(30, zoom));
  });
});

// --- clusterFacilities ---

describe("clusterFacilities", () => {
  it("returns two singleton clusters for two well-separated facilities at high zoom", () => {
    // At zoom 10, Los Angeles and New York are thousands of pixels apart.
    const la = makeFacility("la", 34.05, -118.25);
    const ny = makeFacility("ny", 40.71, -74.01);
    const clusters = clusterFacilities([la, ny], 10, 44);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it("collapses two co-located facilities into one cluster at any zoom", () => {
    // Same coordinates → 0px apart → always within radius.
    const a = makeFacility("a-fac", 35.0, -90.0);
    const b = makeFacility("b-fac", 35.0, -90.0);
    const clusters = clusterFacilities([a, b], 3.4, 44);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
  });

  it("gives the cluster id the 'cluster-' prefix when multi-member", () => {
    const a = makeFacility("a-fac", 35.0, -90.0);
    const b = makeFacility("b-fac", 35.0, -90.0);
    const [cluster] = clusterFacilities([a, b], 3.4, 44);
    expect(cluster.id).toMatch(/^cluster-/);
  });

  it("uses the raw facility id (no prefix) for a singleton cluster", () => {
    const a = makeFacility("solo", 35.0, -90.0);
    const [cluster] = clusterFacilities([a], 3.4, 44);
    expect(cluster.id).toBe("solo");
  });

  it("is deterministic — same input twice yields deep-equal output", () => {
    const facilities = [
      makeFacility("z-fac", 37.0, -122.0),
      makeFacility("a-fac", 34.0, -118.0),
      makeFacility("m-fac", 41.0, -87.0),
    ];
    const first = clusterFacilities(facilities, 4, 44);
    const second = clusterFacilities(facilities, 4, 44);
    expect(first).toEqual(second);
  });

  it("does not mutate the input array", () => {
    const a = makeFacility("a-fac", 35.0, -90.0);
    const b = makeFacility("b-fac", 36.0, -91.0);
    const input = [a, b];
    const before = [...input];
    clusterFacilities(input, 3.4, 44);
    expect(input).toEqual(before);
  });

  it("returns an empty array for an empty input", () => {
    expect(clusterFacilities([], 3.4)).toHaveLength(0);
  });

  // MIN-SEPARATION INVARIANT: every pair of cluster anchors is ≥ radiusPx apart
  // for the real dataset at the initial zoom. This is the same guarantee the old
  // MARKER_OFFSETS system aimed to provide — now enforced by construction.
  it("MIN-SEPARATION INVARIANT: all cluster anchors are ≥ 44px apart at initial zoom", () => {
    const zoom = INITIAL_VIEW_STATE.zoom;
    const radiusPx = 44;
    const clusters = clusterFacilities(getAllFacilities(), zoom, radiusPx);

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i];
        const cj = clusters[j];
        const dx = lonToX(ci.lon, zoom) - lonToX(cj.lon, zoom);
        const dy = latToY(ci.lat, zoom) - latToY(cj.lat, zoom);
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist).toBeGreaterThanOrEqual(radiusPx);
      }
    }
  });
});
