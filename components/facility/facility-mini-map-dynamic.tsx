"use client";

/**
 * Thin client wrapper that loads FacilityMiniMap with `ssr: false`.
 *
 * MapLibre GL requires `window` during module initialization, which makes
 * SSR impossible. `next/dynamic` with `ssr: false` must live inside a
 * Client Component — this file is that component.
 *
 * Usage in server components:
 *   import { FacilityMiniMapDynamic } from "@/components/facility/facility-mini-map-dynamic";
 */

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { Facility } from "@/lib/schema";

const FacilityMiniMapInner = dynamic(
  () =>
    import("@/components/facility/facility-mini-map").then((m) => ({
      default: m.FacilityMiniMap,
    })),
  {
    ssr: false,
    loading: () => <Skeleton className="h-64 w-full rounded-lg" />,
  }
);

interface FacilityMiniMapDynamicProps {
  facility: Facility;
}

export function FacilityMiniMapDynamic({ facility }: FacilityMiniMapDynamicProps) {
  return <FacilityMiniMapInner facility={facility} />;
}
