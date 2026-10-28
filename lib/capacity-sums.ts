import type { Facility } from "@/lib/schema";
import type { Status } from "@/lib/status";

export type CapacityTier = "operational" | "planned";

/**
 * Sums one capacity tier across a facility list. A facility with no figure on
 * file contributes 0. Shared by the county, metro and status pages and by their
 * share cards, so a card and the page it unfurls can never disagree.
 */
export function sumCapacityMw(
  facilities: Pick<Facility, "capacityMw">[],
  tier: CapacityTier
): number {
  return facilities.reduce((sum, f) => sum + (f.capacityMw?.[tier] ?? 0), 0);
}

/**
 * The capacity tier a status page headlines: operational capacity for the
 * operational status, planned capacity for every other (announced-but-not-yet-
 * running) status. A cancelled project's "planned" figure is the capacity that
 * was announced before the cancellation.
 */
export function capacityTierForStatus(status: Status): CapacityTier {
  return status === "operational" ? "operational" : "planned";
}

/** Stat-row label for the figure `capacityTierForStatus` selects. */
export const STATUS_CAPACITY_LABEL: Record<Status, string> = {
  operational: "Operational capacity",
  under_construction: "Planned capacity",
  permitted: "Planned capacity",
  proposed: "Planned capacity",
  cancelled: "Planned capacity (cancelled)",
};
