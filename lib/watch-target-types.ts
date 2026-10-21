/**
 * Client-safe watch-target vocabulary. Dependency-free on purpose: the watch
 * button (a client component) imports the type from here, so nothing server-side
 * (`getFacilityById`, the DB) may ever be imported into this file. The resolvers
 * live in `lib/watch-targets.ts`.
 */
export const WATCH_TARGET_TYPES = ["facility", "state", "county", "metro"] as const;

export type WatchTargetType = (typeof WATCH_TARGET_TYPES)[number];

/** Named constants for the `subscriptions.targetType` column values. */
export const WATCH_TARGET = {
  facility: "facility",
  state: "state",
  county: "county",
  metro: "metro",
} as const satisfies Record<WatchTargetType, WatchTargetType>;

/**
 * Canonical form of a caller-supplied target id, per type: state codes
 * uppercase, county/metro slugs lowercase, facility ids verbatim. Lives here
 * (dependency-free) so lib/suppressions.ts keys exactly the way the registry
 * stores, without importing server data modules. An unknown type falls back to
 * trim only.
 */
export function normalizeWatchTargetId(targetType: string, id: string): string {
  const trimmed = id.trim();
  switch (targetType) {
    case "state":
      return trimmed.toUpperCase();
    case "county":
    case "metro":
      return trimmed.toLowerCase();
    default:
      return trimmed;
  }
}

/**
 * Kill switch for county/metro watching: ON unless `WATCH_AREAS_ENABLED` is
 * exactly "false". Read on every call, never cached at module scope (same
 * rationale as `submissionNotifyEnabled`), so the subscribe API sees a flip on
 * its next request. The hub pages call it at RENDER time under 24h ISR, so a
 * flip reaches them only on their next render or a redeploy. Facility and
 * state are never gated by it.
 */
export function watchAreasEnabled(): boolean {
  return process.env.WATCH_AREAS_ENABLED !== "false";
}
