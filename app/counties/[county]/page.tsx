import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getCounties, getCountyBySlug, getFacilitiesByCounty } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { formatCountyLabel } from "@/lib/metros";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import type { Facility } from "@/lib/schema";
import { CollectionPage } from "@/components/collection/collection-page";

export const revalidate = 3600;

function sumOperationalMw(facilities: Facility[]): number {
  return facilities.reduce((sum, f) => sum + (f.capacityMw?.operational ?? 0), 0);
}

function sumPlannedMw(facilities: Facility[]): number {
  return facilities.reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
}

/**
 * The most frequently occurring operators among a county's facilities, most
 * frequent first — a lightweight "who's building here" signal for the intro
 * prose. Facilities without an operator set are excluded. Same helper, same
 * reasoning, as app/metros/[metro]/page.tsx.
 */
function topOperatorsFor(facilities: Facility[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const f of facilities) {
    if (!f.operator) continue;
    counts.set(f.operator, (counts.get(f.operator) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

/** Joins strings in natural English: "A", "A and B", "A, B, and C". */
function humanJoin(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * One static param per tracked county — all of them, including the 354 with a
 * single facility. The sitemap deliberately submits only the multi-facility
 * subset (see MIN_FACILITIES_FOR_COUNTY_SITEMAP in app/sitemap.ts), but every
 * county hub stays generated, live, crawlable and internally linked.
 */
export async function generateStaticParams() {
  const counties = await getCounties();
  return counties.map((c) => ({ county: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ county: string }>;
}): Promise<Metadata> {
  const { county: slug } = await params;
  const county = await getCountyBySlug(slug);
  if (!county) {
    return { title: "County not found" };
  }

  const facilities = await getFacilitiesByCounty(slug);
  const label = formatCountyLabel(county.name, county.state);
  const stateName = stateNameFromCode(county.state) ?? county.state;

  return {
    title: `Data centers in ${label}, ${stateName}`,
    description: `${facilities.length} data centers and compute facilities tracked in ${label}, ${stateName} — capacity, build status, operators, and a public source for every figure.`,
    alternates: { canonical: `/counties/${slug}` },
  };
}

/**
 * /counties/[county] — SEO landing page for one county. Unlike a metro (a
 * hand-picked cluster of counties), a county here is taken straight from each
 * record's `location.county`, so this lens covers the whole dataset rather
 * than a curated slice. Static server component generated at build time for
 * every tracked county via generateStaticParams; renders live data through
 * the CollectionPage primitive, so counts and the facility grid are never
 * hardcoded. Structurally mirrors app/metros/[metro]/page.tsx.
 */
export default async function CountyPage({
  params,
}: {
  params: Promise<{ county: string }>;
}) {
  const { county: slug } = await params;
  const county = await getCountyBySlug(slug);
  if (!county) {
    notFound();
  }

  const facilities = await getFacilitiesByCounty(slug);
  const label = formatCountyLabel(county.name, county.state);
  const stateName = stateNameFromCode(county.state) ?? county.state;
  const stateSlug = stateSlugFromCode(county.state);
  const operationalMw = sumOperationalMw(facilities);
  const plannedMw = sumPlannedMw(facilities);
  const topOperators = topOperatorsFor(facilities);

  // Second paragraph: an operational-vs-planned capacity read, phrased
  // conditionally so a county with no disclosed megawatts never claims a
  // figure it doesn't have (facilities.length === 0 is covered by
  // emptyMessage).
  const capacityLine =
    facilities.length === 0
      ? null
      : operationalMw > 0 && plannedMw > 0
        ? `${formatPower(operationalMw)} of capacity is operational today in ${label}, with ${formatPower(plannedMw)} more planned or under construction.`
        : operationalMw > 0
          ? `${formatPower(operationalMw)} of capacity is operational today in ${label}.`
          : plannedMw > 0
            ? `${formatPower(plannedMw)} of capacity is planned or under construction in ${label}, with none operational yet.`
            : null;

  // Third paragraph: which operators show up most often here — omitted
  // entirely when no facility in the county has an operator on file.
  const operatorLine =
    topOperators.length === 0
      ? null
      : topOperators.length === 1
        ? `${topOperators[0]} is the most active operator on file in ${label}.`
        : `${humanJoin(topOperators)} are among the most active operators on file in ${label}.`;

  // County names repeat across states — "Washington" is a county in nine of
  // them, Montgomery and Jefferson in six each, covering 203 of the 636 hubs.
  // The <title> tag (generateMetadata above) has always disambiguated by
  // state; the H1, the breadcrumb trail and the empty-state message must say
  // the same thing, or nine pages ship an identical headline and an identical
  // crumb trail differing only in body prose. That is a near-duplicate signal
  // on a lens whose whole purpose is search surface — the same failure
  // MIN_FACILITIES_FOR_COUNTY_SITEMAP exists to avoid, arriving by another
  // door. The intro keeps its own state mention because that one is a LINK to
  // the state hub: prose doing internal-linking work, not a second heading.
  const qualifiedLabel = `${label}, ${stateName}`;

  return (
    <CollectionPage
      title={`Data centers in ${qualifiedLabel}`}
      intro={
        <>
          <p>
            {`Compute Atlas tracks ${facilities.length} data center${facilities.length === 1 ? "" : "s"} in ${label}, `}
            {stateSlug ? (
              <Link
                href={`/states/${stateSlug}`}
                className="underline-offset-4 transition-colors motion-reduce:transition-none hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                {stateName}
              </Link>
            ) : (
              stateName
            )}
            {" — each traced to a public source."}
          </p>
          {capacityLine && <p>{capacityLine}</p>}
          {operatorLine && <p>{operatorLine}</p>}
        </>
      }
      crumbs={[
        { label: "Explore", href: "/explore" },
        { label: "By county", href: "/counties" },
        { label: qualifiedLabel },
      ]}
      statRow={[
        { label: "Facilities", value: String(facilities.length) },
        { label: "Operational", value: formatPower(operationalMw) },
        { label: "Planned", value: formatPower(plannedMw) },
      ]}
      facilities={facilities}
      emptyMessage={`No facilities are on file yet for ${qualifiedLabel}.`}
    />
  );
}
