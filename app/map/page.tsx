import { Suspense } from "react";
import type { Metadata } from "next";

import { getAllFacilities } from "@/lib/data";
import { Explorer } from "@/components/explorer/explorer";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Map",
  description:
    "Interactive map of data center facilities across the United States — traditional, AI-specific, and crypto-mining. Filter by status, state, operator, and capacity.",
};

/**
 * /map — immersive full-bleed map page (Phase 1c).
 *
 * Renders Explorer in map mode at full viewport width — no max-width container,
 * no page-level padding, no title strip. The sticky header (h-16 = 4 rem) sits
 * above; the map fills `h-[calc(100dvh-4rem)]` below it. The filter panel,
 * compass rose, scale bar, and legend float as overlays over the map canvas.
 *
 * Server component: facilities loaded at request time, passed to Explorer.
 */
export default async function MapPage() {
  const facilities = await getAllFacilities();

  return (
    <Suspense>
      <Explorer facilities={facilities} mode="map" />
    </Suspense>
  );
}
