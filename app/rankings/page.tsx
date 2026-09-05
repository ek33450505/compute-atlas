import Link from "next/link";
import type { Metadata } from "next";

import {
  getStats,
  getFacilitiesRankedByPlannedMw,
  getTopOperatorsByCapacity,
  getTopStatesByCapacity,
  operatorSlug,
  type OperatorCapacityRanking,
  type StateCapacityRanking,
} from "@/lib/data";
import { formatLocation, formatPower } from "@/lib/format";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { Breadcrumb } from "@/components/breadcrumb";
import { CollectionJsonLd } from "@/components/collection/collection-json-ld";
import { FacilityListRow } from "@/components/facility-list-row";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { SectionHeading } from "@/components/section-heading";

export const revalidate = 3600;

/** A state capacity ranking row enriched with display name + route slug. */
type StateRow = StateCapacityRanking & { name: string; slug: string | undefined };

const CRUMBS = [{ label: "Explore", href: "/explore" }, { label: "Rankings" }];

export const metadata: Metadata = {
  title: "Data center rankings",
  description:
    "The biggest tracked data center projects, and the operators and states with the most disclosed capacity — ranked by tracked megawatts, each entry source-cited.",
  alternates: { canonical: "/rankings" },
};

/**
 * /rankings — capacity rankings hub. Static server component.
 *
 * Three ranked dimensions over the same dataset: biggest individual projects
 * by disclosed planned capacity, and the operators and states with the most
 * disclosed capacity. Note the operator/state rankings sum only the sites
 * that publish a figure (capacity is disclosed on ~52% of records), so they
 * rank disclosure as much as size — the headings say "disclosed" for exactly
 * that reason; do not retitle them back. Deliberately a single page (not
 * /rankings/[dimension] routes) — mirrors /power's masthead + stat-row +
 * repeated-section structure rather than /ai's single-dimension shape.
 */
export default async function RankingsPage() {
  const [stats, topProjects, topOperators, topStates] = await Promise.all([
    getStats(),
    getFacilitiesRankedByPlannedMw(),
    getTopOperatorsByCapacity(),
    getTopStatesByCapacity(),
  ]);

  const operatorRows: OperatorCapacityRanking[] = topOperators;

  const stateRows: StateRow[] = topStates.map((s) => ({
    ...s,
    name: stateNameFromCode(s.state) ?? s.state,
    slug: stateSlugFromCode(s.state),
  }));

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <CollectionJsonLd crumbs={CRUMBS} facilities={topProjects} />

      <Breadcrumb items={CRUMBS} />

      <PageMasthead
        eyebrow="Rankings"
        title="Biggest data center projects, operators and states by disclosed capacity"
        dek="The compute buildout, ranked by tracked capacity."
      />

      {stats.count === 0 ? (
        <p className="text-base text-muted-foreground">
          No facilities are tracked yet.
        </p>
      ) : (
        <>
          <div className="max-w-2xl space-y-4">
            <p className="text-base leading-relaxed text-muted-foreground">
              Three views over the same{" "}
              {stats.count.toLocaleString("en-US")}-facility dataset: the
              single largest projects by disclosed planned capacity, the
              operators with the most disclosed capacity across their sites,
              and the states with the most disclosed capacity. Each ranking is
              ordered by tracked megawatts — not by press coverage or
              announcement size — and reflects only what a cited source
              discloses. These rankings cover only the facilities that disclose
              a capacity figure — a site absent from them may be large but
              undisclosed, not small. In the operator and state rankings
              below, a large facility count beside a modest megawatt total
              usually means most of that operator&apos;s or state&apos;s
              sites publish no figure at all, not that they are small.
            </p>
            <p className="text-base leading-relaxed text-muted-foreground">
              Every entry below links through to its full facility, operator,
              or state record and cited sources.
            </p>
          </div>

          <SurveyStatRow
            stats={[
              { value: stats.count, label: "Facilities" },
              { value: stats.states, label: "States" },
              { value: formatPower(stats.operationalMw), label: "Operational" },
              { value: formatPower(stats.plannedMw), label: "Pipeline" },
            ]}
          />

          <section
            aria-labelledby="projects-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <div className="space-y-2">
              <SectionHeading kicker="Biggest projects" id="projects-heading" title="Biggest data center projects" />
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              Individual facilities ranked by tracked capacity — planned
              megawatts, the figure operators disclose for a project&apos;s
              full build-out.
            </p>
            {topProjects.length > 0 ? (
              <ol className="divide-y divide-border">
                {topProjects.map((f) => (
                  <li key={f.id}>
                    <FacilityListRow
                      facility={f}
                      secondary={<>{f.operator} &middot; {formatLocation(f)}</>}
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No facilities disclose a planned-capacity figure yet.
              </p>
            )}
          </section>

          <section
            aria-labelledby="operators-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <div className="space-y-2">
              <SectionHeading kicker="Operators with the most disclosed capacity" id="operators-heading" title="Operators with the most disclosed capacity" />
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              Operators ranked by combined capacity — operational plus
              planned — summed across the sites they run that disclose a
              figure.
            </p>
            {operatorRows.length > 0 ? (
              <ol className="divide-y divide-border">
                {operatorRows.map((o) => (
                  <li key={o.operator}>
                    <Link
                      href={`/operators/${operatorSlug(o.operator)}`}
                      className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm text-foreground truncate">
                          {o.operator}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {o.count} {o.count === 1 ? "facility" : "facilities"} tracked{" "}
                          &middot; {o.disclosedCount}{" "}
                          {o.disclosedCount === 1 ? "discloses" : "disclose"} capacity
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                        {formatPower(o.operationalMw + o.plannedMw)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No operators disclose a capacity figure yet.
              </p>
            )}
          </section>

          <section
            aria-labelledby="states-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <div className="space-y-2">
              <SectionHeading kicker="States with the most disclosed capacity" id="states-heading" title="States with the most disclosed capacity" />
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              States ranked by combined capacity — operational plus planned —
              summed across the facilities tracked there that disclose a
              figure.
            </p>
            {stateRows.length > 0 ? (
              <ol className="divide-y divide-border">
                {stateRows.map((s) => (
                  <li key={s.state}>
                    {s.slug ? (
                      <Link
                        href={`/states/${s.slug}`}
                        className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                      >
                        <span className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm text-foreground truncate">
                            {s.name}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {s.count} {s.count === 1 ? "facility" : "facilities"} tracked{" "}
                            &middot; {s.disclosedCount}{" "}
                            {s.disclosedCount === 1 ? "discloses" : "disclose"} capacity
                          </span>
                        </span>
                        <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                          {formatPower(s.operationalMw + s.plannedMw)}
                        </span>
                      </Link>
                    ) : (
                      <div className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                        <span className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm text-foreground truncate">
                            {s.name}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {s.count} {s.count === 1 ? "facility" : "facilities"} tracked{" "}
                            &middot; {s.disclosedCount}{" "}
                            {s.disclosedCount === 1 ? "discloses" : "disclose"} capacity
                          </span>
                        </span>
                        <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                          {formatPower(s.operationalMw + s.plannedMw)}
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No states disclose a capacity figure yet.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
