import Link from "next/link";
import type { Metadata } from "next";

import { getOperators, getOperatorSummary, getAllFacilities, operatorSlug } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Data centers by operator",
  description:
    "Browse the U.S. compute buildout by operator — every company running tracked data-center, crypto-mining, or power-generation capacity, each record source-cited.",
  alternates: { canonical: "/operators" },
};

/**
 * /operators — index of all tracked operators. Static server component.
 *
 * Links to /operators/[operator] for each operator with at least one tracked
 * facility, sorted by total capacity (operational + planned) desc — many top
 * operators are planned-only buildouts, so operational alone would bury them
 * (tie-break: facility count desc, then name A→Z). Operators with zero
 * disclosed capacity are split into a collapsed <details> toggle below the
 * main grid rather than diluting it.
 */
export default async function OperatorsIndexPage() {
  const operatorNames = await getOperators();
  const rows = (
    await Promise.all(
      operatorNames.map(async (name) => {
        const summary = (await getOperatorSummary(name))!;
        return {
          name,
          slug: operatorSlug(name),
          summary,
          total: summary.operationalMw + summary.plannedMw,
        };
      })
    )
  ).sort(
    (a, b) =>
      b.total - a.total ||
      b.summary.count - a.summary.count ||
      a.name.localeCompare(b.name)
  );

  const disclosed = rows.filter((r) => r.total > 0);
  const undisclosed = rows.filter((r) => r.total === 0);
  const totalDisclosedMw = disclosed.reduce((sum, r) => sum + r.total, 0);

  const totalFacilities = (await getAllFacilities()).length;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            rows.map(({ name, slug }) => ({
              name,
              url: `${siteConfig.url}/operators/${slug}`,
            }))
          ),
        }}
      />
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Operators" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead
        eyebrow="By operator"
        title="Operators"
        dek="Who is building it. Every company running tracked capacity, ranked by disclosed megawatts. Operators with no disclosed figure are listed separately — undisclosed is not the same as small."
      />

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <SurveyStatRow
        stats={[
          { value: rows.length.toLocaleString(), label: "Operators" },
          { value: disclosed.length.toLocaleString(), label: "With capacity" },
          { value: totalFacilities.toLocaleString(), label: "Facilities" },
          { value: formatPower(totalDisclosedMw), label: "Disclosed" },
        ]}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Overview prose                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="operators-overview-heading"
        className="max-w-2xl space-y-4"
      >
        <h2
          id="operators-overview-heading"
          className="font-display text-2xl text-foreground"
        >
          Why the list is split
        </h2>
        <p className="text-base leading-relaxed text-muted-foreground">
          Operators are ranked by operational plus planned capacity, because
          much of the largest buildout is still unbuilt — ranking on
          operational alone would bury the companies with the biggest
          pipelines. Companies that have never published a megawatt figure
          sit in their own list below rather than at rank zero, where they
          would read as small rather than silent.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Operator grid                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="operators-list-heading" className="space-y-4">
        <h2 id="operators-list-heading" className="sr-only">
          All tracked operators
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {disclosed.map(({ name, slug, summary, total }) => (
            <li key={slug}>
              <Link
                href={`/operators/${slug}`}
                className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm text-foreground truncate">
                    {name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatPower(total)} total
                  </span>
                </span>
                <span className="font-mono tabular-nums text-sm text-muted-foreground shrink-0">
                  {summary.count}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Zero-capacity operators — collapsed by default                     */}
      {/* ------------------------------------------------------------------ */}
      {undisclosed.length > 0 && (
        <details className="group border-t border-border pt-6">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Show {undisclosed.length} operators with no disclosed capacity
            <span
              aria-hidden="true"
              className="transition-transform motion-reduce:transition-none group-open:rotate-90"
            >
              →
            </span>
          </summary>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {undisclosed.map(({ name, slug, summary }) => (
              <li key={slug}>
                <Link
                  href={`/operators/${slug}`}
                  className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm text-foreground truncate">
                      {name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      No disclosed capacity
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-sm text-muted-foreground shrink-0">
                    {summary.count}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
