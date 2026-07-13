import type { Metadata } from "next";

import {
  getStats,
  getStatusCounts,
  getCivicCoverage,
  getAiClassificationCounts,
  getConfidenceCounts,
  getTopStates,
  getTopOperators,
  getWaterUsage,
  getCoolingTypeCounts,
  getFacilityTypeCounts,
  getCommunityReceptionCounts,
  getEnergySourceCounts,
  getAllFacilities,
  type CoolingType,
  type EnergySource,
} from "@/lib/data";
import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER, COMMUNITY_RECEPTION_META } from "@/lib/community";
import type { Facility } from "@/lib/schema";
import { aiClassificationEnum } from "@/lib/schema";
import { Breadcrumb } from "@/components/breadcrumb";
import { GraticuleSurvey } from "@/components/home/graticule-survey";

export const metadata: Metadata = {
  title: "Statistics",
  description:
    "Coverage and completeness of the Compute Atlas dataset — facilities tracked, lifecycle status, civic-data coverage, and evidence quality across the U.S. grid-scale compute buildout.",
};

/** Display labels for AI classification enum keys. */
const AI_CLASSIFICATION_LABELS: Record<
  (typeof aiClassificationEnum.options)[number],
  string
> = {
  confirmed: "Confirmed",
  likely: "Likely",
  mixed_use: "Mixed use",
};

/** Display labels for confidence enum keys. */
const CONFIDENCE_LABELS: Record<Facility["confidence"], string> = {
  confirmed: "Confirmed",
  reported: "Reported",
  rumored: "Rumored",
};

/** Community reception signal buckets — excludes "unknown" (no reception signal). */
const COMMUNITY_SIGNAL_ORDER = COMMUNITY_RECEPTION_ORDER.filter(
  (k) => k !== "unknown"
);

/** Ordered civic coverage dimensions with display labels. */
const COVERAGE_DIMENSIONS = [
  { key: "energy" as const, label: "Energy" },
  { key: "water" as const, label: "Water" },
  { key: "subsidies" as const, label: "Subsidies" },
  { key: "investment" as const, label: "Investment" },
  { key: "jobs" as const, label: "Jobs" },
  { key: "community" as const, label: "Community" },
];

/**
 * /stats — aggregate statistics page.
 * Server component: all data is static at build time.
 */
export default async function StatsPage() {
  const [
    stats,
    statusCounts,
    coverage,
    aiCounts,
    confidenceCounts,
    topStates,
    topOperators,
    water,
    cooling,
    facilityTypeCounts,
    communityCounts,
    energySourceCounts,
    allFacilities,
  ] = await Promise.all([
    getStats(),
    getStatusCounts(),
    getCivicCoverage(),
    getAiClassificationCounts(),
    getConfidenceCounts(),
    getTopStates(10),
    getTopOperators(10),
    getWaterUsage(),
    getCoolingTypeCounts(),
    getFacilityTypeCounts(),
    getCommunityReceptionCounts(),
    getEnergySourceCounts(),
    getAllFacilities(),
  ]);

  const total = stats.count;
  const communityReporting = COMMUNITY_SIGNAL_ORDER.reduce(
    (sum, key) => sum + communityCounts[key],
    0
  );
  const communityFriction =
    communityCounts.contested + communityCounts.opposed + communityCounts.litigation;

  const dataCenterCount = allFacilities.filter(
    (f) => f.facilityType === "data_center"
  ).length;
  const unclassifiedCount =
    dataCenterCount - (aiCounts.confirmed + aiCounts.likely + aiCounts.mixed_use);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-16 space-y-12"
    >
      <Breadcrumb items={[{ label: "Map", href: "/map" }, { label: "Stats" }]} />
      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="relative">
        <GraticuleSurvey className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]" />
        <div className="relative space-y-4 pb-8">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            Coverage &amp; completeness · Edition 2026
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            The atlas in numbers.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            These are live aggregate figures recomputed from the dataset as
            records are added. The atlas is measured by total facilities and
            coverage — not average completeness — because a
            source-cited record that says &ldquo;unknown&rdquo; is more
            honest than a record that guesses.
          </p>
        </div>
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap gap-8 border-b border-border pb-10">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {total}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Sites tracked
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {stats.states}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            States covered
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {(stats.operationalMw / 1000).toFixed(1)} GW
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Operational
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {(stats.plannedMw / 1000).toFixed(0)} GW
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Planned pipeline
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {(stats.underConstructionMw / 1000).toFixed(0)} GW
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Under construction
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* § By type                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="facility-type-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § By type
        </p>
        <h2
          id="facility-type-heading"
          className="font-display text-2xl text-foreground"
        >
          Facility type
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Most tracked sites are data centers; a smaller set are large-scale
          crypto mining facilities, which draw on the same grid capacity.
        </p>
        <div className="space-y-4">
          {FACILITY_TYPE_ORDER.map((key) => {
            const count = facilityTypeCounts[key];
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-foreground">
                    {FACILITY_TYPE_META[key].label}
                  </span>
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
      {/* § Energy                                                            */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="energy-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Energy
        </p>
        <h2
          id="energy-heading"
          className="font-display text-2xl text-foreground"
        >
          Power source
        </h2>

        {(() => {
          const energySourceEntries: { key: EnergySource; label: string }[] = [
            { key: "grid", label: "Grid" },
            { key: "mixed", label: "Mixed" },
            { key: "on_site_gas", label: "On-site gas" },
            { key: "nuclear", label: "Nuclear" },
            { key: "solar", label: "Solar" },
            { key: "hydro", label: "Hydro" },
            { key: "wind", label: "Wind" },
            { key: "other", label: "Other" },
          ];
          const energySourceReporting = Object.values(energySourceCounts).reduce(
            (a, b) => a + b,
            0
          );
          return (
            <>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Power source is disclosed for {energySourceReporting} of{" "}
                {total} tracked sites. Campus power capacity totals
                (operational, planned, under construction) are the survey
                figures at the top of this page.
              </p>
              <div className="space-y-4">
                {energySourceEntries.map(({ key, label }) => {
                  const count = energySourceCounts[key];
                  const pct =
                    energySourceReporting > 0
                      ? (count / energySourceReporting) * 100
                      : 0;
                  return (
                    <div key={key} className="space-y-1.5">
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
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Water use                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="water-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Water use
        </p>
        <h2
          id="water-heading"
          className="font-display text-2xl text-foreground"
        >
          Water use
        </h2>

        {/* Lead figure */}
        <div className="flex flex-col gap-1">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {water.totalMgd.toFixed(1)} MGD
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Reported daily water &middot; million gal/day
          </span>
        </div>

        {/* Context line */}
        <p className="text-sm text-muted-foreground">
          Across {water.reportingCount} of {total}{" "}
          facilities that disclose a daily figure &middot; &asymp;
          {(water.totalMgd * 365 / 1000).toFixed(1)}B gallons/year
        </p>

        {/* Honest caveat */}
        <p className="text-sm leading-relaxed text-muted-foreground">
          These figures represent a{" "}
          <strong className="font-medium text-foreground">reported floor</strong>,
          not a dataset total — the vast majority of tracked campuses do not
          publish a daily water figure. Cooling water is the least-transparent civic
          dimension in this dataset. Cooling method is a meaningful proxy for water
          intensity: evaporative systems consume far more water than air-cooled or
          closed-loop alternatives.
        </p>

        {/* Cooling-method breakdown */}
        {(() => {
          // Ordered by water intensity (high → minimal) — a rearrangement of CoolingType.
          const coolingEntries: { key: CoolingType; label: string }[] = [
            { key: "evaporative", label: "Evaporative (high water)" },
            { key: "hybrid", label: "Hybrid" },
            { key: "closed_loop", label: "Closed-loop (low water)" },
            { key: "air", label: "Air-cooled (minimal)" },
          ];
          const coolingSum = coolingEntries.reduce(
            (sum, { key }) => sum + cooling[key],
            0
          );
          return (
            <div className="space-y-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Cooling method
              </p>
              {coolingEntries.map(({ key, label }) => {
                const count = cooling[key];
                const pct =
                  coolingSum > 0 ? (count / coolingSum) * 100 : 0;
                return (
                  <div key={key} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-foreground">{label}</span>
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {count}
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
          );
        })()}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § By status                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="status-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § By status
        </p>
        <h2
          id="status-heading"
          className="font-display text-2xl text-foreground"
        >
          Lifecycle status
        </h2>
        <div className="space-y-4">
          {STATUS_ORDER.map((status) => {
            const count = statusCounts[status];
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={status} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-foreground">
                    {STATUS_META[status].label}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {count} &middot; {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    aria-hidden="true"
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${pct.toFixed(2)}%`,
                      backgroundColor: getStatusColor(status),
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Community reception                                               */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="community-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Community reception
        </p>
        <h2
          id="community-heading"
          className="font-display text-2xl text-foreground"
        >
          Community reception
        </h2>

        {/* Lead figure */}
        <div className="flex flex-col gap-1">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {communityFriction}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Sites facing documented community friction
          </span>
        </div>

        {/* Context line */}
        <p className="text-sm text-muted-foreground">
          Contested, opposed, or in active litigation &middot; out of{" "}
          {communityReporting} with a sourced community status
        </p>

        {/* Honest caveat */}
        <p className="text-sm leading-relaxed text-muted-foreground">
          Reception is a{" "}
          <strong className="font-medium text-foreground">sourced, documented</strong>{" "}
          signal, not a survey &mdash; {total - communityReporting} tracked
          campuses have no documented community reception on file and are not
          counted here.
        </p>

        {/* Reception breakdown */}
        <div className="space-y-4">
          {COMMUNITY_SIGNAL_ORDER.map((key) => {
            const count = communityCounts[key];
            const pct = communityReporting > 0 ? (count / communityReporting) * 100 : 0;
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-foreground">
                    {COMMUNITY_RECEPTION_META[key].label}
                  </span>
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
      {/* § Data coverage                                                     */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="coverage-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Data coverage
        </p>
        <h2
          id="coverage-heading"
          className="font-display text-2xl text-foreground"
        >
          Civic-data coverage
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each figure counts facilities carrying at least one{" "}
          <strong className="font-medium text-foreground">sourced</strong> value
          in that dimension — not average completeness. A facility with any
          documented energy source, utility, or note counts as covered for
          energy; the same logic applies across all six dimensions.
        </p>
        <div className="space-y-4">
          {COVERAGE_DIMENSIONS.map(({ key, label }) => {
            const count = coverage[key];
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-foreground">{label}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {count} / {total} &middot; {pct.toFixed(0)}%
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
      {/* § Evidence quality                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="evidence-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Evidence quality
        </p>
        <h2
          id="evidence-heading"
          className="font-display text-2xl text-foreground"
        >
          Evidence quality
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The atlas follows the &ldquo;a source for every record&rdquo; standard
          — every field traces back to a public source. AI classification and
          confidence levels make that evidence quality explicit.
        </p>

        <div className="grid gap-8 sm:grid-cols-2">
          {/* AI classification */}
          <div className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              AI classification
            </p>
            <dl className="space-y-2 text-sm">
              {(
                Object.keys(AI_CLASSIFICATION_LABELS) as (typeof aiClassificationEnum.options)[number][]
              ).map(
                (key) => (
                  <div key={key} className="flex items-baseline justify-between gap-2">
                    <dt className="text-foreground">{AI_CLASSIFICATION_LABELS[key]}</dt>
                    <dd className="font-mono tabular-nums text-muted-foreground">
                      {aiCounts[key]}
                    </dd>
                  </div>
                )
              )}
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-foreground">Not AI-classified</dt>
                <dd className="font-mono tabular-nums text-muted-foreground">
                  {unclassifiedCount}
                </dd>
              </div>
            </dl>
          </div>

          {/* Confidence */}
          <div className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Confidence
            </p>
            <dl className="space-y-2 text-sm">
              {(Object.keys(CONFIDENCE_LABELS) as Facility["confidence"][]).map(
                (key) => (
                  <div key={key} className="flex items-baseline justify-between gap-2">
                    <dt className="text-foreground">{CONFIDENCE_LABELS[key]}</dt>
                    <dd className="font-mono tabular-nums text-muted-foreground">
                      {confidenceCounts[key]}
                    </dd>
                  </div>
                )
              )}
            </dl>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Geography & Operators (two-column grid)                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-10 sm:grid-cols-2">
        {/* § Geography */}
        <section
          aria-labelledby="geography-heading"
          className="space-y-4 border-t border-border pt-10"
        >
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § Geography
          </p>
          <h2
            id="geography-heading"
            className="font-display text-2xl text-foreground"
          >
            Top states
          </h2>
          <p className="text-sm text-muted-foreground">
            {stats.states} state{stats.states !== 1 ? "s" : ""} covered &middot; top 10 by
            facility count
          </p>
          <ul className="space-y-2 text-sm">
            {topStates.map(({ state, count }) => (
              <li
                key={state}
                className="flex items-baseline justify-between gap-2"
              >
                <span className="font-mono uppercase text-foreground">
                  {state}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {count}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* § Operators */}
        <section
          aria-labelledby="operators-heading"
          className="space-y-4 border-t border-border pt-10"
        >
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § Operators
          </p>
          <h2
            id="operators-heading"
            className="font-display text-2xl text-foreground"
          >
            Top operators
          </h2>
          <p className="text-sm text-muted-foreground">Top 10 by facility count</p>
          <ul className="space-y-2 text-sm">
            {topOperators.map(({ operator, count }) => (
              <li
                key={operator}
                className="flex items-baseline justify-between gap-2"
              >
                <span className="text-foreground truncate min-w-0 pr-2">
                  {operator}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                  {count}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
