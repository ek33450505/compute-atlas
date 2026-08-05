import { Droplets } from "lucide-react";

import type { Facility } from "@/lib/schema";
import {
  formatNearestTransmission,
  formatNearestWater,
  getSitingContext,
  splitRiskLabel,
} from "@/lib/siting-context";

function hasAnyDatum(context: ReturnType<typeof getSitingContext>): boolean {
  return !!(
    context &&
    (context.nearestWater ||
      context.nearestTransmission ||
      context.waterStress ||
      context.groundwaterDecline ||
      context.aquifer)
  );
}

// --- Predicate ---
export function hasSitingContext(facility: Facility): boolean {
  return hasAnyDatum(getSitingContext(facility.id));
}

// --- Main export ---
export function SitingContextSection({ facility }: { facility: Facility }) {
  const context = getSitingContext(facility.id);
  if (!hasAnyDatum(context)) {
    return null;
  }

  const headingId = `siting-context-${facility.id}`;
  const {
    nearestWater,
    nearestTransmission,
    waterStress,
    groundwaterDecline,
    aquifer,
  } = context!;

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
              {formatNearestWater(nearestWater.name, nearestWater.distanceMi)}
            </dd>
          </div>
        )}

        {nearestTransmission && (
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Nearest high-voltage line
            </dt>
            <dd className="mt-1 text-sm font-mono tabular-nums">
              {formatNearestTransmission(
                nearestTransmission.voltageKv,
                nearestTransmission.distanceMi,
              )}
            </dd>
          </div>
        )}

        {waterStress && (
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Baseline water stress
            </dt>
            <dd className="mt-1 text-sm">
              {(() => {
                const { category, detail } = splitRiskLabel(waterStress.label);
                return (
                  <>
                    <span className="text-foreground">{category}</span>
                    {detail && (
                      <span className="ml-1 text-muted-foreground">
                        ({detail})
                      </span>
                    )}
                  </>
                );
              })()}
            </dd>
          </div>
        )}

        {groundwaterDecline && (
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Groundwater decline
            </dt>
            <dd className="mt-1 text-sm">
              {(() => {
                const { category, detail } = splitRiskLabel(
                  groundwaterDecline.label,
                );
                return (
                  <>
                    <span className="text-foreground">{category}</span>
                    {detail && (
                      <span className="ml-1 text-muted-foreground">
                        ({detail})
                      </span>
                    )}
                  </>
                );
              })()}
            </dd>
          </div>
        )}

        {aquifer && (
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Principal aquifer
            </dt>
            <dd className="mt-1 text-sm">
              <span className="text-foreground">{aquifer.name}</span>
              {aquifer.rock && (
                <span className="ml-1 text-muted-foreground">
                  ({aquifer.rock})
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-3 font-mono text-[10px] text-muted-foreground">
        Straight-line distances. Nearest named waterway via the USGS National
        Hydrography Dataset; nearest transmission line via HIFLD. Baseline
        water stress and groundwater trend describe the surrounding
        hydrological basin (WRI Aqueduct 4.0, CC BY 4.0) — not this
        facility&rsquo;s measured water use. Principal-aquifer system
        underlying the location (USGS, mapped at 1:2,500,000 — regional
        context, not site hydrogeology).
      </p>
    </section>
  );
}
