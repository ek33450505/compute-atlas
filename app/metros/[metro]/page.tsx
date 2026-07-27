import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getFacilitiesByMetro } from "@/lib/data";
import { getMetroBySlug, METROS, type Metro } from "@/lib/metros";
import type { Facility } from "@/lib/schema";
import { CollectionPage } from "@/components/collection/collection-page";

export const revalidate = 3600;

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Mirrors app/status/[status]/page.tsx's formatPower. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

function sumOperationalMw(facilities: Facility[]): number {
  return facilities.reduce((sum, f) => sum + (f.capacityMw?.operational ?? 0), 0);
}

function sumPlannedMw(facilities: Facility[]): number {
  return facilities.reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
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

  return (
    <CollectionPage
      title={`Data centers in ${metro.name}`}
      intro={
        <p>
          Compute Atlas tracks {facilities.length} data center
          {facilities.length === 1 ? "" : "s"} across {metro.name} —{" "}
          {countyList} — each traced to a public source.
        </p>
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
