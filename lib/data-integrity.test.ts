import { describe, it, expect } from "vitest";
import { getAllFacilities, getFacilityById } from "@/lib/data";
import { facilitySchema } from "@/lib/schema";

describe("data integrity — facilities.json", () => {
  const facilities = getAllFacilities();

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

  it("coordinates are within plausible US bounds (lat 15–72, lon −180 to −65)", () => {
    const failing = facilities
      .filter(
        (f) =>
          f.location.lat < 15 ||
          f.location.lat > 72 ||
          f.location.lon < -180 ||
          f.location.lon > -65
      )
      .map((f) => `${f.id}: lat=${f.location.lat}, lon=${f.location.lon}`);
    expect(failing, failing.join("\n")).toHaveLength(0);
  });

  it("every lastUpdated is a parseable date", () => {
    const failing = facilities
      .filter((f) => isNaN(Date.parse(f.lastUpdated)))
      .map((f) => `${f.id}: lastUpdated="${f.lastUpdated}"`);
    expect(failing, failing.join(", ")).toHaveLength(0);
  });

  it("every generation.poweredFacilityIds entry resolves to a distinct compute facility", () => {
    const failing: string[] = [];
    for (const f of facilities) {
      if (f.facilityType !== "power_generation") continue;
      const ids = f.generation?.poweredFacilityIds ?? [];
      for (const id of ids) {
        if (id === f.id) {
          failing.push(`${f.id}: poweredFacilityIds self-references ${id}`);
          continue;
        }
        const target = getFacilityById(id);
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
