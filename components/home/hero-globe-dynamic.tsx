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
 * The point set rides the same gate. It used to be serialized into the
 * homepage's server payload — ~1k `{id, lat, lon, status}` records, ~98 KB
 * brotli, paid for by every visitor including the phones that never draw the
 * globe. It is now a static CDN artifact (public/data/hero-points.json, built
 * by scripts/build-hero-points.mjs) fetched here only once `allowGlobe` is
 * true. Failure is silent by design: this is a decorative surface, so a
 * missing artifact degrades to the graticule plate rather than an error UI.
 *
 * Usage in server components:
 *   import { HeroGlobe } from "@/components/home/hero-globe-dynamic";
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { GraticuleSurvey } from "@/components/home/graticule-survey";
import type { HeroPoint } from "@/components/home/hero-globe";
import type { Status } from "@/lib/status";

const HERO_POINTS_URL = "/data/hero-points.json";

// The statuses the globe can actually paint. `satisfies Record<Status, true>`
// makes this exhaustive at build time — adding a status to lib/status.ts fails
// typecheck here rather than silently falling through the globe's MapLibre
// `match` default (hero-globe.tsx) and painting the new value as "cancelled".
//
// The keys are spelled out rather than imported from STATUS_ORDER on purpose:
// `Status` is a type-only import, so lib/status.ts (and the lucide icons it
// pulls in at module scope) never joins this eagerly-loaded wrapper's chunk.
const HERO_POINT_STATUSES: ReadonlySet<string> = new Set(
  Object.keys({
    operational: true,
    under_construction: true,
    permitted: true,
    proposed: true,
    cancelled: true,
  } satisfies Record<Status, true>)
);

const HERO_DEFAULT_HEIGHT_CLASS = "h-[60vh] min-h-[420px]";

// Static plate rendered while `allowGlobe` is false — 2/3 of the desktop
// default on phones, where the graticule doesn't need a full 60vh to read as
// a grid and the hero now stacks a search bar and CTA row that deserve the
// space instead.
//
// The `sm:` half is NOT cosmetic and must not be dropped: `allowGlobe` starts
// false on EVERY viewport, so desktop first-paints this plate too, before the
// post-paint effect confirms sm+ and swaps in HERO_DEFAULT_HEIGHT_CLASS. With
// a phone-only height here, every desktop load showed a visible 40vh→60vh pop
// in the graticule band. Matching the desktop height at sm+ makes that swap
// height-stable, so the only thing that changes is the graticule becoming the
// globe.
const HERO_MOBILE_HEIGHT_CLASS =
  "h-[40vh] min-h-[280px] sm:h-[60vh] sm:min-h-[420px]";

interface HeroGlobeProps {
  /** Tailwind height classes forwarded to HeroGlobe once it mounts (sm+ only). */
  heightClass?: string;
}

/**
 * Narrow the fetched artifact to the points the globe can actually plot —
 * every field the predicate claims, including `status`, is checked. An
 * unrecognized status is a wrong-looking dot rather than a crash (it falls
 * through the globe's MapLibre `match` default and paints as "cancelled"), so
 * dropping the point is the honest outcome: our own build script can't produce
 * one, but the predicate shouldn't assert what it hasn't verified.
 *
 * Exported for direct unit testing: through the component, a throw here is
 * indistinguishable from a return of `[]` (the fetch `.catch()` absorbs both
 * into the same placeholder state), so the total-function contract — always
 * returns an array, never throws, whatever shape the CDN serves — has to be
 * asserted on the function itself.
 */
export function parseHeroPoints(data: unknown): HeroPoint[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (p): p is HeroPoint =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as HeroPoint).id === "string" &&
      Number.isFinite((p as HeroPoint).lat) &&
      Number.isFinite((p as HeroPoint).lon) &&
      HERO_POINT_STATUSES.has((p as HeroPoint).status)
  );
}

// Matches HeroGlobe's own default heightClass so the placeholder reserves
// the same footprint the real globe mounts into (no layout shift). (next/
// dynamic's `loading` render has no access to the wrapped instance's own
// props, so — matching components/map/facility-map-dynamic.tsx's convention
// — this is a fixed class rather than forwarded from the caller.)
//
// ⚠️ The loader is hoisted into `loadHeroGlobe` and SHARED with the warm-up
// call in the points-fetch effect below — do not inline it back into this
// `dynamic()` call. Measured against a real production build: with the
// `import()` written inline here, next/dynamic's build-time transform
// rewrites it to its own "next/dynamic entry" module, so an identically
// specified `import()` elsewhere resolves to a DIFFERENT module id and
// Turbopack emits a second ~24 KB copy of hero-globe.tsx that the browser
// then downloads twice. One hoisted loader = one module id = one chunk.
const loadHeroGlobe = () =>
  import("@/components/home/hero-globe").then((m) => ({
    default: m.HeroGlobe,
  }));

const HeroGlobeInner = dynamic(loadHeroGlobe, {
  ssr: false,
  loading: () => (
    <div
      aria-hidden="true"
      className={`${HERO_DEFAULT_HEIGHT_CLASS} relative w-full overflow-hidden bg-background`}
    >
      <GraticuleSurvey className="pointer-events-none absolute inset-0" />
    </div>
  ),
});

export function HeroGlobe({ heightClass }: HeroGlobeProps) {
  // Starts false on every viewport — phones never fetch MapLibre, and
  // desktop only mounts it once this effect confirms sm+. See the module
  // comment above for why that's deliberate on desktop too.
  const [allowGlobe, setAllowGlobe] = useState(false);
  const [points, setPoints] = useState<HeroPoint[] | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe browser-only viewport gate; no external state to sync against.
    setAllowGlobe(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setAllowGlobe(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Gated on `allowGlobe` for the same reason as MapLibre: phones must issue
  // zero requests for a surface they never render. Aborts on unmount and
  // swallows every failure — the placeholder below is the fallback.
  useEffect(() => {
    if (!allowGlobe) return;
    // Warm the MapLibre chunk on the same tick as the points fetch. Without
    // this the two downloads are SERIALIZED: `dynamic()` above only calls its
    // loader once HeroGlobeInner actually renders, which can't happen until
    // `points` lands — so the ~1 MB globe chunk wouldn't even start until the
    // JSON finished. In parallel they overlap; in series they stack.
    //
    // ⚠️ Must call the SAME `loadHeroGlobe` reference `dynamic()` was given —
    // never a fresh inline `import("@/components/home/hero-globe")`. One
    // loader means one module id, so this call and dynamic()'s later one
    // share a single in-flight promise and a single chunk. Duplicating the
    // import instead ships hero-globe.tsx twice (measured: +24 KB, both
    // downloaded) and nothing fails visibly — see the note above dynamic().
    void loadHeroGlobe();
    const controller = new AbortController();
    fetch(HERO_POINTS_URL, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (controller.signal.aborted || data == null) return;
        const parsed = parseHeroPoints(data);
        if (parsed.length > 0) setPoints(parsed);
      })
      .catch(() => {
        // Decorative surface — never throw, never surface an error UI.
      });
    return () => controller.abort();
  }, [allowGlobe]);

  if (!allowGlobe || points === null) {
    // Static parchment plate — same treatment as the dynamic-import loading
    // placeholder above (aria-hidden GraticuleSurvey, no spinner), but at
    // the shorter mobile height so this never reads as a decorative dead
    // zone above the search bar and CTAs.
    //
    // This is also the state desktop sits in while hero-points.json is in
    // flight, and the terminal state if that fetch never lands. The class's
    // `sm:` half keeps that window height-stable at the desktop 60vh (see
    // HERO_MOBILE_HEIGHT_CLASS) — without it the point fetch would
    // reintroduce the 40vh→60vh pop it was written to kill.
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
