import { getAllFacilities } from "@/lib/data";
import type { Facility } from "@/lib/schema";

// Derived, not hardcoded: live data gains power links over time, and a fixed
// id for "no plant powers this" broke PR #407.
export async function findUnpoweredDataCenter(): Promise<Facility | undefined> {
  const all = await getAllFacilities();
  const powered = new Set<string>();
  for (const f of all) {
    if (f.facilityType !== "power_generation") continue;
    for (const id of f.generation?.poweredFacilityIds ?? []) powered.add(id);
  }
  return all
    .filter((f) => f.facilityType === "data_center" && !powered.has(f.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

// Derived for the same reason: a plant with no links today (e.g. Crane) can
// gain one in any data wave.
export async function findUnlinkedPowerPlant(): Promise<Facility | undefined> {
  const all = await getAllFacilities();
  return all
    .filter(
      (f) =>
        f.facilityType === "power_generation" &&
        (f.generation?.poweredFacilityIds ?? []).length === 0
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}
