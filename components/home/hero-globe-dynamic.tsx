"use client";

/**
 * Thin client wrapper that loads HeroGlobe with `ssr: false`.
 *
 * MapLibre GL requires `window` during module initialization, which makes
 * SSR impossible. `next/dynamic` with `ssr: false` must live inside a
 * Client Component — this file is that component. The loading placeholder
 * renders the animated survey graticule (GraticuleSurvey) on a parchment
 * panel — no spinner — so the handoff reads as "plotting the grid, then the
 * globe arrives," while the SSR'd H1 text stays the LCP and the WebGL
 * canvas never is.
 *
 * Usage in server components:
 *   import { HeroGlobe } from "@/components/home/hero-globe-dynamic";
 */

import dynamic from "next/dynamic";
import { GraticuleSurvey } from "@/components/home/graticule-survey";
import type { HeroPoint } from "@/components/home/hero-globe";

const HERO_DEFAULT_HEIGHT_CLASS = "h-[75vh] min-h-[420px]";

interface HeroGlobeProps {
  points: HeroPoint[];
  /** Tailwind height classes forwarded to HeroGlobe. */
  heightClass?: string;
}

// Matches HeroGlobe's own default heightClass so the placeholder reserves
// the same footprint the real globe mounts into (no layout shift). (next/
// dynamic's `loading` render has no access to the wrapped instance's own
// props, so — matching components/map/facility-map-dynamic.tsx's convention
// — this is a fixed class rather than forwarded from the caller.)
const HeroGlobeInner = dynamic(
  () =>
    import("@/components/home/hero-globe").then((m) => ({
      default: m.HeroGlobe,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className={`${HERO_DEFAULT_HEIGHT_CLASS} relative w-full overflow-hidden bg-background`}
      >
        <GraticuleSurvey className="pointer-events-none absolute inset-0" />
      </div>
    ),
  }
);

export function HeroGlobe({ points, heightClass }: HeroGlobeProps) {
  return <HeroGlobeInner points={points} heightClass={heightClass} />;
}
