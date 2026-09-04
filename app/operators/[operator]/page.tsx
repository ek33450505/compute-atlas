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
import { formatLocation, formatPower } from "@/lib/format";
import { Breadcrumb } from "@/components/breadcrumb";
import { CollectionJsonLd } from "@/components/collection/collection-json-ld";
import { FacilityListRow } from "@/components/facility-list-row";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { PercentageBar } from "@/components/percentage-bar";
import { SectionHeading } from "@/components/section-heading";

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

  const crumbs = [
    { label: "Explore", href: "/explore" },
    { label: "Operators", href: "/operators" },
    { label: operatorName },
  ];

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <CollectionJsonLd crumbs={crumbs} facilities={facilities} />

      <Breadcrumb items={crumbs} />

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
          <SectionHeading kicker="By type" id="facility-type-heading" title="Facility type" />
          <div className="space-y-4">
            {FACILITY_TYPE_ORDER.filter((key) => summary.byType[key] > 0).map(
              (key) => {
                const count = summary.byType[key];
                const pct = summary.count > 0 ? (count / summary.count) * 100 : 0;
                return (
                  <PercentageBar
                    key={key}
                    label={FACILITY_TYPE_META[key].label}
                    valueLabel={
                      <>
                        {count} &middot; {pct.toFixed(0)}%
                      </>
                    }
                    pct={pct}
                  />
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
        <SectionHeading kicker="By status" id="status-heading" title="Lifecycle status" />
        <div className="space-y-4">
          {STATUS_ORDER.filter((status) => summary.byStatus[status] > 0).map(
            (status) => {
              const count = summary.byStatus[status];
              const pct = summary.count > 0 ? (count / summary.count) * 100 : 0;
              return (
                <PercentageBar
                  key={status}
                  label={STATUS_META[status].label}
                  valueLabel={
                    <>
                      {count} &middot; {pct.toFixed(0)}%
                    </>
                  }
                  pct={pct}
                  color={getStatusColor(status)}
                  opacity={1}
                  transition
                />
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
        <SectionHeading kicker="Facilities" id="facilities-heading" title={<>Facilities operated by {operatorName}</>} />
        <ul className="divide-y divide-border">
          {facilities.map((f) => (
            <li key={f.id}>
              <FacilityListRow facility={f} secondary={formatLocation(f)} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
