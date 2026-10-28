import { siteConfig } from "@/lib/site";
import { getFacilitiesByStatus } from "@/lib/data";
import {
  STATUS_CAPACITY_LABEL,
  capacityTierForStatus,
  sumCapacityMw,
} from "@/lib/capacity-sums";
import { formatPower } from "@/lib/format";
import { STATUS_META, parseStatus } from "@/lib/status";
import { loadFrauncesFont, renderOgFallbackCard } from "@/lib/og-theme";
import { renderOgCollectionCard } from "@/lib/og-collection-card";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/status/[status]/page.tsx) prerenders every
// status at build time; doing the same for this image route would add a
// render per status to every production build. Deliberately on-demand. Reads
// the same cached loader as the page, so no query of its own.
export const revalidate = 86400;

export const alt = `${siteConfig.name} — facilities by status`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage({
  params,
}: {
  params: Promise<{ status: string }>;
}) {
  const { status: raw } = await params;
  const status = parseStatus(raw);
  const fraunces = loadFrauncesFont();

  // Unknown status: never throw from an image route — a 500 here breaks link
  // unfurling for crawlers. Fall back to a generic site card instead.
  if (!status) {
    return renderOgFallbackCard(fraunces, siteConfig, size);
  }

  const facilities = await getFacilitiesByStatus(status);

  return renderOgCollectionCard({
    overline: "BY STATUS",
    headline: STATUS_META[status].label,
    // Same tier and label the page's stat row uses (lib/capacity-sums.ts).
    stats: [
      { value: String(facilities.length), label: "SITES" },
      {
        value: formatPower(sumCapacityMw(facilities, capacityTierForStatus(status))),
        label: STATUS_CAPACITY_LABEL[status].toUpperCase(),
      },
    ],
    fraunces,
    site: siteConfig,
    size,
  });
}
