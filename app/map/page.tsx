import { Suspense } from "react";
import type { Metadata } from "next";

import {
  getAllFacilities,
  getStats,
  getTopStates,
  getTopOperators,
  getStatusCounts,
  getFacilityTypeCounts,
} from "@/lib/data";
import { loadOfferCounts } from "@/lib/dataset-offer";
import { formatEditionDate } from "@/lib/edition-date";
import { toMapPoint } from "@/lib/facility-slim";
import { getFilterOptions } from "@/lib/filters";
import { Explorer } from "@/components/explorer/explorer";
import { MapPageContent } from "@/components/map/map-page-content";

export const revalidate = 86400;

export async function generateMetadata(): Promise<Metadata> {
  // The number is getStats' (the same read as the pins). The date comes from the offer read and is shown
  // only when that read counted the same total, because the two caches can hold different snapshots.
  const [{ count }, offerCounts] = await Promise.all([getStats(), loadOfferCounts()]);
  const counted =
    offerCounts && offerCounts.facilities === count
      ? `, counted on ${formatEditionDate(offerCounts.asOf)}`
      : "";
  return {
    title: "Map of data centers, mining and power sites",
    description: `Interactive map of ${count.toLocaleString("en-US")} US data centers, AI campuses, crypto-mining sites, and power plants${counted} — filter by status, state, operator, and capacity. Source-cited.`,
    alternates: { canonical: "/map" },
  };
}

/**
 * /map — immersive full-bleed map page.
 *
 * Renders Explorer in map mode at full viewport width — no max-width container,
 * no page-level padding, no title strip. The sticky header (h-16 = 4 rem) sits
 * above; the map fills `h-[calc(100dvh-4rem)]` below it. The filter panel,
 * compass rose, scale bar, and legend float as overlays over the map canvas.
 *
 * The map canvas itself is un-crawlable (MapLibre paints into a <canvas>
 * inside a "use client" component, and nothing server-renders), so an
 * sr-only <h1> and a real, visible <MapPageContent> section are rendered
 * below the map shell — genuinely visible content, not a cloaked block, to
 * give the page indexable text and fix a real a11y gap (the page previously
 * had no heading at all). The full-bleed map shell's height is unaffected;
 * the content sits below the fold as a normal sibling.
 *
 * Server component: facilities are loaded at request time and projected to
 * `MapPoint` (lib/facility-slim.ts: id, type, status, state, rounded coords)
 * BEFORE crossing to the client Explorer. No name, operator or capacity ships
 * to the browser; popups load via /api/map/facility/[id] and the operator and
 * capacity filters via /api/map/match.
 */
export default async function MapPage() {
  const [facilities, stats, offerCounts, topStates, topOperators, statusCounts, typeCounts] =
    await Promise.all([
      getAllFacilities(),
      getStats(),
      loadOfferCounts(),
      getTopStates(),
      getTopOperators(),
      getStatusCounts(),
      getFacilityTypeCounts(),
    ]);

  return (
    <>
      <h1 className="sr-only">
        Map of US data centers, crypto-mining sites, and power generation
      </h1>
      <Suspense>
        <Explorer
          points={facilities.map(toMapPoint)}
          options={getFilterOptions(facilities)}
          mode="map"
        />
      </Suspense>
      <MapPageContent
        stats={stats}
        countedOnLabel={
          offerCounts && offerCounts.facilities === stats.count
            ? formatEditionDate(offerCounts.asOf)
            : undefined
        }
        topStates={topStates}
        topOperators={topOperators}
        statusCounts={statusCounts}
        typeCounts={typeCounts}
      />
    </>
  );
}
