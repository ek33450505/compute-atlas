import Link from "next/link";
import type { Metadata } from "next";

import {
  getPowerGenerationFacilities,
  getGenerationByOfftaker,
  getGenerationStats,
} from "@/lib/data";
import { formatCapacity, formatLocation, getFacilityMaxMw } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import type { PowerGenerationFacility } from "@/lib/schema";

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Avoids "0.0 GW" for small totals. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

/** All 9 generation technology keys (stable, exhaustive set — mirrors schema `generation.technology` enum). */
const TECHNOLOGY_ORDER = [
  "nuclear_smr",
  "nuclear",
  "natural_gas",
  "solar",
  "wind",
  "hydro",
  "geothermal",
  "battery",
  "other",
] as const;

type Technology = (typeof TECHNOLOGY_ORDER)[number];

/** Human-readable labels for the generation technology enum. */
const TECHNOLOGY_LABELS: Record<Technology, string> = {
  nuclear_smr: "Nuclear · SMR",
  nuclear: "Nuclear · conventional",
  natural_gas: "Natural gas",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  geothermal: "Geothermal",
  battery: "Battery",
  other: "Other",
};

/** Returns a label + facility-count row for the technology in the same tech + location line used elsewhere. */
function technologyLabel(f: PowerGenerationFacility): string {
  const tech = f.generation?.technology;
  return tech ? TECHNOLOGY_LABELS[tech] : "Technology unknown";
}

export const metadata: Metadata = {
  title: "Power",
  description:
    "Dedicated power generation feeding the U.S. compute buildout — the nuclear and SMR projects hyperscalers are financing or contracting, grouped by offtaker and technology. Source-cited.",
};

/**
 * /power — index of the power_generation facility layer. Static server component.
 *
 * Surfaces dedicated generation (largely nuclear and advanced SMRs) that
 * hyperscalers are financing or contracting to power AI/compute, grouped by
 * offtaker (the buyer) and by technology. Mirrors the /states and /stats
 * visual language (masthead, survey-stat row, § progress-bar sections).
 */
export default function PowerPage() {
  const stats = getGenerationStats();
  const offtakerGroups = getGenerationByOfftaker();
  const allProjects = [...getPowerGenerationFacilities()].sort(
    (a, b) =>
      (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
      a.name.localeCompare(b.name)
  );

  const technologyCounts = new Map<Technology, number>();
  for (const f of allProjects) {
    const tech = f.generation?.technology;
    if (tech) {
      technologyCounts.set(tech, (technologyCounts.get(tech) ?? 0) + 1);
    }
  }
  const presentTechnologies = TECHNOLOGY_ORDER.filter(
    (t) => (technologyCounts.get(t) ?? 0) > 0
  );

  if (stats.count === 0) {
    return (
      <div
        data-content-width="4xl"
        className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
      >
        <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Power" }]} />
        <header className="space-y-4 pb-2">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            Dedicated generation
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Powering the buildout
          </h1>
          <p className="text-base text-muted-foreground">
            No dedicated-generation projects are tracked yet.
          </p>
          <div className="border-t border-border" />
        </header>
      </div>
    );
  }

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Power" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Dedicated generation
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Powering the buildout
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Purpose-built generation — mostly nuclear and advanced SMRs — that
          hyperscalers are financing or contracting to feed AI and compute
          demand directly, tracked here as its own facility layer.
        </p>
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap gap-8 border-b border-border pb-10">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {stats.count}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Projects
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {formatPower(stats.operationalMw)}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Operational
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {formatPower(stats.plannedMw)}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Pipeline
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {stats.offtakerCount}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Offtakers
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* § By offtaker                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="offtaker-heading"
        className="space-y-8 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § By offtaker
          </p>
          <h2 id="offtaker-heading" className="font-display text-2xl text-foreground">
            Who&apos;s buying the power
          </h2>
        </div>
        <div className="space-y-8">
          {offtakerGroups.map((group) => (
            <div key={group.offtaker} className="space-y-3">
              <h3 className="flex items-baseline justify-between gap-2 text-sm font-medium text-foreground">
                <span>{group.offtaker}</span>
                <span className="font-mono tabular-nums text-xs text-muted-foreground">
                  {formatPower(group.totalMw)}
                </span>
              </h3>
              <ul className="divide-y divide-border">
                {group.facilities.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/facilities/${f.id}`}
                      className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm text-foreground truncate">
                          {f.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {technologyLabel(f)} &middot; {formatLocation(f)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <StatusBadge status={f.status} />
                        <span className="font-mono tabular-nums text-xs text-muted-foreground">
                          {formatCapacity(f)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § By technology                                                     */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="technology-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § By technology
        </p>
        <h2 id="technology-heading" className="font-display text-2xl text-foreground">
          Technology mix
        </h2>
        <div className="space-y-4">
          {presentTechnologies.map((tech) => {
            const count = technologyCounts.get(tech) ?? 0;
            const pct = allProjects.length > 0 ? (count / allProjects.length) * 100 : 0;
            return (
              <div key={tech} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-foreground">{TECHNOLOGY_LABELS[tech]}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {count} &middot; {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    aria-hidden="true"
                    className="h-full rounded-full"
                    style={{
                      width: `${pct.toFixed(2)}%`,
                      backgroundColor: "var(--primary)",
                      opacity: 0.7,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Projects                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="projects-heading"
        className="space-y-4 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Projects
        </p>
        <h2 id="projects-heading" className="font-display text-2xl text-foreground">
          All projects
        </h2>
        <ul className="divide-y divide-border">
          {allProjects.map((f) => (
            <li key={f.id}>
              <Link
                href={`/facilities/${f.id}`}
                className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm text-foreground truncate">
                    {f.name}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {technologyLabel(f)} &middot; {formatLocation(f)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <StatusBadge status={f.status} />
                  <span className="font-mono tabular-nums text-xs text-muted-foreground">
                    {formatCapacity(f)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
