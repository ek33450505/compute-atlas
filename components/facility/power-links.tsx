import Link from "next/link";
import { Zap, Plug } from "lucide-react";

import type { Facility } from "@/lib/schema";
import { getPoweredCampuses, getPoweredByGenerators } from "@/lib/data";
import { getGenerationTechnologyLabel } from "@/lib/generation";
import { getStatusMeta } from "@/lib/status";
import { FACILITY_TYPE_META } from "@/lib/facility-type";
import { formatCapacity, formatLocation } from "@/lib/format";

const LINK_CLASSNAME =
  "text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

// --- Predicate ---
export function hasPowerLinks(facility: Facility): boolean {
  if (facility.facilityType === "power_generation") {
    return (
      getPoweredCampuses(facility).length > 0 ||
      !!facility.generation?.offtaker ||
      !!facility.generation?.notes
    );
  }
  return getPoweredByGenerators(facility).length > 0;
}

// --- Branch A: power_generation facility ("Powers") ---
function PowersGroup({ facility }: { facility: Facility & { facilityType: "power_generation" } }) {
  const campuses = getPoweredCampuses(facility);

  return (
    <>
      {campuses.length > 0 ? (
        <ul className="space-y-3">
          {campuses.map((c) => {
            const metaParts = [
              FACILITY_TYPE_META[c.facilityType]?.label,
              formatLocation(c),
              formatCapacity(c),
            ].filter(Boolean);
            return (
              <li key={c.id} className="text-sm">
                <Link href={`/facilities/${c.id}`} className={LINK_CLASSNAME}>
                  {c.name}
                </Link>
                {metaParts.length > 0 && (
                  <div className="text-muted-foreground text-xs mt-0.5">
                    {metaParts.join(" · ")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        facility.generation?.offtaker && (
          <p className="text-sm">
            Supplies power to <strong>{facility.generation.offtaker}</strong>
            <span className="block text-muted-foreground text-xs mt-0.5">
              Company-level / grid-region purchase — no single named campus.
            </span>
          </p>
        )
      )}
      {facility.generation?.notes && (
        <p className="mt-2 text-sm text-muted-foreground">
          {facility.generation.notes}
        </p>
      )}
    </>
  );
}

// --- Branch B: data_center / crypto_mining facility ("Power supply") ---
function PoweredByGroup({ facility }: { facility: Facility }) {
  const generators = getPoweredByGenerators(facility);

  return (
    <ul className="space-y-3">
      {generators.map((g) => {
        const metaParts = [
          getGenerationTechnologyLabel(g.generation?.technology),
          getStatusMeta(g.status).label,
          formatCapacity(g),
        ].filter(Boolean);
        return (
          <li key={g.id} className="text-sm">
            <Link href={`/facilities/${g.id}`} className={LINK_CLASSNAME}>
              {g.name}
            </Link>
            {metaParts.length > 0 && (
              <div className="text-muted-foreground text-xs mt-0.5">
                {metaParts.join(" · ")}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --- Main export ---
export function PowerLinksSection({ facility }: { facility: Facility }) {
  if (!hasPowerLinks(facility)) return null;

  const headingId = `power-links-${facility.id}`;
  const isGenerator = facility.facilityType === "power_generation";

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2
        id={headingId}
        className="font-display text-xl text-foreground mb-4 flex items-center gap-2"
      >
        {isGenerator ? (
          <Zap className="size-5 text-primary" aria-hidden="true" />
        ) : (
          <Plug className="size-5 text-primary" aria-hidden="true" />
        )}
        {isGenerator ? "Powers" : "Power supply"}
      </h2>
      {isGenerator ? (
        <PowersGroup facility={facility} />
      ) : (
        <PoweredByGroup facility={facility} />
      )}
    </section>
  );
}
