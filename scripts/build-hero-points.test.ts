import { describe, it, expect } from "vitest";

import { COORD_PRECISION, toHeroPoints } from "./build-hero-points.mjs";

const fac = (id: string, lat: number, lon: number, status = "operational") => ({
  id,
  status,
  location: { lat, lon },
});

describe("toHeroPoints", () => {
  it("emits exactly lat/lon/status, with no id", () => {
    const points = toHeroPoints([fac("site-a", 39.1234, -94.6789)]);
    expect(points).toEqual([{ lat: 39.12, lon: -94.68, status: "operational" }]);
    expect(Object.keys(points[0]).sort()).toEqual(["lat", "lon", "status"]);
  });

  it("rounds to 2 dp, half away from zero for negative ties", () => {
    expect(COORD_PRECISION).toBe(2);
    const [p] = toHeroPoints([fac("a", 10.125, -94.625)]);
    // 10.125 and -94.625 are exact binary ties.
    expect(p.lat).toBe(10.13);
    expect(p.lon).toBe(-94.63);
  });

  it("collapses identical points but keeps differing statuses", () => {
    const points = toHeroPoints([
      fac("a", 39.001, -94.001),
      fac("b", 39.002, -94.002),
      fac("c", 39.001, -94.001, "proposed"),
    ]);
    expect(points).toHaveLength(2);
  });

  it("skips facilities without finite coordinates", () => {
    expect(
      toHeroPoints([{ id: "x", status: "operational", location: {} }, fac("y", NaN, 1)])
    ).toEqual([]);
  });
});
