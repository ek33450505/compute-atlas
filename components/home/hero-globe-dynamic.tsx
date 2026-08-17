"use client";

/**
 * Thin client wrapper that loads HeroGlobe with `ssr: false`, gated to sm+
 * viewports.
 *
 * MapLibre GL requires `window` during module initialization, which makes
 * SSR impossible. `next/dynamic` with `ssr: false` must live inside a
 * Client Component — this file is that component. The loading placeholder
 * renders the animated survey graticule (GraticuleSurvey) on a parchment
 * panel — no spinner — so the handoff reads as "plotting the grid, then the
 * globe arrives," while the SSR'd H1 text stays the LCP and the WebGL
 * canvas never is.
 *
 * Mobile gate: `hero-globe.tsx` statically imports `react-map-gl/maplibre`
 * at module scope, so an early `return` *inside* that component would still
 * download the MapLibre chunk — only not-rendering `HeroGlobeInner` here
 * (never triggering the dynamic import at all) actually avoids the fetch.
 * `allowGlobe` starts `false` on every viewport and only flips to `true`
 * once an effect confirms a `(min-width: 640px)` (Tailwind's `sm`) match, so
 * phones never request MapLibre. This also means desktop doesn't mount the
 * globe until after that first effect — a deliberate side effect, not a
 * bug: it keeps MapLibre off the critical path everywhere, so the SSR'd H1
 * (not the WebGL canvas) stays the LCP element on every viewport size.
 *
 * Usage in server components:
 *   import { HeroGlobe } from "@/components/home/hero-globe-dynamic";
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { GraticuleSurvey } from "@/components/home/graticule-survey";
import type { HeroPoint } from "@/components/home/hero-globe";

const HERO_DEFAULT_HEIGHT_CLASS = "h-[60vh] min-h-[420px]";

// Shorter static plate for phones (`!allowGlobe`) — exactly 2/3 of the
// desktop default in both dimensions. The decorative graticule doesn't need
// a full 60vh to read as a grid, and the hero now stacks a search bar and a
// CTA row below the subhead, so a shorter decorative band leaves more of a
// short mobile viewport for that real, interactive content instead of a
// dead zone.
const HERO_MOBILE_HEIGHT_CLASS = "h-[40vh] min-h-[280px]";

interface HeroGlobeProps {
  points: HeroPoint[];
  /** Tailwind height classes forwarded to HeroGlobe once it mounts (sm+ only). */
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
  // Starts false on every viewport — phones never fetch MapLibre, and
  // desktop only mounts it once this effect confirms sm+. See the module
  // comment above for why that's deliberate on desktop too.
  const [allowGlobe, setAllowGlobe] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe browser-only viewport gate; no external state to sync against.
    setAllowGlobe(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setAllowGlobe(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (!allowGlobe) {
    // Static parchment plate — same treatment as the dynamic-import loading
    // placeholder above (aria-hidden GraticuleSurvey, no spinner), but at
    // the shorter mobile height so this never reads as a decorative dead
    // zone above the search bar and CTAs.
    return (
      <div
        aria-hidden="true"
        className={`${HERO_MOBILE_HEIGHT_CLASS} relative w-full overflow-hidden bg-background`}
      >
        <GraticuleSurvey className="pointer-events-none absolute inset-0" />
      </div>
    );
  }

  return <HeroGlobeInner points={points} heightClass={heightClass} />;
}
