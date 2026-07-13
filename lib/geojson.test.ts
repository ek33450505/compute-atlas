import { describe, it, expect } from "vitest";
import { facilitiesToGeoJSON } from "@/lib/geojson";
import { getAllFacilities } from "@/lib/data";

describe("facilitiesToGeoJSON", () => {
  it("returns type FeatureCollection", async () => {
    const geojson = facilitiesToGeoJSON(await getAllFacilities());
    expect(geojson.type).toBe("FeatureCollection");
  });

  it("has one feature per facility", async () => {
    const facilities = await getAllFacilities();
    const geojson = facilitiesToGeoJSON(facilities);
    expect(geojson.features).toHaveLength(facilities.length);
  });

  it("each feature has geometry.type === 'Point'", async () => {
    const geojson = facilitiesToGeoJSON(await getAllFacilities());
    geojson.features.forEach((f) => {
      expect(f.geometry.type).toBe("Point");
    });
  });

  it("coordinates are [lon, lat] matching the source facility", async () => {
    const facilities = await getAllFacilities();
    const geojson = facilitiesToGeoJSON(facilities);
    facilities.forEach((facility, i) => {
      const coords = geojson.features[i].geometry.coordinates;
      expect(coords[0]).toBe(facility.location.lon);
      expect(coords[1]).toBe(facility.location.lat);
    });
  });

  it("properties.status is set on each feature", async () => {
    const geojson = facilitiesToGeoJSON(await getAllFacilities());
    geojson.features.forEach((f) => {
      expect(f.properties.status).toBeDefined();
    });
  });

  it("properties carry id, name, operator, and state", async () => {
    const facilities = await getAllFacilities();
    const geojson = facilitiesToGeoJSON(facilities);
    facilities.forEach((facility, i) => {
      const p = geojson.features[i].properties;
      expect(p.id).toBe(facility.id);
      expect(p.name).toBe(facility.name);
      expect(p.operator).toBe(facility.operator);
      expect(p.state).toBe(facility.location.state);
    });
  });

  it("returns an empty FeatureCollection for empty input", () => {
    const geojson = facilitiesToGeoJSON([]);
    expect(geojson.type).toBe("FeatureCollection");
    expect(geojson.features).toHaveLength(0);
  });
});
