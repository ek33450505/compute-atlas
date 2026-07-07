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

/**
 * Returns aggregate stats for the whole dataset.
 *
 * `operationalMw` — sum of `capacityMw.operational` across non-cancelled facilities.
 * `plannedMw`     — sum of `capacityMw.planned` across non-cancelled facilities.
 * Both lenses exclude cancelled projects so the displayed figures are not
 * inflated by withdrawn announcements. They are intentionally independent
 * (running vs announced) rather than a combined max/total.
 */
export function getStats(): {
  count: number;
  states: number;
  operationalMw: number;
  plannedMw: number;
} {
  const count = facilities.length;
  const states = new Set(facilities.map((f) => f.location.state)).size;
  const active = facilities.filter((f) => f.status !== "cancelled");
  const operationalMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.operational ?? 0),
    0
  );
  const plannedMw = active.reduce(
    (sum, f) => sum + (f.capacityMw?.planned ?? 0),
    0
  );
  return { count, states, operationalMw, plannedMw };
}

/** Returns the top-N facilities sorted by highest capacity (operational or planned). */
export function getNotableFacilities(n = 6): Facility[] {
  return [...facilities]
    .sort(
      (a, b) =>
        Math.max(b.capacityMw?.operational ?? 0, b.capacityMw?.planned ?? 0) -
        Math.max(a.capacityMw?.operational ?? 0, a.capacityMw?.planned ?? 0)
    )
    .slice(0, n);
}
