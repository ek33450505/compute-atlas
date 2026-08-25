import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getStates,
  getFacilitiesByStateCached,
  getStateSummaryCached,
  getNotableOppositionCases,
  getStateAiClassificationCounts,
} from "@/lib/data";
import {
  stateNameFromCode,
  stateSlugFromCode,
  stateCodeFromSlug,
} from "@/lib/us-states";
import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";
import { formatCapacity, formatLocation, formatPower, AI_CLASSIFICATION_CONFIDENCE_LABELS } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { WatchButton } from "@/components/subscribe/watch-button";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { aiClassificationEnum } from "@/lib/schema";

export const revalidate = false;

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
    alternates: { canonical: `/states/${slug}` },
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

  // Cross-link callout (SEO Task 3.3): only fetched when this state has
  // documented friction, since a zero-friction state renders no callout.
  const stateOppositionCase =
    summary.communityFriction > 0
      ? (await getNotableOppositionCases()).find(
          (f) => f.location.state === code
        )
      : undefined;

  // Cross-link callout (SEO Task 6.3): per-classification AI counts for this
  // state; the callout below renders nothing when the total is zero.
  const aiCounts = await getStateAiClassificationCounts(code);
  const totalAiClassified =
    aiCounts.confirmed + aiCounts.likely + aiCounts.mixed_use;

  const TOP_OPERATORS_DISPLAY = 15;
  const displayedOperators = summary.topOperators.slice(0, TOP_OPERATORS_DISPLAY);
  const extraOperators = summary.topOperators.length - displayedOperators.length;

  // --- Templated overview prose (SEO Task 1.1) ----------------------------
  // Every figure below is read directly off `summary`; nothing here is
  // fetched, invented, or estimated. Each branch just phrases a zero count
  // gracefully instead of printing an awkward "0 MW" / "0 sites" line.
  const hasOperationalMw = summary.operationalMw > 0;
  const hasUnderConstructionMw = summary.underConstructionMw > 0;
  let capacitySentence: string;
  if (hasOperationalMw && hasUnderConstructionMw) {
    capacitySentence = `Operational capacity totals ${formatPower(summary.operationalMw)}, with another ${formatPower(summary.underConstructionMw)} under construction.`;
  } else if (hasOperationalMw) {
    capacitySentence = `Operational capacity totals ${formatPower(summary.operationalMw)}; no additional capacity is currently under construction.`;
  } else if (hasUnderConstructionMw) {
    capacitySentence = `None are operational yet — ${formatPower(summary.underConstructionMw)} is under construction.`;
  } else {
    capacitySentence = "None have reported operational capacity or an active construction phase yet.";
  }
  const overviewSentence = `Compute Atlas tracks ${summary.count} data center${summary.count === 1 ? "" : "s"} in ${stateName}. ${capacitySentence}`;

  const frictionSentence =
    summary.communityFriction > 0
      ? `${summary.communityFriction} site${summary.communityFriction === 1 ? "" : "s"} in ${stateName} face${summary.communityFriction === 1 ? "s" : ""} documented community friction — contested, opposed, or in active litigation — out of ${summary.communityReporting} with a sourced community status.`
      : `No tracked site in ${stateName} carries a documented community-friction status yet.`;

  const topOperatorNames = summary.topOperators.slice(0, 3).map((o) => o.operator);
  const operatorSentence =
    topOperatorNames.length > 0
      ? `The leading operator${topOperatorNames.length === 1 ? "" : "s"} in ${stateName}, by facility count, ${topOperatorNames.length === 1 ? "is" : "are"} ${new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(topOperatorNames)}.`
      : null;

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
          Data centers in {stateName}
        </h1>
        <p className="text-base text-muted-foreground">
          {stateName} &middot; {summary.count} facilit{summary.count === 1 ? "y" : "ies"} tracked
        </p>
        <WatchButton targetType="state" targetId={code} label={`Watch ${stateName}`} />
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Overview (SEO: templated, dataset-derived prose — no new fields)    */}
      {/* ------------------------------------------------------------------ */}
      <div className="max-w-2xl space-y-4">
        <p className="text-base leading-relaxed text-muted-foreground">
          {overviewSentence}
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          {frictionSentence}
        </p>
        {operatorSentence && (
          <p className="text-base leading-relaxed text-muted-foreground">
            {operatorSentence}
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
          { value: formatPower(summary.plannedMw), label: "Planned pipeline" },
          {
            value: formatPower(summary.underConstructionMw),
            label: "Under construction",
          },
        ]}
      />

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

        {summary.communityFriction > 0 && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            See the{" "}
            <Link
              href="/opposition"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              opposition tracker
            </Link>{" "}
            for national context
            {stateOppositionCase ? (
              <>
                , including{" "}
                <Link
                  href={`/facilities/${stateOppositionCase.id}`}
                  className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                >
                  {stateOppositionCase.name}
                </Link>
                , a notable case in {stateName}.
              </>
            ) : (
              "."
            )}
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* § AI classification (SEO Task 6.3): cross-link callout, mirrors the */}
      {/* Community-reception callout's conditional-render approach — renders */}
      {/* nothing when this state has no AI-classified facilities.           */}
      {/* ------------------------------------------------------------------ */}
      {totalAiClassified > 0 && (
        <section
          aria-labelledby="ai-classification-heading"
          className="space-y-6 border-t border-border pt-10"
        >
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § AI classification
          </p>
          <h2
            id="ai-classification-heading"
            className="font-display text-2xl text-foreground"
          >
            AI-classified facilities
          </h2>
          <div className="flex flex-col gap-1">
            <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
              {totalAiClassified}
            </span>
            <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Data center{totalAiClassified === 1 ? "" : "s"} with an AI classification
            </span>
          </div>
          <ul className="space-y-2 text-sm">
            {aiClassificationEnum.options
              .filter((key) => aiCounts[key] > 0)
              .map((key) => (
                <li key={key} className="flex items-baseline justify-between gap-2">
                  <span className="text-foreground">
                    {AI_CLASSIFICATION_CONFIDENCE_LABELS[key]}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {aiCounts[key]}
                  </span>
                </li>
              ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            See the{" "}
            <Link
              href="/ai"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              AI data center hub
            </Link>{" "}
            for national context, or browse the{" "}
            <Link
              href="#facilities-heading"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              full facility list for {stateName}
            </Link>{" "}
            below.
          </p>
        </section>
      )}

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
