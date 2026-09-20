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
import { Explorer } from "@/components/explorer/explorer";
import { MapPageContent } from "@/components/map/map-page-content";

export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
  const { count } = await getStats();
  return {
    title: "Map of data centers, mining and power sites",
    description: `Interactive map of ${count.toLocaleString("en-US")} US data centers, AI campuses, crypto-mining sites, and power plants — filter by status, state, operator, and capacity. Source-cited.`,
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
 * Server component: facilities loaded at request time, passed to Explorer.
 */
export default async function MapPage() {
  const [facilities, stats, topStates, topOperators, statusCounts, typeCounts] =
    await Promise.all([
      getAllFacilities(),
      getStats(),
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
        <Explorer facilities={facilities} mode="map" />
      </Suspense>
      <MapPageContent
        stats={stats}
        topStates={topStates}
        topOperators={topOperators}
        statusCounts={statusCounts}
        typeCounts={typeCounts}
      />
    </>
  );
}
