import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getOperators,
  getFacilitiesByOperator,
  getOperatorSummary,
  operatorSlug,
  getOperatorBySlug,
} from "@/lib/data";
import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";
import { formatCapacity, formatLocation } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Avoids "0.0 GW" for small operators. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

export function generateStaticParams() {
  return getOperators().map((name) => ({ operator: operatorSlug(name) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ operator: string }>;
}): Promise<Metadata> {
  const { operator: slug } = await params;
  const operatorName = getOperatorBySlug(slug);
  const summary = operatorName ? getOperatorSummary(operatorName) : null;

  if (!operatorName || !summary) {
    return { title: "Operator not found" };
  }

  return {
    title: operatorName,
    description: `${summary.count} data centers and compute facilities operated by ${operatorName} across ${summary.stateCount} state(s) — capacity, build status, and locations, each with a public source.`,
  };
}

/**
 * /operators/[operator] — per-operator landing page. Static server component.
 *
 * Generated at build time for all tracked operators via generateStaticParams.
 * Mirrors /states/[state] scoped to one operator: masthead, survey-stat row,
 * § progress-bar sections, plus a facilities list for internal SEO linking.
 */
export default async function OperatorPage({
  params,
}: {
  params: Promise<{ operator: string }>;
}) {
  const { operator: slug } = await params;
  const operatorName = getOperatorBySlug(slug);
  if (!operatorName) {
    notFound();
  }

  const summary = getOperatorSummary(operatorName);
  if (!summary) {
    notFound();
  }

  const facilities = getFacilitiesByOperator(operatorName);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Operators", href: "/operators" }, { label: operatorName }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Operator profile
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          {operatorName}
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
            Pipeline
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {summary.stateCount}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            States
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
          Facilities operated by {operatorName}
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
                    {formatLocation(f)}
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
