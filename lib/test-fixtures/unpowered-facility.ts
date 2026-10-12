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
