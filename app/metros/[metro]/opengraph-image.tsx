import { siteConfig } from "@/lib/site";
import { getFacilitiesByMetro } from "@/lib/data";
import { sumCapacityMw } from "@/lib/capacity-sums";
import { formatPower } from "@/lib/format";
import { getMetroBySlug } from "@/lib/metros";
import { loadFrauncesFont, renderOgFallbackCard } from "@/lib/og-theme";
import { renderOgCollectionCard } from "@/lib/og-collection-card";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/metros/[metro]/page.tsx) prerenders every metro
// at build time; doing the same for this image route would add a render per
// metro to every production build. Deliberately on-demand. Reads the same
// cached loader as the page, so no query of its own.
export const revalidate = 86400;

export const alt = `${siteConfig.name} — metro area profile`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage({
  params,
}: {
  params: Promise<{ metro: string }>;
}) {
  const { metro: slug } = await params;
  const metro = getMetroBySlug(slug);
  const fraunces = loadFrauncesFont();

  // Unknown metro slug: never throw from an image route — a 500 here breaks
  // link unfurling for crawlers. Fall back to a generic site card instead.
  if (!metro) {
    return renderOgFallbackCard(fraunces, siteConfig, size);
  }

  const facilities = await getFacilitiesByMetro(slug);

  return renderOgCollectionCard({
    overline: "METRO AREA",
    headline: metro.name,
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
