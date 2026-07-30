"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Map, {
  Source,
  Layer,
  type MapRef,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

import { BASEMAP_STYLE_URL, INITIAL_VIEW_STATE } from "@/lib/map";
import type { Status } from "@/lib/status";

export interface HeroPoint {
  id: string;
  lat: number;
  lon: number;
  status: Status;
}

interface HeroGlobeProps {
  points: HeroPoint[];
  /** Tailwind height classes for the map container. Defaults to "h-[60vh] min-h-[420px]". */
  heightClass?: string;
}

type HeroFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  { id: string; status: Status; lon: number }
>;

// Status circle colors, inlined from app/globals.css :root --status-* tokens.
// MapLibre paint expressions can't read CSS custom properties, so these are
// duplicated by hand — keep in sync if the tokens are ever recalibrated.
const STATUS_HEX: Record<Status, string> = {
  operational: "#005E90",
  under_construction: "#8F4108",
  permitted: "#036A4A",
  proposed: "#8A2661",
  cancelled: "#39414A",
};

// West→east "survey" draw-in of the facility points (the signature hero
// motion). Values are longitudes bracketing the contiguous US.
const REVEAL_START_LON = -125;
const REVEAL_END_LON = -66;
const REVEAL_DURATION_MS = 1600;

// Single, deliberate settle toward the US on load — not a perpetual spin.
const DRIFT_START_ZOOM_DELTA = 0.8;
const DRIFT_DURATION_MS = 2500;

/**
 * Lightweight, decorative "living globe" hero: every tracked facility plotted
 * as a single canvas circle layer on a globe-projection basemap, with a
 * west→east "survey" draw-in and one settling drift toward the US. This is
 * intentionally NOT the full FacilityMap — no filters/legend/clustering/
 * popups/DOM markers, since 727+ focusable canvas points would be far too
 * heavy (and inaccessible) for a hero.
 *
 * Design decisions:
 * - The page must always stay scrollable: scrollZoom/doubleClickZoom/boxZoom
 *   are disabled so the mouse wheel scrolls the page; drag spins the globe.
 * - Coarse pointers (touch) render fully non-interactive (`interactive={false}`),
 *   so a one-finger drag always scrolls the page instead of panning the map.
 * - prefers-reduced-motion and coarse pointers both skip the draw-in/drift
 *   animations entirely — the default (unanimated) state is the fully
 *   revealed point set on the settled US view, so nothing ever flashes.
 * - Decorative layer only: the accessible navigation path is the SSR'd H1 +
 *   "Explore the map →" CTA (to the fully-accessible /map) rendered by the
 *   parent page, so the whole container is aria-hidden and the canvas is
 *   marked non-focusable, instead of exposing 700+ focusable points.
 */
export function HeroGlobe({
  points,
  heightClass = "h-[60vh] min-h-[420px]",
}: HeroGlobeProps) {
  const router = useRouter();
  const mapRef = useRef<MapRef>(null);
  const [hovered, setHovered] = useState(false);

  // Lazy initializer is safe here: this component only renders client-side
  // via the ssr:false dynamic wrapper, so window is always defined at init.
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const coarse = useMemo(
    () => window.matchMedia("(pointer: coarse)").matches,
    []
  );
  const skipMotion = reducedMotion || coarse;

  const initialViewState = useMemo(
    () =>
      skipMotion
        ? INITIAL_VIEW_STATE
        : {
            ...INITIAL_VIEW_STATE,
            zoom: INITIAL_VIEW_STATE.zoom - DRIFT_START_ZOOM_DELTA,
          },
    [skipMotion]
  );

  const geojson: HeroFeatureCollection = useMemo(
    () => ({
      type: "FeatureCollection",
      features: points
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map((p) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: { id: p.id, status: p.status, lon: p.lon },
        })),
    }),
    [points]
  );

  // null = every point visible (the settled end-state). MapLibre's layer
  // validator rejects `filter: undefined` (addLayer throws "array expected"
  // and the layer silently fails to add), so null renders as the always-true
  // ["has","id"] array below rather than omitting the prop. While animating,
  // holds the current reveal threshold longitude.
  const [revealLon, setRevealLon] = useState<number | null>(null);
  const revealRafRef = useRef<number | null>(null);

  const startReveal = useCallback(() => {
    const start = performance.now();
    setRevealLon(REVEAL_START_LON);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / REVEAL_DURATION_MS);
      setRevealLon(REVEAL_START_LON + (REVEAL_END_LON - REVEAL_START_LON) * t);
      if (t < 1) {
        revealRafRef.current = requestAnimationFrame(tick);
      } else {
        revealRafRef.current = null;
        setRevealLon(null); // fully revealed — drop the filter
      }
    };
    revealRafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(
    () => () => {
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
      }
    },
    []
  );

  // Stops the settle-drift the instant the user takes over the camera, so it
  // never fights a real drag.
  const handleDragStart = useCallback(() => {
    mapRef.current?.getMap().stop();
  }, []);

  const handleLoad = useCallback(() => {
    try {
      mapRef.current?.getMap().setProjection({ type: "globe" });
    } catch {
      // Globe projection unsupported (older maplibre) — fall back to mercator silently.
    }

    // Decorative canvas: strip the default focusable/labeled region maplibre
    // sets on its <canvas>. The wrapper div is already aria-hidden, but a
    // focusable element inside an aria-hidden subtree is still a real
    // keyboard tab stop (and an axe/WCAG 4.1.2 violation) even though it's
    // invisible to assistive tech — so this still needs stripping.
    const canvas = mapRef.current?.getMap().getCanvas();
    if (canvas) {
      canvas.setAttribute("tabindex", "-1");
      canvas.removeAttribute("aria-label");
      canvas.removeAttribute("role");
    }

    if (skipMotion) {
      // Reduced motion or coarse pointer: land directly on the settled
      // end-state — no draw-in, no drift, nothing to flash.
      return;
    }

    startReveal();
    mapRef.current?.easeTo({
      zoom: INITIAL_VIEW_STATE.zoom,
      duration: DRIFT_DURATION_MS,
    });
  }, [skipMotion, startReveal]);

  const handleClick = useCallback(
    (e: { features?: { properties?: Record<string, unknown> }[] }) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "string") {
        router.push(`/facilities/${id}`);
      }
    },
    [router]
  );

  return (
    <div
      aria-hidden="true"
      className={`${heightClass} relative w-full overflow-hidden`}
    >
      <Map
        ref={mapRef}
        mapStyle={BASEMAP_STYLE_URL}
        initialViewState={initialViewState}
        style={{ width: "100%", height: "100%" }}
        reuseMaps
        attributionControl={false}
        onLoad={handleLoad}
        onDragStart={handleDragStart}
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        cursor={hovered ? "pointer" : undefined}
        interactive={!coarse}
        scrollZoom={false}
        doubleClickZoom={false}
        boxZoom={false}
        dragPan={!coarse}
        dragRotate={!coarse}
        keyboard={false}
        touchZoomRotate={false}
        touchPitch={false}
        interactiveLayerIds={["hero-facility-points"]}
      >
        <Source id="hero-facilities" type="geojson" data={geojson}>
          <Layer
            id="hero-facility-points"
            type="circle"
            filter={
              revealLon === null
                ? ["has", "id"]
                : ["<=", ["get", "lon"], revealLon]
            }
            paint={{
              "circle-color": [
                "match",
                ["get", "status"],
                "operational",
                STATUS_HEX.operational,
                "under_construction",
                STATUS_HEX.under_construction,
                "permitted",
                STATUS_HEX.permitted,
                "proposed",
                STATUS_HEX.proposed,
                "cancelled",
                STATUS_HEX.cancelled,
                STATUS_HEX.cancelled,
              ],
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                2,
                2.2,
                5,
                4,
              ],
              "circle-stroke-width": 0.6,
              "circle-stroke-color": "#F5F1E6",
              "circle-opacity": 0.9,
            }}
          />
        </Source>
      </Map>
    </div>
  );
}
