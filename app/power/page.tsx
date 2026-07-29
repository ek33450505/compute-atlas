import Link from "next/link";
import type { Metadata } from "next";

import {
  getPowerGenerationFacilities,
  getGenerationByOfftaker,
  getGenerationStats,
  getEnergySourceCounts,
  getFacilitiesByWaterUsage,
  getCoolingTypeCounts,
  type EnergySource,
  type CoolingType,
} from "@/lib/data";
import { formatCapacity, formatLocation, getFacilityMaxMw } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import type { PowerGenerationFacility } from "@/lib/schema";
import {
  GENERATION_TECHNOLOGY_ORDER,
  GENERATION_TECHNOLOGY_LABELS,
  getGenerationTechnologyLabel,
  type GenerationTechnology,
} from "@/lib/generation";

export const revalidate = 3600;

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Avoids "0.0 GW" for small totals. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

/** Returns a label + facility-count row for the technology in the same tech + location line used elsewhere. */
function technologyLabel(f: PowerGenerationFacility): string {
  return getGenerationTechnologyLabel(f.generation?.technology);
}

/** Formats a reported daily water figure as MGD (1 decimal), e.g. "12.5 MGD". */
function formatMgd(mgd: number): string {
  return `${mgd.toFixed(1)} MGD`;
}

/** Display order + labels for `energy.source` — mirrors the § Energy section on /stats. */
const ENERGY_SOURCE_ENTRIES: { key: EnergySource; label: string }[] = [
  { key: "grid", label: "Grid" },
  { key: "mixed", label: "Mixed" },
  { key: "on_site_gas", label: "On-site gas" },
  { key: "nuclear", label: "Nuclear" },
  { key: "solar", label: "Solar" },
  { key: "hydro", label: "Hydro" },
  { key: "wind", label: "Wind" },
  { key: "other", label: "Other" },
];

/** Display order + labels for `water.coolingType` — ordered by water intensity (high -> minimal), mirrors /stats § Water use. */
const COOLING_TYPE_ENTRIES: { key: CoolingType; label: string }[] = [
  { key: "evaporative", label: "Evaporative (high water)" },
  { key: "hybrid", label: "Hybrid" },
  { key: "closed_loop", label: "Closed-loop (low water)" },
  { key: "air", label: "Air-cooled (minimal)" },
];

export const metadata: Metadata = {
  title: "Data center power generation",
  description:
    "Dedicated power generation feeding the U.S. compute buildout — the nuclear and SMR projects hyperscalers are financing or contracting, grouped by offtaker and technology. Source-cited.",
  alternates: { canonical: "/power" },
};

/**
 * /power — index of the power_generation facility layer. Static server component.
 *
 * Surfaces dedicated generation (largely nuclear and advanced SMRs) that
 * hyperscalers are financing or contracting to power AI/compute, grouped by
 * offtaker (the buyer) and by technology. Mirrors the /states and /stats
 * visual language (masthead, survey-stat row, § progress-bar sections).
 */
export default async function PowerPage() {
  const [
    stats,
    offtakerGroups,
    projects,
    energySourceCounts,
    topWaterFacilities,
    coolingTypeCounts,
  ] = await Promise.all([
    getGenerationStats(),
    getGenerationByOfftaker(),
    getPowerGenerationFacilities(),
    getEnergySourceCounts(),
    getFacilitiesByWaterUsage(),
    getCoolingTypeCounts(),
  ]);
  const allProjects = [...projects].sort(
    (a, b) =>
      (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
      a.name.localeCompare(b.name)
  );

  const technologyCounts = new Map<GenerationTechnology, number>();
  for (const f of allProjects) {
    const tech = f.generation?.technology;
    if (tech) {
      technologyCounts.set(tech, (technologyCounts.get(tech) ?? 0) + 1);
    }
  }
  const presentTechnologies = GENERATION_TECHNOLOGY_ORDER.filter(
    (t) => (technologyCounts.get(t) ?? 0) > 0
  );

  const energySourceRows = ENERGY_SOURCE_ENTRIES.filter(
    ({ key }) => energySourceCounts[key] > 0
  );
  const energySourceReporting = energySourceRows.reduce(
    (sum, { key }) => sum + energySourceCounts[key],
    0
  );

  const coolingTypeRows = COOLING_TYPE_ENTRIES.filter(
    ({ key }) => coolingTypeCounts[key] > 0
  );
  const coolingTypeReporting = coolingTypeRows.reduce(
    (sum, { key }) => sum + coolingTypeCounts[key],
    0
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
            Behind-the-meter power generation for AI data centers
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground">
            Powering the buildout.
          </p>
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
          Behind-the-meter power generation for AI data centers
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Powering the buildout.
        </p>
        <p className="max-w-2xl text-base text-muted-foreground">
          Purpose-built generation — mostly nuclear and advanced SMRs — that
          hyperscalers are financing or contracting to feed AI and compute
          demand directly, tracked here as its own facility layer. In plain
          terms: these are data centers with their own power plant, generating
          on-site rather than drawing solely from the grid.
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
      {/* Overview prose                                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="max-w-2xl space-y-4">
        <p className="text-base leading-relaxed text-muted-foreground">
          Compute Atlas tracks {stats.count} dedicated-generation projects —
          plants and reactors financed or contracted specifically to power a
          data center&apos;s compute load, rather than drawn from the general
          grid. {formatPower(stats.operationalMw)} of that capacity is
          already operational, with {formatPower(stats.plannedMw)} more in
          the pipeline.
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          {stats.offtakerCount} distinct offtakers — the hyperscalers and
          operators contracted to buy the output — appear in the dataset
          below, each tied to specific projects and capacity.
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          The list groups projects by offtaker first, then by generation
          technology; every entry links through to its full facility record
          and cited sources.
        </p>
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
                  <span className="text-foreground">{GENERATION_TECHNOLOGY_LABELS[tech]}</span>
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
      {/* § Energy source                                                     */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="energy-source-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § Energy source
          </p>
          <h2
            id="energy-source-heading"
            className="font-display text-2xl text-foreground"
          >
            On-site generation vs. the grid
          </h2>
        </div>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Beyond the dedicated projects above, individual data centers and
          mining sites across the full dataset declare their own power
          source — grid electricity, on-site generation, or a mix of both.
          {energySourceReporting > 0
            ? ` ${energySourceReporting} tracked ${
                energySourceReporting === 1 ? "facility discloses" : "facilities disclose"
              } this.`
            : " No facilities disclose a power source yet."}
        </p>
        {energySourceRows.length > 0 ? (
          <ul className="space-y-4">
            {energySourceRows.map(({ key, label }) => {
              const count = energySourceCounts[key];
              const pct =
                energySourceReporting > 0
                  ? (count / energySourceReporting) * 100
                  : 0;
              return (
                <li key={key} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-foreground">{label}</span>
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
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Power-source data isn&apos;t tracked for any facility yet.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Water use                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="water-use-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § Water use
          </p>
          <h2
            id="water-use-heading"
            className="font-display text-2xl text-foreground"
          >
            Facility-level water use
          </h2>
        </div>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Cooling water is one of the least-transparent civic costs of a data
          center, and this is a reported floor, not a dataset total — most
          facilities don&apos;t publish a daily water figure.
          {topWaterFacilities.length > 0
            ? ` ${topWaterFacilities.length} tracked ${
                topWaterFacilities.length === 1
                  ? "facility discloses"
                  : "facilities disclose"
              } one, ranked below.`
            : " No facilities disclose a daily water figure yet."}
        </p>
        {topWaterFacilities.length > 0 ? (
          <ul className="divide-y divide-border">
            {topWaterFacilities.map((f) => (
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
                      {formatLocation(f)}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                    {formatMgd(f.water!.reportedMgd!)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No facilities disclose a daily water figure yet.
          </p>
        )}
        {coolingTypeRows.length > 0 && (
          <div className="space-y-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Cooling method
            </p>
            <ul className="space-y-4">
              {coolingTypeRows.map(({ key, label }) => {
                const count = coolingTypeCounts[key];
                const pct =
                  coolingTypeReporting > 0
                    ? (count / coolingTypeReporting) * 100
                    : 0;
                return (
                  <li key={key} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-foreground">{label}</span>
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
                  </li>
                );
              })}
            </ul>
          </div>
        )}
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
