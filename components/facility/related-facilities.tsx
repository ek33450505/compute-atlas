import Link from "next/link";

import type { Facility } from "@/lib/schema";
import { getFacilitiesByOperator, getFacilitiesByStateCached, operatorSlug } from "@/lib/data";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { StatusBadge } from "@/components/status-badge";
import { Separator } from "@/components/ui/separator";

const MAX_PER_GROUP = 6;

const FOOTER_LINK_CLASSNAME =
  "mt-4 inline-block text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * One related-facility card. Mirrors the "Notable sites" card markup on the
 * homepage (app/page.tsx) for visual consistency: name, operator + status
 * row, "City, ST", capacity. Omits the coordinates line the homepage card
 * carries — not needed in a related-facilities rail.
 */
function RelatedFacilityCard({ facility }: { facility: Facility }) {
  const cap = facility.capacityMw?.operational ?? facility.capacityMw?.planned ?? null;
  return (
    <Link
      href={`/facilities/${facility.id}`}
      className="neatline group flex flex-col gap-2 rounded-sm border border-border p-4 transition-colors motion-reduce:transition-none hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="font-display text-base leading-snug text-foreground group-hover:text-primary transition-colors motion-reduce:transition-none">
        {facility.name}
      </span>

      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground truncate min-w-0">
          {facility.operator}
        </span>
        <StatusBadge status={facility.status} className="shrink-0" />
      </div>

      <span className="font-mono text-xs text-muted-foreground">
        {facility.location.city ? `${facility.location.city}, ` : ""}
        {facility.location.state}
      </span>

      {cap !== null && (
        <span className="font-mono text-xs text-muted-foreground">
          {cap >= 1000 ? `${(cap / 1000).toFixed(1)} GW` : `${cap} MW`}
        </span>
      )}
    </Link>
  );
}

/**
 * Related-facilities rail for the facility detail page — "More from
 * {operator}" and "Other data centers in {state}" groups, each excluding
 * the current facility and capped at 6. Async server component (fetches
 * both lists in parallel via the per-scope cached readers —
 * `getFacilitiesByOperator` now delegates to the tag-only
 * `getFacilitiesByOperatorCached`, mirroring `getFacilitiesByStateCached` —
 * so it doesn't pull in the global `"facilities"` tag/timer; see the doc
 * comments on both in lib/data.ts).
 *
 * Returns null (no separator, no heading) when both groups are empty, so a
 * facility whose operator and state both have no other entries renders no
 * rail at all rather than an empty shell.
 */
export async function RelatedFacilities({ facility }: { facility: Facility }) {
  const [byOperator, byState] = await Promise.all([
    getFacilitiesByOperator(facility.operator),
    getFacilitiesByStateCached(facility.location.state),
  ]);

  const operatorGroup = byOperator
    .filter((f) => f.id !== facility.id)
    .slice(0, MAX_PER_GROUP);
  const stateGroup = byState
    .filter((f) => f.id !== facility.id)
    .slice(0, MAX_PER_GROUP);

  if (operatorGroup.length === 0 && stateGroup.length === 0) {
    return null;
  }

  const stateName = stateNameFromCode(facility.location.state) ?? facility.location.state;
  const stateSlug = stateSlugFromCode(facility.location.state);

  return (
    <>
      <Separator />
      <section aria-labelledby="related-facilities-heading" className="print:hidden">
        <h2
          id="related-facilities-heading"
          className="font-display text-xl text-foreground mb-6"
        >
          Related facilities
        </h2>
        <div className="space-y-8">
          {operatorGroup.length > 0 && (
            <div>
              <h3 className="font-display text-lg text-foreground mb-4">
                More from {facility.operator}
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {operatorGroup.map((f) => (
                  <RelatedFacilityCard key={f.id} facility={f} />
                ))}
              </div>
              <Link
                href={`/operators/${operatorSlug(facility.operator)}`}
                className={FOOTER_LINK_CLASSNAME}
              >
                All {facility.operator} sites →
              </Link>
            </div>
          )}

          {stateGroup.length > 0 && (
            <div>
              <h3 className="font-display text-lg text-foreground mb-4">
                Other data centers in {stateName}
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {stateGroup.map((f) => (
                  <RelatedFacilityCard key={f.id} facility={f} />
                ))}
              </div>
              {stateSlug && (
                <Link href={`/states/${stateSlug}`} className={FOOTER_LINK_CLASSNAME}>
                  All {stateName} →
                </Link>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
