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
import type { ComponentProps } from "react";

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

/**
 * Derived from `FacilityMapInner` itself — NOT hand-declared — so this
 * wrapper's props can never drift from the real FacilityMapProps in
 * facility-map.tsx. `next/dynamic` infers `FacilityMapInner`'s prop type
 * from the loader's resolved `{ default: m.FacilityMap }` shape, so
 * `ComponentProps<typeof FacilityMapInner>` already IS the real component's
 * props; re-declaring them by hand (the previous version of this file) is
 * exactly the duplication that let a real prop (`isFiltered`) silently fail
 * to reach the inner component until TypeScript caught it at the call site.
 * Every prop is forwarded via spread for the same reason — adding a prop to
 * FacilityMap must not require touching this file again.
 *
 * Deliberately requires NO import of "@/components/map/facility-map" here —
 * the type comes from `FacilityMapInner`, which already resolves it lazily
 * through the dynamic() loader above. A plain (non-type-only) VALUE import
 * of a module from a client component has dragged unrelated code into the
 * browser bundle in this repo before, and only `next build` catches that
 * class of break, not typecheck or tests — so avoiding a second import
 * entirely, rather than adding a type-only one, is the safer of two working
 * options here.
 */
type FacilityMapProps = ComponentProps<typeof FacilityMapInner>;

export function FacilityMap(props: FacilityMapProps) {
  return <FacilityMapInner {...props} />;
}
