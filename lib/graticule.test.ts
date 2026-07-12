import { describe, expect, it } from "vitest";
import { buildGraticuleGeoJSON, formatLatLon } from "@/lib/graticule";

describe("buildGraticuleGeoJSON", () => {
  it("returns 37 meridians + 17 parallels for the default 10° step", () => {
    const fc = buildGraticuleGeoJSON(10, 2);
    const meridians = fc.features.filter(
      (f) => f.geometry.coordinates[0][0] === f.geometry.coordinates[1][0]
    );
    const parallels = fc.features.filter(
      (f) => f.geometry.coordinates[0][1] === f.geometry.coordinates[1][1]
    );
    expect(meridians).toHaveLength(37);
    expect(parallels).toHaveLength(17);
    expect(fc.features).toHaveLength(54);
  });

  it("every feature is a LineString with at least 2 coordinates", () => {
    const fc = buildGraticuleGeoJSON();
    for (const feature of fc.features) {
      expect(feature.type).toBe("Feature");
      expect(feature.geometry.type).toBe("LineString");
      expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("meridian endpoints land exactly on lat -80/80", () => {
    const fc = buildGraticuleGeoJSON(10, 2);
    const meridian = fc.features.find(
      (f) =>
        f.geometry.coordinates[0][0] === 0 &&
        f.geometry.coordinates[0][1] === -80
    );
    expect(meridian).toBeDefined();
    const coords = meridian!.geometry.coordinates;
    expect(coords[0]).toEqual([0, -80]);
    expect(coords[coords.length - 1]).toEqual([0, 80]);
  });

  it("parallel endpoints land exactly on lon -180/180", () => {
    const fc = buildGraticuleGeoJSON(10, 2);
    const parallel = fc.features.find(
      (f) =>
        f.geometry.coordinates[0][1] === 0 &&
        f.geometry.coordinates[0][0] === -180
    );
    expect(parallel).toBeDefined();
    const coords = parallel!.geometry.coordinates;
    expect(coords[0]).toEqual([-180, 0]);
    expect(coords[coords.length - 1]).toEqual([180, 0]);
  });

  it("densifies each line with a vertex every densifyDeg degrees", () => {
    const fc = buildGraticuleGeoJSON(10, 2);
    const meridian = fc.features.find(
      (f) =>
        f.geometry.coordinates[0][0] === 0 &&
        f.geometry.coordinates[0][1] === -80
    );
    // lat -80 to 80 in steps of 2 -> 81 vertices (160/2 + 1)
    expect(meridian!.geometry.coordinates).toHaveLength(81);
  });
});

describe("formatLatLon", () => {
  it("formats northeast hemisphere (positive lat, positive lon)", () => {
    expect(formatLatLon(40.7128, 3.7038)).toBe("40.71° N · 3.70° E");
  });

  it("formats northwest hemisphere (positive lat, negative lon)", () => {
    expect(formatLatLon(40.7128, -74.006)).toBe("40.71° N · 74.01° W");
  });

  it("formats southeast hemisphere (negative lat, positive lon)", () => {
    expect(formatLatLon(-33.8688, 151.2093)).toBe("33.87° S · 151.21° E");
  });

  it("formats southwest hemisphere (negative lat, negative lon)", () => {
    expect(formatLatLon(-23.5505, -46.6333)).toBe("23.55° S · 46.63° W");
  });

  it("reports the equator as N", () => {
    expect(formatLatLon(0, -74.006)).toBe("0.00° N · 74.01° W");
  });

  it("reports the prime meridian as E", () => {
    expect(formatLatLon(40.7128, 0)).toBe("40.71° N · 0.00° E");
  });

  it("rounds to two decimals", () => {
    expect(formatLatLon(40.71284999, -74.00599999)).toBe("40.71° N · 74.01° W");
  });
});
