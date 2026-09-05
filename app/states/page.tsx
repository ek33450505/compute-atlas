import Link from "next/link";
import type { Metadata } from "next";

import { getStates, getStateSummary, getAllFacilities } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Data centers by state",
  description:
    "Browse the U.S. grid-scale compute buildout state by state — facility counts, capacity, and build status, each record source-cited.",
  alternates: { canonical: "/states" },
};

/**
 * /states — index of all tracked states. Static server component.
 *
 * Links to /states/[state] for each state with at least one tracked
 * facility, sorted by facility count desc (tie-break: name A→Z).
 */
export default async function StatesIndexPage() {
  const codes = await getStates();
  const rows = (
    await Promise.all(
      codes.map(async (code) => ({
        code,
        name: stateNameFromCode(code)!,
        slug: stateSlugFromCode(code)!,
        summary: (await getStateSummary(code))!,
      }))
    )
  ).sort(
    (a, b) =>
      b.summary.count - a.summary.count || a.name.localeCompare(b.name)
  );

  const totalFacilities = (await getAllFacilities()).length;
  const totalOperationalMw = rows.reduce(
    (sum, r) => sum + r.summary.operationalMw,
    0
  );
  const totalPlannedMw = rows.reduce(
    (sum, r) => sum + r.summary.plannedMw,
    0
  );

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
              url: `${siteConfig.url}/states/${slug}`,
            }))
          ),
        }}
      />
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "States" }]} />

      <PageMasthead
        eyebrow="By geography"
        title="States"
        dek="Where the buildout is landing. Every state with at least one tracked facility, ranked by how many sites it carries. Capacity is shown where operators disclose it — most don’t, so the megawatt figures rank a subset, not the field."
      />

      <SurveyStatRow
        stats={[
          { value: rows.length.toLocaleString(), label: "States" },
          { value: totalFacilities.toLocaleString(), label: "Facilities" },
          { value: formatPower(totalOperationalMw), label: "Operational" },
          { value: formatPower(totalPlannedMw), label: "Pipeline" },
        ]}
      />

      <section
        aria-labelledby="states-overview-heading"
        className="max-w-2xl space-y-4"
      >
        <h2
          id="states-overview-heading"
          className="font-display text-2xl text-foreground"
        >
          What the ranking does and doesn&apos;t say
        </h2>
        <p className="text-base leading-relaxed text-muted-foreground">
          Facility count is the honest default: it ranks what the dataset
          actually knows. Sorting by megawatts would rank disclosure instead
          — a state with three documented gigawatt campuses would outrank
          one with forty sites whose operators never published a figure.
          Both numbers are here; only one of them is close to complete.
        </p>
      </section>

      <section aria-labelledby="states-list-heading" className="space-y-4">
        <h2 id="states-list-heading" className="sr-only">
          All tracked states
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map(({ code, name, slug, summary }) => (
            <li key={code}>
              <Link
                href={`/states/${slug}`}
                className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm text-foreground truncate">
                    {name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatPower(summary.operationalMw)} operational
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
    </div>
  );
}
