"use client";

/**
 * Thin client wrapper that loads FacilityMap with `ssr: false`.
 *
 * MapLibre GL requires `window` during module initialization, which makes
 * SSR impossible. `next/dynamic` with `ssr: false` must live inside a
 * Client Component — this file is that component.
 *
 * Usage in server components:
 *   import { FacilityMap } from "@/components/map/facility-map-dynamic";
 */

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { Facility } from "@/lib/schema";

const FacilityMapInner = dynamic(
  () =>
    import("@/components/map/facility-map").then((m) => ({
      default: m.FacilityMap,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[70vh] min-h-[420px] w-full rounded-lg" />
    ),
  }
);

interface FacilityMapProps {
  facilities: Facility[];
  /** Tailwind height classes forwarded to FacilityMap. */
  heightClass?: string;
}

export function FacilityMap({ facilities, heightClass }: FacilityMapProps) {
  return <FacilityMapInner facilities={facilities} heightClass={heightClass} />;
}
