import Link from "next/link";
import type { Metadata } from "next";

import {
  getPowerGenerationFacilities,
  getGenerationByOfftaker,
  getGenerationStats,
  getGenerationBuildoutStats,
  getEnergySourceCounts,
  getFacilitiesByWaterUsage,
  getCoolingTypeCounts,
} from "@/lib/data";
import { formatLocation, formatMgd, formatPower, formatRatio, sortByMaxMwDesc, countDisclosedCapacity } from "@/lib/format";
import { ENERGY_SOURCE_ENTRIES, COOLING_TYPE_ENTRIES } from "@/lib/energy";
import { Breadcrumb } from "@/components/breadcrumb";
import { FacilityListRow } from "@/components/facility-list-row";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { PercentageBar } from "@/components/percentage-bar";
import { SectionHeading } from "@/components/section-heading";
import { StateNav } from "@/components/collection/state-nav";
import { parseStateParam, stateCounts } from "@/lib/state-index";
import { stateNameFromCode } from "@/lib/us-states";
import type { PowerGenerationFacility } from "@/lib/schema";
import {
  GENERATION_TECHNOLOGY_ORDER,
  GENERATION_TECHNOLOGY_LABELS,
  getGenerationTechnologyLabel,
  type GenerationTechnology,
} from "@/lib/generation";

/** Offtaker lines on the default view: the largest buyers by capacity. */
const TOP_OFFTAKERS = 25;

/** Rows in the default view's project list: the largest projects by capacity. */
const TOP_PROJECTS = 48;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Returns a label + facility-count row for the technology in the same tech + location line used elsewhere. */
function technologyLabel(f: PowerGenerationFacility): string {
  return getGenerationTechnologyLabel(f.generation?.technology);
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const available = new Set(
    (await getPowerGenerationFacilities()).map((f) => f.location.state)
  );
  const state = parseStateParam((await searchParams).state, available);
  const description =
    "Dedicated power generation feeding the U.S. compute buildout — the gas, nuclear, and renewable projects hyperscalers are financing or contracting, summarized by offtaker and technology and listed by state. Source-cited.";
  if (!state) {
    return {
      title: "Data center power generation",
      description,
      alternates: { canonical: "/power" },
    };
  }
  return {
    title: `Data center power generation in ${stateNameFromCode(state)}`,
    description,
    alternates: { canonical: `/power?state=${state.toLowerCase()}` },
  };
}

/**
 * /power — index of the power_generation facility layer.
 *
 * Surfaces dedicated generation (most often natural gas, plus nuclear and SMRs) that
 * hyperscalers are financing or contracting to power AI/compute, grouped by
 * offtaker (the buyer) and by technology. Mirrors the /states and /stats
 * visual language (masthead, survey-stat row, § progress-bar sections).
 *
 * The default view summarizes offtakers (one line each) and lists the largest
 * projects; `?state=xx` lists every project in that state. Why: listing every
 * project twice (by offtaker, then "All projects") was a 2.2 MB document
 * (audit U-11) because the RSC payload repeats each row. Reading
 * `searchParams` makes the route dynamic; data still comes through the
 * 24 h-cached loader.
 */
export default async function PowerPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [
    stats,
    buildout,
    offtakerGroups,
    projects,
    energySourceCounts,
    topWaterFacilities,
    coolingTypeCounts,
  ] = await Promise.all([
    getGenerationStats(),
    getGenerationBuildoutStats(),
    getGenerationByOfftaker(),
    getPowerGenerationFacilities(),
    getEnergySourceCounts(),
    getFacilitiesByWaterUsage(),
    getCoolingTypeCounts(),
  ]);
  const allProjects = [...projects].sort(sortByMaxMwDesc);
  const projectStates = allProjects.map((f) => f.location.state);
  const state = parseStateParam((await searchParams).state, new Set(projectStates));
  const stateProjects = state
    ? allProjects.filter((f) => f.location.state === state)
    : [];
  const activeInState = stateProjects.filter((f) => f.status !== "cancelled");
  const capacityDisclosedCount = countDisclosedCapacity(allProjects);

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

  // getGenerationByOfftaker() silently drops projects with no
  // generation.offtaker — name that gap here rather than let the § By
  // offtaker breakdown read as if it covers every tracked project.
  const offtakerReporting = offtakerGroups.reduce(
    (sum, group) => sum + group.facilities.length,
    0
  );
  const offtakerTotal = allProjects.length;

  // Shared with the homepage/about-page ratio math via formatRatio — guards
  // a zero denominator so a data state with no non-fossil capacity yet
  // renders an em-dash instead of Infinity/NaN.
  const buildoutRatioLabel = formatRatio(buildout.fossilPlannedMw, buildout.nonFossilPlannedMw);
  const nonFossilBarPct =
    buildout.fossilPlannedMw > 0
      ? (buildout.nonFossilPlannedMw / buildout.fossilPlannedMw) * 100
      : 0;

  if (stats.count === 0) {
    return (
      <div
        data-content-width="4xl"
        className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
      >
        <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Power" }]} />
        <PageMasthead
          eyebrow="Dedicated generation"
          title="Behind-the-meter power generation for AI data centers"
          dek="No dedicated-generation projects are tracked yet."
        />
      </div>
    );
  }

  if (state) {
    return (
      <div
        data-content-width="4xl"
        className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
      >
        <Breadcrumb
          items={[
            { label: "Explore", href: "/explore" },
            { label: "Power", href: "/power" },
            { label: stateNameFromCode(state) ?? state },
          ]}
        />
        <PageMasthead
          eyebrow="Dedicated generation"
          title="Behind-the-meter power generation for AI data centers"
          dek="Purpose-built generation that hyperscalers are financing or contracting to feed AI and compute demand directly, listed by state."
        />
        <SurveyStatRow
          spacing="wide"
          stats={[
            { value: stateProjects.length, label: "Projects" },
            {
              value: formatPower(
                activeInState.reduce((n, f) => n + (f.capacityMw?.operational ?? 0), 0)
              ),
              label: "Operational",
            },
            {
              value: formatPower(
                activeInState.reduce((n, f) => n + (f.capacityMw?.planned ?? 0), 0)
              ),
              label: "Pipeline",
            },
          ]}
        />
        <section
          aria-labelledby="projects-heading"
          className="space-y-4 border-t border-border pt-10"
        >
          <SectionHeading
            kicker="Projects"
            id="projects-heading"
            title={`Projects in ${stateNameFromCode(state)}`}
          />
          <StateNav
            basePath="/power"
            label="Power projects by state"
            states={stateCounts(projectStates)}
            current={state}
            noun={["project", "projects"]}
          />
          <ul className="divide-y divide-border">
            {stateProjects.map((f) => (
              <li key={f.id}>
                <FacilityListRow
                  compact
                  facility={f}
                  secondary={
                    <>
                      {technologyLabel(f)}
                      {f.generation?.offtaker ? <>{" "}&middot;{" "}{f.generation.offtaker}</> : null}
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Power" }]} />

      <PageMasthead
        eyebrow="Dedicated generation"
        title="Behind-the-meter power generation for AI data centers"
        dek="Purpose-built generation — most often natural gas, with a growing nuclear and small-modular-reactor cohort — that hyperscalers are financing or contracting to feed AI and compute demand directly. Tracked here as its own facility layer, distinct from the compute campuses it supplies: a dedicated plant built or contracted for a specific offtaker, rather than a data center drawing solely from the grid."
      />

      <SurveyStatRow
        spacing="wide"
        stats={[
          { value: stats.count, label: "Projects" },
          { value: formatPower(stats.operationalMw), label: "Operational" },
          { value: formatPower(stats.plannedMw), label: "Pipeline" },
          { value: stats.offtakerCount, label: "Offtakers" },
        ]}
      />

      <div className="max-w-2xl space-y-4">
        <p className="text-base leading-relaxed text-muted-foreground">
          Compute Atlas tracks {stats.count}{" "}
          dedicated-generation projects —
          plants and reactors financed or contracted specifically to power a
          data center&apos;s compute load, rather than drawn from the general
          grid. {formatPower(stats.operationalMw)} of that capacity is
          already operational, with {formatPower(stats.plannedMw)} more in
          the pipeline. Capacity is disclosed for {capacityDisclosedCount} of
          the {stats.count} tracked projects; both figures sum those records
          only — a floor, not a dataset total.
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          {stats.offtakerCount} distinct offtakers — the hyperscalers and
          operators contracted to buy the output — appear in the dataset
          below, each tied to specific projects and capacity.
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          The page summarizes projects by offtaker and by generation
          technology, then lists the largest projects; every project is
          listed by state, and every entry links through to its full facility
          record and cited sources.
        </p>
      </div>

      <section
        aria-labelledby="buildout-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <SectionHeading kicker="The buildout" id="buildout-heading" title="What's being built" />
        </div>
        <SurveyStatRow
          spacing="wide"
          stats={[
            { value: formatPower(buildout.fossilPlannedMw), label: "Gas · planned" },
            {
              value: formatPower(buildout.nonFossilPlannedMw),
              label: "Non-fossil · planned",
            },
            { value: buildoutRatioLabel, label: "Ratio" },
            {
              value: `${buildout.gas.operational} of ${buildout.gas.total}`,
              label: "Gas plants running",
            },
          ]}
        />
        <div className="space-y-4">
          <PercentageBar
            label="Gas · planned"
            valueLabel={formatPower(buildout.fossilPlannedMw)}
            pct={100}
          />
          <PercentageBar
            label="Non-fossil · planned"
            valueLabel={formatPower(buildout.nonFossilPlannedMw)}
            pct={nonFossilBarPct}
            opacity={0.35}
          />
        </div>
        <div className="max-w-2xl space-y-4">
          <p className="text-base leading-relaxed text-muted-foreground">
            On planned capacity alone, tracked natural-gas projects total{" "}
            {formatPower(buildout.fossilPlannedMw)} against{" "}
            {formatPower(buildout.nonFossilPlannedMw)} for every non-fossil
            technology combined — nuclear, small modular reactors, solar,
            wind, geothermal and fusion. Measured on planned capacity, the
            dedicated-generation pipeline is predominantly fossil-fired — a{" "}
            {buildoutRatioLabel} ratio of gas to non-fossil technology.
          </p>
          <p className="text-base leading-relaxed text-muted-foreground">
            Only {buildout.gas.operational} of the {buildout.gas.total}{" "}
            tracked gas plants are operational. {buildout.gas.proposed} are
            proposed and {buildout.gas.permitted} are permitted but not yet
            under way; {buildout.gas.underConstruction} are under
            construction. Most of this fleet is not yet built: permits still
            to be granted, plants still to be sited — the fuel mix is a
            decision still being made, not a settled outcome.
          </p>
          <p className="text-base leading-relaxed text-muted-foreground">
            These figures compare planned capacity only, and planned capacity
            is not interchangeable with the operational figures in the survey
            row above. Projects with no disclosed technology, and battery
            storage, are counted in neither total.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="offtaker-heading"
        className="space-y-8 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <SectionHeading kicker="By offtaker" id="offtaker-heading" title="Who's buying the power" />
        </div>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          {offtakerReporting} of the {offtakerTotal} tracked power-generation
          projects name a specific offtaker; the offtakers below cover those
          projects only — the rest have a technology and location on record
          but no disclosed buyer.
          {offtakerGroups.length > TOP_OFFTAKERS
            ? ` The ${TOP_OFFTAKERS} largest of ${offtakerGroups.length} offtakers by capacity are listed; every project is listed under its state, with its offtaker where one is disclosed.`
            : ""}
        </p>
        <ul className="divide-y divide-border">
          {offtakerGroups.slice(0, TOP_OFFTAKERS).map((group) => (
            <li
              key={group.offtaker}
              className="flex items-baseline justify-between gap-4 py-2 text-sm"
            >
              <span className="text-foreground">{group.offtaker}</span>
              <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                {group.facilities.length}{" "}
                {group.facilities.length === 1 ? "project" : "projects"}{" "}
                &middot;{" "}
                {formatPower(group.totalMw)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="technology-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <SectionHeading kicker="By technology" id="technology-heading" title="Technology mix" />
        <div className="space-y-4">
          {presentTechnologies.map((tech) => {
            const count = technologyCounts.get(tech) ?? 0;
            const pct = allProjects.length > 0 ? (count / allProjects.length) * 100 : 0;
            return (
              <PercentageBar
                key={tech}
                label={GENERATION_TECHNOLOGY_LABELS[tech]}
                valueLabel={
                  <>
                    {count} &middot; {pct.toFixed(0)}%
                  </>
                }
                pct={pct}
              />
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby="energy-source-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <SectionHeading kicker="Energy source" id="energy-source-heading" title="On-site generation vs. the grid" />
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
                <PercentageBar
                  key={key}
                  as="li"
                  label={label}
                  valueLabel={
                    <>
                      {count} &middot; {pct.toFixed(0)}%
                    </>
                  }
                  pct={pct}
                />
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Power-source data isn&apos;t tracked for any facility yet.
          </p>
        )}
      </section>

      <section
        aria-labelledby="water-use-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <div className="space-y-2">
          <SectionHeading kicker="Water use" id="water-use-heading" title="Facility-level water use" />
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
                  className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
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
            <div className="space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Cooling method
              </p>
              <p className="text-xs text-muted-foreground">
                Share of the {coolingTypeReporting} facilities that disclose a
                cooling method — a broader set than the facilities publishing
                a daily water figure above.
              </p>
            </div>
            <ul className="space-y-4">
              {coolingTypeRows.map(({ key, label }) => {
                const count = coolingTypeCounts[key];
                const pct =
                  coolingTypeReporting > 0
                    ? (count / coolingTypeReporting) * 100
                    : 0;
                return (
                  <PercentageBar
                    key={key}
                    as="li"
                    label={label}
                    valueLabel={
                      <>
                        {count} &middot; {pct.toFixed(0)}%
                      </>
                    }
                    pct={pct}
                  />
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {allProjects.length > 0 && (
      <section
        aria-labelledby="projects-heading"
        className="space-y-4 border-t border-border pt-10"
      >
        <SectionHeading
          kicker="Projects"
          id="projects-heading"
          title={
            allProjects.length === 1
              ? "Largest project"
              : `Largest ${Math.min(TOP_PROJECTS, allProjects.length)} projects`
          }
        />
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Sorted by disclosed capacity. Every tracked project, including those
          with no disclosed capacity, is listed under its state.
        </p>
        <StateNav
          basePath="/power"
          label="Power projects by state"
          states={stateCounts(projectStates)}
          current={null}
          noun={["project", "projects"]}
        />
        <ul className="divide-y divide-border">
          {allProjects.slice(0, TOP_PROJECTS).map((f) => (
            <li key={f.id}>
              <FacilityListRow
                facility={f}
                secondary={<>{technologyLabel(f)} &middot; {formatLocation(f)}</>}
              />
            </li>
          ))}
        </ul>
      </section>
      )}
    </div>
  );
}
