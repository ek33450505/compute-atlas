import { getFacilityById } from "@/lib/data";
import { stateNameFromCode } from "@/lib/us-states";
import { WATCH_TARGET, WATCH_TARGET_TYPES } from "@/lib/watch-target-types";
import type { WatchTargetType } from "@/lib/watch-target-types";

export { WATCH_TARGET, WATCH_TARGET_TYPES };
export type { WatchTargetType };

/**
 * Registry of watchable target types. Adding a type is a NEW AUDIENCE decision,
 * not just a new entry: see the `notifyStateSubscribersMonthly` doc in
 * lib/notify.ts, which warns that a new targetType is a new reactivation
 * decision. `targetType` is free text in the DB, so no migration is involved.
 */
export interface WatchTargetDef {
  /** Resolves and canonicalises a caller-supplied id; null when it names nothing. */
  resolve(id: string): Promise<{ id: string; label: string } | null>;
  /** Exact 400 error string for an unresolved target. */
  notFoundError: string;
  cadence: "instant" | "monthly";
  family: "facility" | "area";
}

export const WATCH_TARGETS = {
  facility: {
    async resolve(id) {
      const facility = await getFacilityById(id);
      return facility ? { id, label: facility.name } : null;
    },
    notFoundError: "Unknown facility",
    cadence: "instant",
    family: "facility",
  },
  state: {
    async resolve(id) {
      // Normalized to uppercase before storing/comparing so "ca" and "CA" are
      // one target, not two — matches location.state's stored convention.
      const code = id.toUpperCase();
      const stateName = stateNameFromCode(code);
      return stateName ? { id: code, label: stateName } : null;
    },
    notFoundError: "Unknown state",
    cadence: "monthly",
    family: "area",
  },
} as const satisfies Record<WatchTargetType, WatchTargetDef>;
