import Link from "next/link";
import type { Metadata } from "next";

import { getStates, getStateSummary, getAllFacilities } from "@/lib/data";
import { formatPower } from "@/lib/format";
import {
  stateNameFromCode,
  stateSlugFromCode,
  statesStat,
  splitJurisdictions,
} from "@/lib/us-states";
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

/** One jurisdiction's row on this page: a resolved name/slug plus its facility summary. */
type JurisdictionEntry = {
  code: string;
  name: string;
  slug: string;
  summary: NonNullable<Awaited<ReturnType<typeof getStateSummary>>>;
};

/**
 * Resolves a list of `location.state` codes into renderable rows, sorted by
 * facility count desc (tie-break: name A→Z). `splitJurisdictions` already
 * drops any code that is neither a recognized state, DC, nor a territory, so
 * `stateNameFromCode`/`stateSlugFromCode` should always resolve here — but
 * this list feeds public URLs and JSON-LD, so an entry that fails to resolve
 * is filtered out rather than rendered as a broken `/states/undefined` link
 * (the non-null assertions this replaced would have shipped exactly that).
 */
async function buildRows(codes: string[]): Promise<JurisdictionEntry[]> {
  const rows = await Promise.all(
    codes.map(async (code): Promise<JurisdictionEntry | undefined> => {
      const name = stateNameFromCode(code);
      const slug = stateSlugFromCode(code);
      const summary = await getStateSummary(code);
      if (name === undefined || slug === undefined || summary === null) {
        return undefined;
      }
      return { code, name, slug, summary };
    })
  );
  return rows
    .filter((row): row is JurisdictionEntry => row !== undefined)
    .sort(
      (a, b) => b.summary.count - a.summary.count || a.name.localeCompare(b.name)
    );
}

/** The shared card link used by both jurisdiction lists on this page. */
function JurisdictionCard({ name, slug, summary }: JurisdictionEntry) {
  return (
    <Link
      href={`/states/${slug}`}
      className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm text-foreground truncate">{name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {formatPower(summary.operationalMw)} operational
        </span>
      </span>
      <span className="font-mono tabular-nums text-sm text-muted-foreground shrink-0">
        {summary.count}
      </span>
    </Link>
  );
}

/**
 * /states — index of all tracked jurisdictions. Static server component.
 *
 * Two groups, both linking to /states/[state]: the 50 states (ranked by
 * facility count desc, tie-break name A→Z), and — in a section of their own
 * — DC plus any tracked US territories, sorted the same way. DC groups with
 * the territories rather than the states because the organizing principle is
 * membership of the 50, not statehood-adjacency.
 */
export default async function StatesIndexPage() {
  const codes = await getStates();
  const split = splitJurisdictions(codes);
  const statesTile = statesStat(codes);

  const [stateRows, otherRows] = await Promise.all([
    buildRows(split.states),
    buildRows(split.other),
  ]);
  const allRows = [...stateRows, ...otherRows];

  const totalFacilities = (await getAllFacilities()).length;
  const totalOperationalMw = allRows.reduce(
    (sum, r) => sum + r.summary.operationalMw,
    0
  );
  const totalPlannedMw = allRows.reduce(
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
            allRows.map(({ name, slug }) => ({
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
          { value: statesTile.value.toLocaleString(), label: statesTile.label },
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
          The 50 states
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {stateRows.map((row) => (
            <li key={row.code}>
              <JurisdictionCard {...row} />
            </li>
          ))}
        </ul>
      </section>

      {split.other.length > 0 && (
        <section
          aria-labelledby="other-jurisdictions-heading"
          className="space-y-4"
        >
          <div className="max-w-2xl space-y-4">
            <h2
              id="other-jurisdictions-heading"
              className="font-display text-2xl text-foreground"
            >
              District of Columbia and U.S. territories
            </h2>
            <p className="text-base leading-relaxed text-muted-foreground">
              Compute Atlas tracks these places exactly like it tracks a
              state — the same sourcing, the same record shape — but none of
              them is one of the 50, so they are counted separately here
              rather than folded into the ranking above.
            </p>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {otherRows.map((row) => (
              <li key={row.code}>
                <JurisdictionCard {...row} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
