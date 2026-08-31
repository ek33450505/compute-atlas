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
import { formatCapacity, formatLocation, formatPower } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";

export const revalidate = 3600;

export async function generateStaticParams() {
  const names = await getOperators();
  return names.map((name) => ({ operator: operatorSlug(name) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ operator: string }>;
}): Promise<Metadata> {
  const { operator: slug } = await params;
  const operatorName = await getOperatorBySlug(slug);
  const summary = operatorName ? await getOperatorSummary(operatorName) : null;

  if (!operatorName || !summary) {
    return { title: "Operator not found" };
  }

  return {
    title: `${operatorName} data centers`,
    description: `${summary.count} data centers and compute facilities operated by ${operatorName} across ${summary.stateCount} state(s) — capacity, build status, and locations, each with a public source.`,
    alternates: { canonical: `/operators/${slug}` },
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
  const operatorName = await getOperatorBySlug(slug);
  if (!operatorName) {
    notFound();
  }

  const summary = await getOperatorSummary(operatorName);
  if (!summary) {
    notFound();
  }

  const facilities = await getFacilitiesByOperator(operatorName);

  // --- Templated overview prose (SEO Task 2.1) -----------------------------
  // Every figure below is read directly off `summary`/`facilities`; nothing
  // here is fetched, invented, or estimated. Each branch just phrases a zero
  // count gracefully instead of printing an awkward "0 MW" boast.
  const hasOperationalMw = summary.operationalMw > 0;
  const hasPlannedMw = summary.plannedMw > 0;
  let capacitySentence: string;
  if (hasOperationalMw && hasPlannedMw) {
    capacitySentence = `Operational capacity totals ${formatPower(summary.operationalMw)}, with another ${formatPower(summary.plannedMw)} planned or under construction.`;
  } else if (hasOperationalMw) {
    capacitySentence = `Operational capacity totals ${formatPower(summary.operationalMw)}; nothing further is currently planned or under construction.`;
  } else if (hasPlannedMw) {
    capacitySentence = `None are operational yet — ${formatPower(summary.plannedMw)} is planned or under construction.`;
  } else {
    capacitySentence = "None have reported operational capacity or an active build phase yet.";
  }
  const overviewSentence = `Compute Atlas tracks ${summary.count} facilit${summary.count === 1 ? "y" : "ies"} operated by ${operatorName} across ${summary.stateCount} state${summary.stateCount === 1 ? "" : "s"}. ${capacitySentence}`;

  const topFacilityNames = facilities.slice(0, 3).map((f) => f.name);
  const facilitySentence =
    topFacilityNames.length > 0
      ? `The largest tracked site${topFacilityNames.length === 1 ? "" : "s"}, by capacity, ${topFacilityNames.length === 1 ? "is" : "are"} ${new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(topFacilityNames)}.`
      : null;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Operators", href: "/operators" }, { label: operatorName }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead
        eyebrow="Operator profile"
        title={<>{operatorName} data centers</>}
        dek={
          <>
            {summary.count} facilit{summary.count === 1 ? "y" : "ies"} tracked
          </>
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* Overview (SEO: templated, dataset-derived prose — no new fields)    */}
      {/* ------------------------------------------------------------------ */}
      <div className="max-w-2xl space-y-4">
        <p className="text-base leading-relaxed text-muted-foreground">
          {overviewSentence}
        </p>
        {facilitySentence && (
          <p className="text-base leading-relaxed text-muted-foreground">
            {facilitySentence}
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <SurveyStatRow
        stats={[
          { value: summary.count, label: "Sites" },
          { value: formatPower(summary.operationalMw), label: "Operational" },
          { value: formatPower(summary.plannedMw), label: "Pipeline" },
          { value: summary.stateCount, label: "States" },
        ]}
      />

      <p className="text-sm leading-relaxed text-muted-foreground">
        Capacity is disclosed for {summary.capacityReporting} of the{" "}
        {summary.count} sites operated by {operatorName}. The megawatt
        figures above sum those records only — read them as a floor, not an
        operator total.
      </p>

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
