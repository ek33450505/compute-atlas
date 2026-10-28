import { siteConfig } from "@/lib/site";
import { getCountyBySlug, getFacilitiesByCounty } from "@/lib/data";
import { sumCapacityMw } from "@/lib/capacity-sums";
import { formatPower } from "@/lib/format";
import { formatCountyLabel } from "@/lib/metros";
import { stateNameFromCode } from "@/lib/us-states";
import { loadFrauncesFont, renderOgFallbackCard } from "@/lib/og-theme";
import { renderOgCollectionCard } from "@/lib/og-collection-card";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/counties/[county]/page.tsx) prerenders every
// tracked county at build time; doing the same for this image route would add
// a render per county to every production build. Deliberately on-demand.
// Reads the same cached loaders as the page, so no query of its own.
export const revalidate = 86400;

export const alt = `${siteConfig.name} — county profile`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage({
  params,
}: {
  params: Promise<{ county: string }>;
}) {
  const { county: slug } = await params;
  const county = await getCountyBySlug(slug);
  const fraunces = loadFrauncesFont();

  // Unknown county slug: never throw from an image route — a 500 here breaks
  // link unfurling for crawlers. Fall back to a generic site card instead.
  if (!county) {
    return renderOgFallbackCard(fraunces, siteConfig, size);
  }

  const facilities = await getFacilitiesByCounty(slug);
  const stateName = stateNameFromCode(county.state) ?? county.state;

  return renderOgCollectionCard({
    overline: "COUNTY PROFILE",
    // Qualified by state like the page's own H1: county names repeat across
    // states, so "Washington County" alone would be ambiguous.
    headline: `${formatCountyLabel(county.name, county.state)}, ${stateName}`,
    stats: [
      { value: String(facilities.length), label: "FACILITIES" },
      { value: formatPower(sumCapacityMw(facilities, "operational")), label: "OPERATIONAL" },
      { value: formatPower(sumCapacityMw(facilities, "planned")), label: "PLANNED" },
    ],
    fraunces,
    site: siteConfig,
    size,
  });
}
