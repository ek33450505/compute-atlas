import { describe, it, expect, beforeAll } from "vitest";
import { getAllFacilities, getFacilityById } from "@/lib/data";
import { facilitySchema } from "@/lib/schema";
import type { Facility } from "@/lib/schema";

describe("data integrity — facilities.json", () => {
  let facilities: Facility[];

  beforeAll(async () => {
    facilities = await getAllFacilities();
  });

  it("every record parses against facilitySchema", () => {
    const failing: string[] = [];
    for (const f of facilities) {
      const result = facilitySchema.safeParse(f);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message).join("; ");
        failing.push(`${f.id}: ${msgs}`);
      }
    }
    expect(
      failing,
      `Schema violations:\n${failing.join("\n")}`
    ).toHaveLength(0);
  });

  it("all ids are unique", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const f of facilities) {
      if (seen.has(f.id)) duplicates.push(f.id);
      seen.add(f.id);
    }
    expect(
      duplicates,
      `Duplicate ids: ${duplicates.join(", ")}`
    ).toHaveLength(0);
  });

  it("every record has at least one source", () => {
    const failing = facilities
      .filter((f) => f.sources.length < 1)
      .map((f) => f.id);
    expect(
      failing,
      `Missing sources: ${failing.join(", ")}`
    ).toHaveLength(0);
  });

  it("every statusHistory sourceIndex is within bounds", () => {
    const failing: string[] = [];
    for (const f of facilities) {
      f.statusHistory.forEach((event, idx) => {
        if (
          event.sourceIndex !== undefined &&
          event.sourceIndex >= f.sources.length
        ) {
          failing.push(
            `${f.id}: statusHistory[${idx}].sourceIndex ${event.sourceIndex} out of range (sources.length=${f.sources.length})`
          );
        }
      });
    }
    expect(failing, failing.join("\n")).toHaveLength(0);
  });

  it("every civic-impact sourceIndex is within bounds", () => {
    const failing: string[] = [];
    for (const f of facilities) {
      const sourceCount = f.sources.length;
      f.subsidies?.forEach((s, idx) => {
        if (s.sourceIndex !== undefined && s.sourceIndex >= sourceCount) {
          failing.push(
            `${f.id}: subsidies[${idx}].sourceIndex ${s.sourceIndex} out of range (sources.length=${sourceCount})`
          );
        }
      });
      if (f.jobs?.sourceIndex !== undefined && f.jobs.sourceIndex >= sourceCount) {
        failing.push(
          `${f.id}: jobs.sourceIndex ${f.jobs.sourceIndex} out of range (sources.length=${sourceCount})`
        );
      }
      if (f.community?.sourceIndex !== undefined && f.community.sourceIndex >= sourceCount) {
        failing.push(
          `${f.id}: community.sourceIndex ${f.community.sourceIndex} out of range (sources.length=${sourceCount})`
        );
      }
    }
    expect(failing, failing.join("\n")).toHaveLength(0);
  });

  it("every location.state is exactly 2 uppercase letters", () => {
    const failing = facilities
      .filter((f) => !/^[A-Z]{2}$/.test(f.location.state))
      .map((f) => `${f.id}: state="${f.location.state}"`);
    expect(failing, failing.join(", ")).toHaveLength(0);
  });

  it("coordinates are within known US jurisdictions (contiguous, Alaska, Hawaii, territories)", () => {
    // US jurisdictions occupy multiple non-contiguous regions.
    // A single bounding box would either exclude real territories (Guam, American Samoa, etc.)
    // or accept most of the planet, defeating the purpose of this guard.
    // Guam and Northern Mariana Islands sit at POSITIVE longitude (144–147°E);
    // American Samoa is in the SOUTHERN hemisphere (−16 to −9°S).
    // This test catches transposed signs, swapped lat/lon, or geocoder errors in the wrong hemisphere.
    const regions = [
      {
        name: "Contiguous US + Alaska + Hawaii + PR + USVI",
        lat: [15, 72],
        lon: [-180, -64],
      },
      {
        name: "Guam + Northern Mariana Islands",
        lat: [13, 21],
        lon: [144, 147],
      },
      {
        name: "American Samoa",
        lat: [-16, -9],
        lon: [-173, -166],
      },
    ];

    const isInAnyRegion = (lat: number, lon: number): boolean =>
      regions.some(
        (r) => lat >= r.lat[0] && lat <= r.lat[1] && lon >= r.lon[0] && lon <= r.lon[1]
      );

    const failing = facilities
      .filter((f) => !isInAnyRegion(f.location.lat, f.location.lon))
      .map((f) => `${f.id}: lat=${f.location.lat}, lon=${f.location.lon}`);
    expect(failing, failing.join("\n")).toHaveLength(0);
  });

  it("every lastUpdated is a parseable date", () => {
    const failing = facilities
      .filter((f) => isNaN(Date.parse(f.lastUpdated)))
      .map((f) => `${f.id}: lastUpdated="${f.lastUpdated}"`);
    expect(failing, failing.join(", ")).toHaveLength(0);
  });

  it("every generation.poweredFacilityIds entry resolves to a distinct compute facility", async () => {
    const failing: string[] = [];
    for (const f of facilities) {
      if (f.facilityType !== "power_generation") continue;
      const ids = f.generation?.poweredFacilityIds ?? [];
      for (const id of ids) {
        if (id === f.id) {
          failing.push(`${f.id}: poweredFacilityIds self-references ${id}`);
          continue;
        }
        const target = await getFacilityById(id);
        if (!target) {
          failing.push(`${f.id}: poweredFacilityIds references unknown id ${id}`);
          continue;
        }
        if (target.facilityType === "power_generation") {
          failing.push(
            `${f.id}: poweredFacilityIds references another power_generation facility ${id}`
          );
        }
      }
    }
    expect(failing, failing.join("\n")).toHaveLength(0);
  });
});
