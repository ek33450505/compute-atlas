/**
 * Client-safe watch-target vocabulary. Dependency-free on purpose: the watch
 * button (a client component) imports the type from here, so nothing server-side
 * (`getFacilityById`, the DB) may ever be imported into this file. The resolvers
 * live in `lib/watch-targets.ts`.
 */
export const WATCH_TARGET_TYPES = ["facility", "state"] as const;

export type WatchTargetType = (typeof WATCH_TARGET_TYPES)[number];

/** Named constants for the `subscriptions.targetType` column values. */
export const WATCH_TARGET = {
  facility: "facility",
  state: "state",
} as const satisfies Record<WatchTargetType, WatchTargetType>;
