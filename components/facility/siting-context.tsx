import { Droplets } from "lucide-react";

import type { Facility } from "@/lib/schema";
import { getSitingContext } from "@/lib/siting-context";

// --- Formatting helpers ---
function formatWaterValue(name: string, distanceMi: number): string {
  if (distanceMi === 0) return `On ${name}`;
  return `≈ ${distanceMi.toFixed(1)} mi — ${name}`;
}

function formatTransmissionValue(voltageKv: number, distanceMi: number): string {
  if (distanceMi === 0) return `On a ${voltageKv} kV transmission line`;
  return `≈ ${distanceMi.toFixed(1)} mi — ${voltageKv} kV line`;
}

// --- Predicate ---
export function hasSitingContext(facility: Facility): boolean {
  const context = getSitingContext(facility.id);
  return !!(context && (context.nearestWater || context.nearestTransmission));
}

// --- Main export ---
export function SitingContextSection({ facility }: { facility: Facility }) {
  const context = getSitingContext(facility.id);
  if (!context || !(context.nearestWater || context.nearestTransmission)) {
    return null;
  }

  const headingId = `siting-context-${facility.id}`;
  const { nearestWater, nearestTransmission } = context;

  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="font-display text-xl text-foreground mb-4 flex items-center gap-2"
      >
        <Droplets className="size-5 text-primary" aria-hidden="true" />
        Siting context
      </h2>
      <dl className="neatline grid grid-cols-1 gap-x-8 gap-y-4 rounded-sm border border-border p-5 sm:grid-cols-2">
        {nearestWater && (
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Nearest named waterway
            </dt>
            <dd className="mt-1 text-sm font-mono tabular-nums">
              {formatWaterValue(nearestWater.name, nearestWater.distanceMi)}
            </dd>
          </div>
        )}

        {nearestTransmission && (
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Nearest high-voltage line
            </dt>
            <dd className="mt-1 text-sm font-mono tabular-nums">
              {formatTransmissionValue(
                nearestTransmission.voltageKv,
                nearestTransmission.distanceMi,
              )}
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-3 font-mono text-[10px] text-muted-foreground">
        Straight-line distances. Nearest named waterway via the USGS National
        Hydrography Dataset; nearest transmission line via HIFLD.
      </p>
    </section>
  );
}
