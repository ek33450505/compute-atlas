import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getStates,
  getFacilitiesByStateCached,
  getStateSummaryCached,
} from "@/lib/data";
import {
  stateNameFromCode,
  stateSlugFromCode,
  stateCodeFromSlug,
} from "@/lib/us-states";
import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";
import { formatCapacity, formatLocation } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";

export const revalidate = false;

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Avoids "0.0 GW" for small states. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

export async function generateStaticParams() {
  const codes = await getStates();
  return codes
    .map((code) => stateSlugFromCode(code))
    .filter((slug): slug is string => slug !== undefined)
    .map((slug) => ({ state: slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string }>;
}): Promise<Metadata> {
  const { state: slug } = await params;
  const code = stateCodeFromSlug(slug);
  const summary = code ? await getStateSummaryCached(code) : null;

  if (!code || !summary) {
    return { title: "State not found" };
  }

  const stateName = stateNameFromCode(code)!;

  return {
    title: `Data centers in ${stateName}`,
    description: `${summary.count} data centers and compute facilities tracked in ${stateName} — capacity, build status, operators, and community reception, each with a public source.`,
  };
}

/**
 * /states/[state] — per-state landing page. Static server component.
 *
 * Generated at build time for all 48 states with tracked facilities via
 * generateStaticParams. Mirrors the /stats visual language (masthead,
 * survey-stat row, § progress-bar sections) scoped to one state, plus a
 * facilities list for internal SEO linking.
 */
export default async function StatePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state: slug } = await params;
  const code = stateCodeFromSlug(slug);
  if (!code) {
    notFound();
  }

  const summary = await getStateSummaryCached(code);
  if (!summary) {
    notFound();
  }

  const facilities = await getFacilitiesByStateCached(code);
  const stateName = stateNameFromCode(code)!;

  const TOP_OPERATORS_DISPLAY = 15;
  const displayedOperators = summary.topOperators.slice(0, TOP_OPERATORS_DISPLAY);
  const extraOperators = summary.topOperators.length - displayedOperators.length;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "States", href: "/states" }, { label: stateName }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          State profile
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          {stateName}
        </h1>
        <p className="text-base text-muted-foreground">
          {summary.count} facilit{summary.count === 1 ? "y" : "ies"} tracked
        </p>
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap gap-8 border-b border-border pb-10">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {summary.count}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Sites
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {formatPower(summary.operationalMw)}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Operational
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {formatPower(summary.plannedMw)}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Planned pipeline
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {formatPower(summary.underConstructionMw)}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Under construction
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* § By type                                                           */}
      {/* ------------------------------------------------------------------ */}
      {summary.count > 0 && (
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
          <div className="space-y-4">
            {FACILITY_TYPE_ORDER.filter((key) => summary.byType[key] > 0).map(
              (key) => {
                const count = summary.byType[key];
                const pct = summary.count > 0 ? (count / summary.count) * 100 : 0;
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
              }
            )}
          </div>
        </section>
      )}

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
        <h2 id="status-heading" className="font-display text-2xl text-foreground">
          Lifecycle status
        </h2>
        <div className="space-y-4">
          {STATUS_ORDER.filter((status) => summary.byStatus[status] > 0).map(
            (status) => {
              const count = summary.byStatus[status];
              const pct = summary.count > 0 ? (count / summary.count) * 100 : 0;
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
            }
          )}
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

        {summary.communityReporting > 0 ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {summary.communityFriction}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Sites facing documented community friction
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              Contested, opposed, or in active litigation &middot; out of{" "}
              {summary.communityReporting} with a sourced community status.
            </p>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            No documented community reception is on file yet for the tracked
            sites in {stateName}.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Operators                                                         */}
      {/* ------------------------------------------------------------------ */}
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
          Operators
        </h2>
        <ul className="space-y-2 text-sm">
          {displayedOperators.map(({ operator, count }) => (
            <li key={operator} className="flex items-baseline justify-between gap-2">
              <span className="text-foreground truncate min-w-0 pr-2">
                {operator}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                {count}
              </span>
            </li>
          ))}
        </ul>
        {extraOperators > 0 && (
          <p className="text-sm text-muted-foreground">
            + {extraOperators} more operator{extraOperators === 1 ? "" : "s"}
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § Facilities                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="facilities-heading"
        className="space-y-4 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Facilities
        </p>
        <h2
          id="facilities-heading"
          className="font-display text-2xl text-foreground"
        >
          Facilities in {stateName}
        </h2>
        <ul className="divide-y divide-border">
          {facilities.map((f) => (
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
        </ul>
      </section>
    </div>
  );
}
