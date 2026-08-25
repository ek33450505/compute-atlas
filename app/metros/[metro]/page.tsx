import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getFacilitiesByMetro } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { getMetroBySlug, METROS, type Metro } from "@/lib/metros";
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
 * The most frequently occurring operators among a metro's facilities, most
 * frequent first — a lightweight "who's building here" signal for the intro
 * prose. Facilities without an operator set are excluded.
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
 * Distinct constituent county names for a metro, in first-appearance order,
 * human-joined — e.g. "Loudoun, Prince William, Fauquier, and Fairfax" for
 * Northern Virginia. Metro.counties is a [stateCode, countyName][] list, so
 * a metro spanning one state can repeat nothing but a multi-state metro's
 * counties are still just county names here (state is carried separately).
 */
function countyListFor(metro: Metro): string {
  const names = [...new Set(metro.counties.map(([, county]) => county))];
  return humanJoin(names);
}

export async function generateStaticParams() {
  return METROS.map((m) => ({ metro: m.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ metro: string }>;
}): Promise<Metadata> {
  const { metro: slug } = await params;
  const metro = getMetroBySlug(slug);
  if (!metro) {
    return { title: "Metro not found" };
  }

  const facilities = await getFacilitiesByMetro(slug);

  return {
    title: `Data centers in ${metro.name}`,
    description: `${facilities.length} data centers and compute facilities tracked across ${metro.name} — capacity, build status, operators, and a public source for every figure.`,
    alternates: { canonical: `/metros/${slug}` },
  };
}

/**
 * /metros/[metro] — SEO landing page for one curated metro area (a
 * hand-picked cluster of counties known for AI data center / crypto-mining /
 * power-generation activity). Static server component generated at build
 * time for all 27 metros via generateStaticParams. Renders live data
 * through the CollectionPage primitive — counts and the facility grid are
 * never hardcoded. Mirrors app/status/[status]/page.tsx's structure.
 */
export default async function MetroPage({
  params,
}: {
  params: Promise<{ metro: string }>;
}) {
  const { metro: slug } = await params;
  const metro = getMetroBySlug(slug);
  if (!metro) {
    notFound();
  }

  const facilities = await getFacilitiesByMetro(slug);
  const countyList = countyListFor(metro);
  const operationalMw = sumOperationalMw(facilities);
  const plannedMw = sumPlannedMw(facilities);
  const topOperators = topOperatorsFor(facilities);
  const isMultiState = metro.states.length > 1;

  // Second paragraph: an operational-vs-planned capacity read, phrased
  // conditionally so an empty or all-zero-capacity metro never claims figures
  // it doesn't have (facilities.length === 0 is covered by emptyMessage).
  const capacityLine =
    facilities.length === 0
      ? null
      : operationalMw > 0 && plannedMw > 0
        ? `${formatPower(operationalMw)} of capacity is operational today in ${metro.name}, with ${formatPower(plannedMw)} more planned or under construction.`
        : operationalMw > 0
          ? `${formatPower(operationalMw)} of capacity is operational today in ${metro.name}.`
          : plannedMw > 0
            ? `${formatPower(plannedMw)} of capacity is planned or under construction in ${metro.name}, with none operational yet.`
            : null;

  // Third paragraph: which operators show up most often here — omitted
  // entirely when no facility in the metro has an operator on file.
  const operatorLine =
    topOperators.length === 0
      ? null
      : topOperators.length === 1
        ? `${topOperators[0]} is the most active operator on file in ${metro.name}.`
        : `${humanJoin(topOperators)} are among the most active operators on file in ${metro.name}.`;

  return (
    <CollectionPage
      title={`Data centers in ${metro.name}`}
      intro={
        <>
          <p>
            Compute Atlas tracks {facilities.length} data center
            {facilities.length === 1 ? "" : "s"} across {metro.name} —{" "}
            {countyList}
            {isMultiState ? `, spanning ${metro.states.length} states` : ""}{" "}
            — each traced to a public source.
          </p>
          {capacityLine && <p>{capacityLine}</p>}
          {operatorLine && <p>{operatorLine}</p>}
        </>
      }
      crumbs={[
        { label: "Explore", href: "/explore" },
        { label: "By metro", href: "/metros" },
        { label: metro.name },
      ]}
      statRow={[
        { label: "Facilities", value: String(facilities.length) },
        { label: "Operational", value: formatPower(operationalMw) },
        { label: "Planned", value: formatPower(plannedMw) },
      ]}
      facilities={facilities}
      emptyMessage={`No facilities are on file yet for ${metro.name}.`}
    />
  );
}
