import { Suspense } from "react";
import type { Metadata } from "next";

import { getAllFacilities } from "@/lib/data";
import { Explorer } from "@/components/explorer/explorer";

export const metadata: Metadata = {
  title: "Map",
  description:
    "Interactive map of AI datacenter facilities across the United States. Filter by status, state, operator, and capacity.",
};

/**
 * /map — immersive map page.
 * Server component: facilities loaded at request time, passed to Explorer in map mode.
 */
export default function MapPage() {
  const facilities = getAllFacilities();

  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 py-6 sm:px-6">
      {/* Compact title strip */}
      <div className="mb-4 flex items-baseline gap-3">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          The Map
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          AI datacenter infrastructure · United States
        </p>
      </div>

      <Suspense>
        <Explorer facilities={facilities} mode="map" />
      </Suspense>
    </div>
  );
}
