import { facilitiesSchema, type Facility } from "@/lib/schema";
import { STATUS_ORDER, type Status } from "@/lib/status";
import facilitiesRaw from "@/data/facilities.json";

// Validate at module load time so `next build` fails loudly on bad data.
const parseResult = facilitiesSchema.safeParse(facilitiesRaw);
if (!parseResult.success) {
  throw new Error(
    "Invalid facilities data:\n" +
      parseResult.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")
  );
}

export const facilities: Facility[] = parseResult.data;

export function getAllFacilities(): Facility[] {
  return facilities;
}

export function getFacilityById(id: string): Facility | undefined {
  return facilities.find((f) => f.id === id);
}

/** Returns unique 2-letter state codes, sorted A→Z. */
export function getStates(): string[] {
  return [...new Set(facilities.map((f) => f.location.state))].sort();
}

/** Returns unique operator names, sorted A→Z. */
export function getOperators(): string[] {
  return [...new Set(facilities.map((f) => f.operator))].sort();
}

/** Returns a count per status for all facilities (all 5 statuses always present). */
export function getStatusCounts(): Record<Status, number> {
  const counts = Object.fromEntries(
    STATUS_ORDER.map((s) => [s, 0])
  ) as Record<Status, number>;
  for (const f of facilities) {
    counts[f.status]++;
  }
  return counts;
}
