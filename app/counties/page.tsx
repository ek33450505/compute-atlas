import Link from "next/link";
import type { Metadata } from "next";

import { getAllFacilities, getCounties, type CountySummary } from "@/lib/data";
import { formatCountyLabel } from "@/lib/metros";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Data centers by county",
  description:
    "Browse tracked US data centers, crypto-mining sites, and dedicated generation by county — every county on record, grouped by state, each with a live, source-cited count.",
  alternates: { canonical: "/counties" },
};

interface StateGroup {
  code: string;
  /** Full state name, falling back to the raw code if it isn't a known state. */
  name: string;
  slug: string | undefined;
  counties: CountySummary[];
  facilityCount: number;
}

/**
 * Groups the flat county list into per-state sections. States are ordered by
 * how many tracked counties they have (desc), then name A→Z; counties inside
 * a section keep `getCounties()`'s order, which for a single state is already
 * facility count desc then name A→Z (its sort key is count, then state, then
 * name — with state held constant, the remaining order is exactly that).
 */
function groupByState(counties: CountySummary[]): StateGroup[] {
  const groups = new Map<string, StateGroup>();
  for (const county of counties) {
    let group = groups.get(county.state);
    if (!group) {
      group = {
        code: county.state,
        name: stateNameFromCode(county.state) ?? county.state,
        slug: stateSlugFromCode(county.state),
        counties: [],
        facilityCount: 0,
      };
      groups.set(county.state, group);
    }
    group.counties.push(county);
    group.facilityCount += county.count;
  }
  return [...groups.values()].sort(
    (a, b) => b.counties.length - a.counties.length || a.name.localeCompare(b.name)
  );
}

/**
 * /counties — index hub linking to every per-county landing page
 * (app/counties/[county]/page.tsx). Static server component; counts are live
 * via getCounties(), which reads the shared loadFacilities() cache, so this
 * is one data load rather than one per county.
 *
 * The list is sectioned by state rather than rendered as one flat run: there
 * are hundreds of tracked counties, and county names repeat across states
 * ("Washington" is a county in OR, UT and WA), so an undivided list would be
 * both unnavigable and ambiguous. Each state gets a real heading, so the
 * page is traversable by heading navigation.
 */
export default async function CountiesIndexPage() {
  const [counties, facilities] = await Promise.all([getCounties(), getAllFacilities()]);
  const groups = groupByState(counties);

  const facilitiesInCounties = counties.reduce((sum, c) => sum + c.count, 0);
  // Derived, never hardcoded: a record with no `location.county` on file
  // belongs to no county and so appears in no section below.
  const withoutCounty = facilities.length - facilitiesInCounties;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            counties.map((c) => ({
              name: `${formatCountyLabel(c.name, c.state)}, ${stateNameFromCode(c.state) ?? c.state}`,
              url: `${siteConfig.url}/counties/${c.slug}`,
            }))
          ),
        }}
      />

      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "By county" }]} />

      <PageMasthead
        eyebrow="Counties"
        title="By county"
        dek="Every county with a tracked site, grouped by state. County is where permits are filed, rates are set, and hearings are held — so it is often the level the record actually lives at."
      />

      <SurveyStatRow
        stats={[
          { value: counties.length.toLocaleString(), label: "Counties" },
          { value: groups.length.toLocaleString(), label: "States" },
          { value: facilitiesInCounties.toLocaleString(), label: "In a county" },
        ]}
      />

      <section
        aria-labelledby="counties-overview-heading"
        className="max-w-2xl space-y-4"
      >
        <h2
          id="counties-overview-heading"
          className="font-display text-2xl text-foreground"
        >
          How this lens works
        </h2>
        <p className="text-base leading-relaxed text-muted-foreground">
          A county here is taken straight from each record&rsquo;s own county
          field, not assembled by hand. That makes this lens different from
          the metro lens, which is a curated cluster of counties chosen for
          known activity: every tracked county appears below, however few
          sites it holds.
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          The state code is part of every county URL because county names
          repeat across states — Washington is a county in Oregon, Utah and
          Washington — so a bare county name is not an address.
        </p>
        <p className="text-base leading-relaxed text-muted-foreground">
          {`${withoutCounty.toLocaleString()} tracked ${withoutCounty === 1 ? "record carries" : "records carry"} no county on file, and so ${withoutCounty === 1 ? "appears" : "appear"} in no county below. Those sites are still in the dataset, reachable by state, operator, and map.`}
        </p>
      </section>

      <section aria-labelledby="counties-list-heading" className="space-y-10">
        <h2 id="counties-list-heading" className="sr-only">
          Browse by county
        </h2>

        {groups.map((group) => (
          <section
            key={group.code}
            aria-labelledby={`county-state-${group.code}`}
            className="space-y-4"
          >
            <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
              <h3
                id={`county-state-${group.code}`}
                className="font-display text-xl text-foreground"
              >
                {group.slug ? (
                  <Link
                    href={`/states/${group.slug}`}
                    className="underline-offset-4 transition-colors motion-reduce:transition-none hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                  >
                    {group.name}
                  </Link>
                ) : (
                  group.name
                )}
              </h3>
              <span className="font-mono text-xs text-muted-foreground shrink-0">
                {`${group.counties.length} ${group.counties.length === 1 ? "county" : "counties"} · ${group.facilityCount} ${group.facilityCount === 1 ? "site" : "sites"}`}
              </span>
            </div>

            <ul className="grid gap-2 sm:grid-cols-2">
              {group.counties.map((county) => (
                <li key={county.slug}>
                  <Link
                    href={`/counties/${county.slug}`}
                    className="flex min-h-11 items-baseline justify-between gap-2 rounded-sm border border-border px-4 py-3 transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <span className="text-sm text-foreground truncate min-w-0">
                      {formatCountyLabel(county.name, county.state)}
                    </span>
                    {/* Unit is load-bearing for screen readers: a bare count
                        makes the link announce as "Loudoun County 2, link".
                        Same form as app/metros/page.tsx. */}
                    <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                      {county.count} {county.count === 1 ? "site" : "sites"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
    </div>
  );
}
