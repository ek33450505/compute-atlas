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
import { formatCapacity, formatLocation, formatPower } from "@/lib/format";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { breadcrumbJsonLdString, itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

export const revalidate = 3600;

/** A state capacity ranking row enriched with display name + route slug. */
type StateRow = StateCapacityRanking & { name: string; slug: string | undefined };

const CRUMBS = [{ label: "Explore", href: "/explore" }, { label: "Rankings" }];

export const metadata: Metadata = {
  title: "Data center rankings",
  description:
    "The biggest tracked data center projects, largest operators, and states with the most capacity — ranked by tracked capacity, each entry source-cited.",
  alternates: { canonical: "/rankings" },
};

/**
 * /rankings — capacity rankings hub. Static server component.
 *
 * Three ranked dimensions over the same dataset: biggest individual projects
 * by planned capacity, largest operators by combined capacity, and states
 * with the most tracked capacity. Deliberately a single page (not
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString(
            CRUMBS.map((c) => ({ name: c.label, url: c.href }))
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            topProjects.map((f) => ({
              name: f.name,
              url: `${siteConfig.url}/facilities/${f.id}`,
            }))
          ),
        }}
      />

      <Breadcrumb items={CRUMBS} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Rankings
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Biggest data center projects, largest operators, top states
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          The compute buildout, ranked by tracked capacity.
        </p>
        <div className="border-t border-border" />
      </header>

      {stats.count === 0 ? (
        <p className="text-base text-muted-foreground">
          No facilities are tracked yet.
        </p>
      ) : (
        <>
          {/* ------------------------------------------------------------------ */}
          {/* Overview prose                                                      */}
          {/* ------------------------------------------------------------------ */}
          <div className="max-w-2xl space-y-4">
            <p className="text-base leading-relaxed text-muted-foreground">
              Three views over the same{" "}
              {stats.count.toLocaleString("en-US")}-facility dataset: the
              single largest projects by disclosed planned capacity, the
              operators with the most capacity across all their sites, and
              the states hosting the most capacity overall. Each ranking is
              ordered by tracked megawatts — not by press coverage or
              announcement size — and reflects only what a cited source
              discloses. These rankings cover only the facilities that disclose
              a capacity figure — a site absent from them may be large but
              undisclosed, not small.
            </p>
            <p className="text-base leading-relaxed text-muted-foreground">
              Every entry below links through to its full facility, operator,
              or state record and cited sources.
            </p>
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* Survey stats row                                                    */}
          {/* ------------------------------------------------------------------ */}
          <div className="flex flex-wrap gap-8 border-b border-border pb-10">
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {stats.count}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Facilities
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {stats.states}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                States
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
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* § Biggest projects                                                  */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="projects-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <div className="space-y-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                § Biggest projects
              </p>
              <h2 id="projects-heading" className="font-display text-2xl text-foreground">
                Biggest data center projects
              </h2>
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
                    <Link
                      href={`/facilities/${f.id}`}
                      className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm text-foreground truncate">
                          {f.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {f.operator} &middot; {formatLocation(f)}
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
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No facilities disclose a planned-capacity figure yet.
              </p>
            )}
          </section>

          {/* ------------------------------------------------------------------ */}
          {/* § Largest operators                                                */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="operators-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <div className="space-y-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                § Largest operators
              </p>
              <h2 id="operators-heading" className="font-display text-2xl text-foreground">
                Largest data center operators
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              Operators ranked by combined capacity — operational plus
              planned — summed across every site they run in the dataset.
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
                          {o.count} {o.count === 1 ? "facility" : "facilities"} tracked
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

          {/* ------------------------------------------------------------------ */}
          {/* § States with the most capacity                                    */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="states-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <div className="space-y-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                § States with the most capacity
              </p>
              <h2 id="states-heading" className="font-display text-2xl text-foreground">
                States with the most data center capacity
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              States ranked by combined capacity — operational plus planned —
              summed across every facility tracked there.
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
                            {s.count} {s.count === 1 ? "facility" : "facilities"} tracked
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
                            {s.count} {s.count === 1 ? "facility" : "facilities"} tracked
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
