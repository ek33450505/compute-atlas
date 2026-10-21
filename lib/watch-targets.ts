import { getCountyBySlug, getFacilityById } from "@/lib/data";
import { formatCountyLabel, getMetroBySlug } from "@/lib/metros";
import { stateNameFromCode } from "@/lib/us-states";
import {
  normalizeWatchTargetId,
  watchAreasEnabled,
  WATCH_TARGET,
  WATCH_TARGET_TYPES,
} from "@/lib/watch-target-types";
import type { WatchTargetType } from "@/lib/watch-target-types";

export { WATCH_TARGET, WATCH_TARGET_TYPES, watchAreasEnabled };
export type { WatchTargetType };

/**
 * Registry of watchable target types. Adding a type is a NEW AUDIENCE decision,
 * not just a new entry: see the `notifyStateSubscribersMonthly` doc in
 * lib/notify.ts, which warns that a new targetType is a new reactivation
 * decision. `targetType` is free text in the DB, so no migration is involved.
 *
 * `county` and `metro` were authorised as a new audience by Ed on 2026-10-21
 * (D9), delivered by the monthly area digest (unit 8b). They sit behind the
 * `WATCH_AREAS_ENABLED` kill switch (`watchAreasEnabled`), which ships ON.
 */
export interface WatchTargetDef {
  /** Resolves and canonicalises a caller-supplied id; null when it names nothing. */
  resolve(id: string): Promise<{ id: string; label: string } | null>;
  /** Canonical form of a caller-supplied id, applied before `resolve` and when keying suppressions. */
  normalizeId(id: string): string;
  /** Exact 400 error string for an unresolved target. */
  notFoundError: string;
  cadence: "instant" | "monthly";
  family: "facility" | "area";
}

export const WATCH_TARGETS = {
  facility: {
    normalizeId: (id) => normalizeWatchTargetId("facility", id),
    async resolve(id) {
      const facility = await getFacilityById(id);
      return facility ? { id, label: facility.name } : null;
    },
    notFoundError: "Unknown facility",
    cadence: "instant",
    family: "facility",
  },
  state: {
    normalizeId: (id) => normalizeWatchTargetId("state", id),
    async resolve(id) {
      // Normalized to uppercase before storing/comparing so "ca" and "CA" are
      // one target, not two — matches location.state's stored convention.
      const code = normalizeWatchTargetId("state", id);
      const stateName = stateNameFromCode(code);
      return stateName ? { id: code, label: stateName } : null;
    },
    notFoundError: "Unknown state",
    cadence: "monthly",
    family: "area",
  },
  county: {
    normalizeId: (id) => normalizeWatchTargetId("county", id),
    async resolve(id) {
      const county = await getCountyBySlug(normalizeWatchTargetId("county", id));
      return county
        ? {
            id: county.slug.toLowerCase(),
            // County names repeat across states, so the label carries the state.
            label: `${formatCountyLabel(county.name, county.state)}, ${county.state}`,
          }
        : null;
    },
    notFoundError: "Unknown county",
    cadence: "monthly",
    family: "area",
  },
  metro: {
    normalizeId: (id) => normalizeWatchTargetId("metro", id),
    async resolve(id) {
      const metro = getMetroBySlug(normalizeWatchTargetId("metro", id));
      return metro ? { id: metro.slug, label: metro.name } : null;
    },
    notFoundError: "Unknown metro",
    cadence: "monthly",
    family: "area",
  },
} as const satisfies Record<WatchTargetType, WatchTargetDef>;
