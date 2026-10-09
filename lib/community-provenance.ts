/**
 * Whether a submission's `provenance.discoveredBy` marks it as coming from the
 * public (a community submission) rather than the maintainer or the discovery
 * pipeline. Client-safe: no imports.
 *
 * Where each value is written:
 * - "public-contribution" / "public-correction": lib/contribute.ts (the public
 *   /contribute form: new facility / correction to an existing one).
 * - "leads-lane": scripts/discovery/leads-lane.ts (machine-staged public URL tips).
 * - "lead:<uuid>": lib/leads.ts `stageLeadSubmission` (admin-staged public URL
 *   tips). The suffix is the lead id, so it is matched by prefix, not equality.
 *
 * Anything else ("discovery-pipeline", "manual", wave names, ...) is not community.
 */
const COMMUNITY_EXACT: ReadonlySet<string> = new Set([
  "public-contribution",
  "public-correction",
  "leads-lane",
]);

const COMMUNITY_PREFIX = "lead:";

export function isCommunityDiscoveredBy(
  discoveredBy: string | null | undefined,
): boolean {
  if (typeof discoveredBy !== "string") return false;
  return (
    COMMUNITY_EXACT.has(discoveredBy) || discoveredBy.startsWith(COMMUNITY_PREFIX)
  );
}
