"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import Map, {
  Marker,
  Popup,
  NavigationControl,
  ScaleControl,
  Source,
  Layer,
  type MapRef,
  type MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { circle } from "@turf/circle";
import { Crosshair, Radius, SlidersHorizontal } from "lucide-react";
import type { FeatureCollection, Polygon } from "geojson";

import {
  BASEMAP_STYLE_URL,
  INITIAL_VIEW_STATE,
  SATELLITE_TILE_URL,
  SATELLITE_ATTRIBUTION,
  SATELLITE_MAX_ZOOM,
  WIDE_AND_TALL_VIEWPORT_QUERY,
  computeFacilitiesBounds,
} from "@/lib/map";
import {
  clusterFacilities,
  cullClustersToViewport,
  type Cluster,
  type ViewportBounds,
} from "@/lib/cluster";
import { buildGraticuleGeoJSON, formatLatLon } from "@/lib/graticule";
import { FacilityMarker } from "@/components/map/facility-marker";
import { ClusterMarker } from "@/components/map/cluster-marker";
import { FacilityPopup } from "@/components/map/facility-popup";
import { MapLegend } from "@/components/map/map-legend";
import { CompassRose } from "@/components/map/compass-rose";
import { LocationSearch } from "@/components/map/location-search";
import { ViewToggle3D } from "@/components/map/view-toggle-3d";
import { BasemapToggle } from "@/components/map/basemap-toggle";
import { MapLayerControl } from "@/components/map/map-layer-control";
import {
  AQUIFER_FILL_COLOR,
  AQUIFER_OUTLINE_COLOR,
  DROUGHT_RAMP,
  GROUNDWATER_RAMP,
  TRANSMISSION_COLOR,
  WATERWAYS_COLOR,
  WATER_STRESS_RAMP,
} from "@/lib/map-overlays";
import type { Facility } from "@/lib/schema";
import type { GeocodeResult } from "@/lib/geocode";

const TOOLS_PANEL_ID = "map-tools-panel";

interface FacilityMapProps {
  facilities: Facility[];
  /** Tailwind height classes for the map container. Defaults to "h-[70vh] min-h-[420px]". */
  heightClass?: string;
  /**
   * When true, run a survey-pass to fit the initial facility set on first load —
   * used when arriving with an active filter (e.g. deep-linked from the table).
   * Default false: a fresh unfiltered visit lands on the default US view.
   */
  surveyOnMount?: boolean;
  /**
   * Whether `facilities` is a filtered subset of a larger dataset, rather than
   * the full dataset itself. Defaults to true, which preserves the existing
   * "always fit bounds to `facilities`" survey-pass behavior.
   *
   * This component only ever receives the already-filtered array — it has no
   * way to tell "a broad filter matched almost everything" apart from "no
   * filter is active at all" on its own. Pass `false` when `facilities` IS
   * the complete, unfiltered dataset (e.g. right after "Clear all filters")
   * so the survey pass returns the camera to INITIAL_VIEW_STATE instead of
   * fitting a bounding box. For the full dataset that box spans from Alaska
   * (Stak Energy North Slope, ~70°N) to Hawaii (Servpac Mililani, ~158°W),
   * so fitBounds zooms out to a near-global view (measured: zoom ~2.1,
   * centered over the north Pacific at 51.6°N/-112.95°) instead of the
   * expected "back to the atlas" framing.
   *
   * Wired from `components/explorer/explorer.tsx`'s two <FacilityMap> call
   * sites as `isFiltered={filtered.length !== facilities.length}` (the same
   * expression already used for `surveyOnMount` there — the "is this a real
   * subset" question means the same thing in every render mode). Any other
   * caller that doesn't pass it gets the default (true), i.e. unchanged
   * fit-bounds behavior — that's a deliberate fallback for callers that
   * haven't been updated, not a statement that omitting it is fine going
   * forward.
   *
   * KNOWN LIMITATION: this only catches the *zero-filters* case. A filter
   * that's merely broad — e.g. a status filter that still happens to match
   * both the Alaska and Hawaii outlier facilities — hits the identical
   * bounds-spanning bug with `isFiltered` correctly `true`, because the
   * component still has no way to distinguish "broad but real" from "zero
   * filters" once the caller says a filter IS active. Fixing that generally
   * (e.g. clamping the fitted zoom to a floor regardless of `isFiltered`)
   * is a separate, larger change than this prop — not done here.
   */
  isFiltered?: boolean;
}

/**
 * Returns `id`'s marker/cluster anchor coordinates if it's currently
 * outside `bounds` — the map's TRUE, unbuffered visible viewport (what
 * `updateViewportBounds` below reads straight from `map.getBounds()`), NOT
 * the 25%-padded box `cullClustersToViewport` uses to decide what stays
 * mounted (`VIEWPORT_CULL_BUFFER_RATIO` in lib/cluster.ts). A marker can be
 * mounted and keyboard-focusable while still failing this check — that gap
 * (measured at 375×667: 170 of 441 mounted markers genuinely off-screen)
 * is exactly what the keyboard-focus-pan effect in FacilityMap uses this
 * for. Returns null when the target is already visible, when `id` isn't in
 * `clusters` (culled or unknown), or when there's no real viewport box yet
 * (`bounds` null, before the map's first load/moveend).
 */
function findOffscreenTarget(
  id: string,
  clusters: Cluster[],
  bounds: ViewportBounds | null
): { lon: number; lat: number } | null {
  if (!bounds) return null;
  const target = clusters.find((c) => c.id === id);
  if (!target) return null;
  const visible =
    target.lon >= bounds.west &&
    target.lon <= bounds.east &&
    target.lat >= bounds.south &&
    target.lat <= bounds.north;
  return visible ? null : { lon: target.lon, lat: target.lat };
}

/**
 * Interactive map of data center facilities.
 *
 * Design decisions:
 * - Accessible DOM markers (<button> elements), NOT canvas cluster layers.
 *   Screen readers can tab through all visible markers/clusters; each has a descriptive aria-label.
 *   Clustering is zoom-dependent: facilities within 44px of each other are grouped into a
 *   ClusterMarker bubble. Activating a cluster calls fitBounds to zoom into that group.
 * - Basemap: custom "flat parchment atlas" style at /basemap/parchment.json,
 *   generated from OpenFreeMap positron/openmaptiles tiles by
 *   `scripts/build-parchment-style.mjs`. Warm parchment land, slate-blue water,
 *   ink hairlines. Regenerate the snapshot with `npm run build:basemap`.
 * - prefers-reduced-motion: when enabled, easeTo/fitBounds uses duration 0 (instant);
 *   otherwise animation runs over 600 ms.
 * - Focus management: closing a popup returns focus to the triggering marker button.
 * - Full-bleed layout (Phase 1c): container has no rounded corners or side border so
 *   it meets viewport edges. Filter controls live in a sub-header above the map (in
 *   normal document flow); compass, legend, and scale float over the canvas.
 */
export function FacilityMap({
  facilities,
  heightClass = "h-[70vh] min-h-[420px]",
  surveyOnMount = false,
  isFiltered = true,
}: FacilityMapProps) {
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(
    null
  );
  const [zoom, setZoom] = useState<number>(INITIAL_VIEW_STATE.zoom);
  const [bearing, setBearing] = useState<number>(0);
  const [is3D, setIs3D] = useState<boolean>(false);
  const [isSatellite, setIsSatellite] = useState<boolean>(false);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(
    null
  );
  // Map-center coordinates, kept in sync on every move (mouse drag AND
  // keyboard pan/zoom, since MapLibre's built-in keyboard handling fires the
  // same onMoveEnd) — the keyboard-accessible counterpart to the hover-only
  // `cursor` readout below, surfaced via the "lock coordinates" toggle.
  const [mapCenter, setMapCenter] = useState<{ lat: number; lon: number }>({
    lat: INITIAL_VIEW_STATE.latitude,
    lon: INITIAL_VIEW_STATE.longitude,
  });
  // "Lock coordinates" toggle: when on, a focusable/screen-reader-visible
  // readout of the current map center is shown — the keyboard/SR-accessible
  // path onto the coordinate readout, since the existing bottom-center
  // hover readout is aria-hidden and mouse-only (unaffected by this).
  const [coordsLocked, setCoordsLocked] = useState<boolean>(false);
  // Right-side control stack (compass/3D/basemap/layers/radius) is behind a
  // "Tools" disclosure toggle. Defaults OPEN when the viewport is both wide
  // and tall (WIDE_AND_TALL_VIEWPORT_QUERY in lib/map.ts, shared with
  // MapFilterSubheader's default-expanded state so the two thresholds can't
  // drift apart again), collapsed otherwise. A landscape phone is wide but
  // short and would satisfy a width-only query, defaulting this column open
  // and squeezing the map to roughly half the viewport — the height term
  // keeps it collapsed there too. Lazy initializer (same pattern as
  // `reducedMotion` below) is safe here: this component only renders
  // client-side via the ssr:false dynamic wrapper, so window is always
  // defined at init — no hydration mismatch, and no setState-in-effect
  // cascading render. NavigationControl (zoom +/-, top-right) is unaffected —
  // always visible regardless of this toggle.
  const [showTools, setShowTools] = useState<boolean>(
    () => window.matchMedia(WIDE_AND_TALL_VIEWPORT_QUERY).matches
  );
  // Measured-top cap for the Tools panel's own scroll container, mirroring
  // MapLayerControl's approach (see the comment above its scrollMaxHeight
  // effect): the panel is the last thing in a stacked right-side column, so
  // its top offset varies a lot with viewport height, and a purely
  // viewport-relative max-height (the static max-h-[calc(100dvh-8rem)] class
  // below) is frequently taller than the space actually left below it —
  // content then overflows the viewport bottom with no way to scroll it into
  // view, because the ancestor layout is overflow-hidden. `toolsPanelRef` is
  // the container being measured; `toolsPanelMaxHeight` is applied as an
  // inline style that overrides the static class once known.
  const toolsPanelRef = useRef<HTMLDivElement>(null);
  const [toolsPanelMaxHeight, setToolsPanelMaxHeight] = useState<number | undefined>(
    undefined
  );
  // Optional overlay layers (Layers control) — off by default, lazy-loaded:
  // each corresponding <Source> only mounts (and fetches its GeoJSON) once
  // its flag flips true, so the 1.9 MB power.geojson never loads unrequested.
  const [showWater, setShowWater] = useState<boolean>(false);
  const [showPower, setShowPower] = useState<boolean>(false);
  const [showDrought, setShowDrought] = useState<boolean>(false);
  const [showWaterStress, setShowWaterStress] = useState<boolean>(false);
  const [showGroundwater, setShowGroundwater] = useState<boolean>(false);
  const [showAquifers, setShowAquifers] = useState<boolean>(false);

  // Radius-ring measurement tool: off by default, on-demand. When enabled, the
  // next map click sets a center; 3, distance rings (5/10/25 mi) are drawn
  // around it. Toggling off (or re-toggling on) clears the center, which
  // unmounts the rings Source below.
  const [ringsEnabled, setRingsEnabled] = useState<boolean>(false);
  const [ringCenter, setRingCenter] = useState<{ lon: number; lat: number } | null>(
    null
  );

  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Reverse lookup from a rendered marker/cluster <button> DOM node back to
  // its facility/cluster id — populated by the same ref callbacks that fill
  // markerRefs above (see the JSX below). Used only by the document-level
  // focusin/focusout listener further down to identify which marker
  // currently holds DOM focus, for the viewport-culling memo's keepIds.
  // WeakMap: entries fall out on their own once a button unmounts and
  // nothing else references it — no manual cleanup needed.
  const markerIdByElement = useRef<WeakMap<HTMLButtonElement, string>>(
    new WeakMap()
  );
  const lastSelectedIdRef = useRef<string | null>(null);
  const mapRef = useRef<MapRef>(null);

  // Current map viewport in lon/lat, used to cull off-screen markers below.
  // null until the map's first `load`/`moveend` (see updateViewportBounds) —
  // cullClustersToViewport treats null as "cull nothing" so there's no gap
  // where markers are wrongly hidden before a real box exists to test them
  // against.
  const [viewportBounds, setViewportBounds] = useState<ViewportBounds | null>(
    null
  );
  // Id of the marker/cluster button that currently holds DOM focus, if any —
  // see the focusin/focusout effect below. Force-kept in view by the
  // culling memo so a keyboard user's focus is never yanked out from under
  // them by an off-screen unmount.
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);

  // Recompute clusters when facilities, zoom (pan-invariant clustering),
  // the current viewport, or focus/selection state changes. Clustering
  // itself never depends on viewportBounds — only which of its results are
  // actually mounted does, via cullClustersToViewport below — so a cluster's
  // membership never jitters as you pan without zooming, only its
  // visibility does. The focused marker and any facility with an open
  // popup are always force-kept (see cullClustersToViewport's keepIds and
  // the ViewportBounds comment above).
  const clusters = useMemo(() => {
    const all = clusterFacilities(facilities, zoom);
    const keepIds = new Set<string>();
    if (focusedMarkerId) keepIds.add(focusedMarkerId);
    if (selectedFacility) keepIds.add(selectedFacility.id);
    return cullClustersToViewport(all, viewportBounds, keepIds);
  }, [facilities, zoom, viewportBounds, focusedMarkerId, selectedFacility]);

  // Static graticule GeoJSON — built once, independent of facilities/zoom.
  const graticuleData = useMemo(() => buildGraticuleGeoJSON(), []);

  // Radius-ring geometry: 3 concentric circles at 5/10/25 mi around the
  // clicked center, recomputed only when the center moves. Outline-only
  // rendering (no fill) — the Layer below sets no fill-* paint properties.
  const ringsData = useMemo<FeatureCollection<Polygon> | null>(() => {
    if (!ringCenter) return null;
    const center: [number, number] = [ringCenter.lon, ringCenter.lat];
    return {
      type: "FeatureCollection",
      features: [5, 10, 25].map((radiusMiles) =>
        circle(center, radiusMiles, { units: "miles", steps: 128 })
      ),
    };
  }, [ringCenter]);

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

  // "Latest ref" mirrors of clusters/viewportBounds/reducedMotion, synced
  // via their own LAYOUT effects rather than a plain assignment during
  // render — mutating a ref's `.current` during render is disallowed
  // (react-hooks/refs: render must stay pure) even though the mutation
  // itself doesn't trigger a re-render. useLayoutEffect (not useEffect) is
  // load-bearing here, not a style preference: useEffect is scheduled AFTER
  // the browser paints, but a just-mounted marker becomes Tab-reachable
  // AT paint time — so a passive effect leaves a real window where the DOM
  // (and focus order) has already updated but the ref hasn't caught up
  // yet. Confirmed as a real, reproducible bug during browser verification
  // (not just theoretical): with useEffect, rapidly tabbing straight into a
  // just-panned-into-buffer marker occasionally read a stale clustersRef
  // that didn't contain it yet, so findOffscreenTarget silently returned
  // null and the camera never moved — reproduced via a raw Tab-walk
  // sequence (see the "1623 Farnam" stop) and confirmed fixed by switching
  // to useLayoutEffect, which runs synchronously in the same commit, before
  // the browser paints and the new marker becomes focusable. The
  // keyboard-focus-pan effect further below is still subscribed once (empty
  // deps, same as the focusin/focusout effect it extends) so IT never has
  // to remove/re-add document listeners on every pan or zoom settle — it
  // reads these refs instead of closing over possibly-stale state.
  const clustersRef = useRef(clusters);
  useLayoutEffect(() => {
    clustersRef.current = clusters;
  }, [clusters]);
  const viewportBoundsRef = useRef(viewportBounds);
  useLayoutEffect(() => {
    viewportBoundsRef.current = viewportBounds;
  }, [viewportBounds]);
  const reducedMotionRef = useRef(reducedMotion);
  useLayoutEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  // Cap the Tools panel's scroll container to exactly what's left above the
  // viewport bottom, measured from its real top offset — never more than
  // that, even if that means shrinking below what a fixed floor would have
  // given it. Math.max(0, ...) (not some larger floor like MapLayerControl's
  // old Math.max(120, ...)) is deliberate: any positive floor can still
  // exceed genuinely small available space near the viewport bottom, which
  // is exactly what was pushing content past the fold with no way to scroll
  // it into view.
  useLayoutEffect(() => {
    if (!showTools) return;
    const el = toolsPanelRef.current;
    if (!el) return;

    function recompute() {
      const node = toolsPanelRef.current;
      if (!node) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const top = node.getBoundingClientRect().top;
      setToolsPanelMaxHeight(Math.max(0, viewportHeight - top - 16));
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.visualViewport?.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.visualViewport?.removeEventListener("resize", recompute);
    };
  }, [showTools]);

  const handleSelectFacility = useCallback(
    (facility: Facility) => {
      lastSelectedIdRef.current = facility.id;
      setSelectedFacility(facility);
      mapRef.current?.easeTo({
        center: [facility.location.lon, facility.location.lat],
        duration: reducedMotion ? 0 : 600,
      });
    },
    [reducedMotion]
  );

  const handleClosePopup = useCallback(() => {
    const id = lastSelectedIdRef.current;
    setSelectedFacility(null);
    // Return focus to the triggering marker button after React re-renders
    if (id) {
      setTimeout(() => {
        markerRefs.current[id]?.focus();
      }, 0);
    }
  }, []);

  /** Zooms the map to fit all members of a cluster. */
  const zoomToCluster = useCallback(
    (cluster: Cluster) => {
      const map = mapRef.current;
      if (!map) return;

      const b = computeFacilitiesBounds(cluster.members);
      if (!b) return;

      // Degenerate bbox: all members are essentially co-located — just zoom in.
      if (b.isCoincident) {
        map.easeTo({
          center: [cluster.lon, cluster.lat],
          zoom: Math.min(zoom + 3, 12),
          duration: reducedMotion ? 0 : 600,
        });
      } else {
        map.fitBounds(b.bounds, {
          padding: 80,
          maxZoom: 12,
          duration: reducedMotion ? 0 : 600,
        });
      }
    },
    [zoom, reducedMotion]
  );

  /**
   * Frames the current `facilities` prop as a deliberate "survey pass" — a slower,
   * more sweeping ease than the 600 ms marker-selection or cluster-zoom motions, part
   * of the "atlas being surveyed" conceit. Fired when the filtered facility set changes
   * (see the effect below) and optionally on mount when `surveyOnMount` is set.
   *
   * When `isFiltered` is false, `facilities` is the complete, unfiltered dataset —
   * fitting its bounds would zoom out to fit Alaska-to-Hawaii (a near-global view,
   * see the `isFiltered` doc comment on FacilityMapProps for the measured numbers).
   * That's not a "survey pass" over a real result set, it's "no filter is active",
   * so the honest move is back to the default CONUS framing, not a bounds fit.
   */
  const surveyToFacilities = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const duration = reducedMotion ? 0 : 1400; // slower, deliberate "survey pass"

    if (!isFiltered) {
      map.easeTo({
        center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
        zoom: INITIAL_VIEW_STATE.zoom,
        duration,
      });
      return;
    }

    const b = computeFacilitiesBounds(facilities);
    if (!b) return; // empty filtered set — leave the camera where it is

    if (b.isCoincident) {
      map.easeTo({ center: b.center, zoom: 9, duration });
    } else {
      map.fitBounds(b.bounds, { padding: 96, maxZoom: 9, duration });
    }
  }, [facilities, isFiltered, reducedMotion]);

  /** Resets map bearing and pitch to north-up. */
  const handleResetNorth = useCallback(() => {
    mapRef.current?.easeTo({
      bearing: 0,
      pitch: 0,
      duration: reducedMotion ? 0 : 400,
    });
    setIs3D(false);
  }, [reducedMotion]);

  /** Eases pitch between flat (0°) and tilted (55°) to toggle 3D view. */
  const handleToggle3D = useCallback(() => {
    const next = !is3D;
    setIs3D(next);
    mapRef.current?.easeTo({ pitch: next ? 55 : 0, duration: reducedMotion ? 0 : 600 });
  }, [is3D, reducedMotion]);

  /** Toggles the radius-ring tool; turning it off clears any placed center. */
  const handleToggleRings = useCallback(() => {
    setRingsEnabled((on) => {
      const next = !on;
      if (!next) setRingCenter(null);
      return next;
    });
  }, []);

  /**
   * Map click handler, guarded so it only places a radius-ring center when
   * the tool is active — it must not interfere with normal map interaction
   * (marker selection, search, etc.) when the tool is off. Markers are DOM
   * <button> overlays outside the canvas, so their clicks never reach this
   * handler regardless; the ringsEnabled guard is the explicit contract.
   */
  const handleMapClick = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!ringsEnabled) return;
      setRingCenter({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    },
    [ringsEnabled]
  );

  /** Flies the map to a geocoded place, capping zoom at 8 to land at state level. */
  const handleGoToPlace = useCallback(
    (r: GeocodeResult) => {
      const map = mapRef.current;
      if (!map) return;
      const duration = reducedMotion ? 0 : 800;
      if (r.bbox) {
        map.fitBounds(
          [
            [r.bbox[0], r.bbox[1]],
            [r.bbox[2], r.bbox[3]],
          ],
          { padding: 60, maxZoom: 8, duration }
        );
      } else {
        map.flyTo({ center: [r.lon, r.lat], zoom: 8, duration });
      }
    },
    [reducedMotion]
  );

  // MapLibre adds role="button" + aria-label="Map marker" to every Marker
  // wrapper div automatically, creating a nested-interactive a11y violation
  // (role="button" > <button>) flagged by WCAG 2.5.8 / axe nested-interactive.
  // We strip the outer role/label via the map's onLoad event (fired after the
  // maplibre Map and all markers have fully initialised) and then watch for any
  // future additions via a MutationObserver.
  const moRef = useRef<MutationObserver | null>(null);

  // Tracks whether the map has finished loading — fitBounds/easeTo before load
  // throws or no-ops, so the mount-time survey-pass and the filter-change effect
  // both gate on this.
  const mapReadyRef = useRef(false);

  /**
   * Reads the map's current lon/lat bounds into `viewportBounds`, which the
   * `clusters` memo above uses to cull off-screen markers. Called on `load`
   * (to seed an initial box) and on `moveend`/`resize` — deliberately NOT on
   * `move`, which fires on every animation frame during a drag/zoom gesture
   * and would make recomputing the culled marker set itself part of the
   * per-frame cost this is meant to reduce.
   */
  const updateViewportBounds = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    try {
      const b = map.getBounds();
      setViewportBounds({
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      });
    } catch {
      // getBounds unavailable on this maplibre version — fail soft; culling
      // stays disabled (viewportBounds stays null => cull nothing).
    }
  }, []);

  const handleMapLoad = useCallback(() => {
    const mapEl = mapRef.current?.getContainer();
    if (!mapEl) return;

    // Enable globe projection imperatively here (not in the shared parchment style JSON)
    // so the flat facility mini-map that reuses the same style is unaffected.
    try {
      mapRef.current?.getMap().setProjection({ type: "globe" });
    } catch {
      // Globe projection unsupported (older maplibre) — fall back to mercator silently.
    }

    // Force-enable every interaction handler this map needs (dragPan,
    // touchZoomRotate below, plus scrollZoom/boxZoom/keyboard/doubleClickZoom
    // further down) rather than trusting the <Map> prop defaults, all of
    // which are left unset, relying on MapLibre's own default-true.
    // `reuseMaps` (on <Map> below) pools maplibre-gl Map instances in a
    // GLOBAL stack shared by every <Map reuseMaps> in the app —
    // historically including FacilityMiniMap's (components/facility/
    // facility-mini-map.tsx) `interactive={false}` map on facility pages
    // (that component no longer passes reuseMaps, specifically to stop this,
    // but this defensive block is deliberate belt-and-braces against any
    // future/other pooled consumer). `interactive:false` suppresses
    // maplibre-gl's one-time initial handler.enable() calls at construction,
    // so a map built that way never truly enables ANY of its handlers. When
    // such an instance is later recycled into /map, react-map-gl's
    // prop-diffing (`nextProp ?? true` vs `prevProp ?? true`) can't detect a
    // change for any handler prop neither component sets explicitly — both
    // sides silently default to "true" — so it never (re-)enables them
    // either. Net effect: after visiting a facility page and navigating to
    // /map, single-finger drag-pan, pinch-zoom (masked by the browser's
    // native page-zoom fallback), wheel-zoom, box-zoom, double-click-zoom,
    // and keyboard pan were ALL silently dead. Root-caused via reproduction:
    // /facilities/[slug] -> in-page nav to /map reliably reproduced it
    // (mobile AND desktop viewports — engine-independent). Calling .enable()
    // directly bypasses that unreliable prop diff and makes the real handler
    // state correct regardless of what any other <Map reuseMaps> consumer
    // left behind. (One cosmetic side effect this does NOT fix: the
    // `maplibregl-interactive` class — and with it the grab/grabbing cursor
    // affordance — is added only at construction in maplibre-gl's own
    // _setupContainer and is never restored on a recycled instance. Harmless
    // and not worth chasing; the handlers themselves are what matter.)
    try {
      mapRef.current?.getMap().dragPan.enable();
    } catch {
      // dragPan unavailable on this maplibre version — fail soft.
    }

    // Drag always pans; tilt and rotation are reachable only through the
    // explicit ViewToggle3D (pitch) and CompassRose (bearing reset) controls —
    // never through a drag/touch gesture. This is deliberate: don't restore the
    // default MapLibre bindings later. dragRotate={false}/touchPitch={false} on
    // <Map> below cover the mouse (ctrl+drag / right-drag) and single-touch
    // pitch gestures; disableRotation() here additionally strips the
    // two-finger touch-rotate gesture bundled into the pinch-zoom handler.
    // The `?.` guards the (unexpected) case where touchZoomRotate isn't
    // present on this maplibre build rather than throwing — do NOT disable
    // touchZoomRotate wholesale, as that also carries pinch-to-zoom, which
    // must keep working on mobile. enable() (see comment above dragPan) is
    // called first, before disableRotation(), so a reused/never-enabled
    // instance's rotation ends up correctly disabled rather than briefly
    // re-enabled by the generic enable() call.
    try {
      mapRef.current?.getMap().touchZoomRotate?.enable();
      mapRef.current?.getMap().touchZoomRotate?.disableRotation();
    } catch {
      // touchZoomRotate unavailable on this maplibre version — fail soft.
    }

    // Remaining handlers this map wants enabled — same reuseMaps-poisoning
    // fix as dragPan/touchZoomRotate above, each independently guarded so a
    // missing/renamed API on one doesn't block the others.
    try {
      mapRef.current?.getMap().scrollZoom.enable();
    } catch {
      // scrollZoom unavailable on this maplibre version — fail soft.
    }
    try {
      mapRef.current?.getMap().boxZoom.enable();
    } catch {
      // boxZoom unavailable on this maplibre version — fail soft.
    }
    try {
      mapRef.current?.getMap().keyboard.enable();
    } catch {
      // keyboard unavailable on this maplibre version — fail soft.
    }
    try {
      mapRef.current?.getMap().doubleClickZoom.enable();
    } catch {
      // doubleClickZoom unavailable on this maplibre version — fail soft.
    }

    // Strips a single marker element's role/aria-label if present. Scoped to
    // exactly the maplibregl-marker class + role="button" the CSS selector
    // below used to match, so narrowing this to addedNodes (below) changes
    // *how* elements are found, not *which* elements get stripped.
    const stripMarkerRole = (node: Node) => {
      if (
        node instanceof HTMLElement &&
        node.classList.contains("maplibregl-marker") &&
        node.getAttribute("role") === "button"
      ) {
        node.removeAttribute("role");
        node.removeAttribute("aria-label");
      }
    };

    // Markers are appended as DIRECT children of the map's canvas container,
    // and role/aria-label are set on the marker element BEFORE that append —
    // verified directly in the installed maplibre-gl 5.24.0 dist
    // (node_modules/maplibre-gl/dist/maplibre-gl.js), where Marker.addTo()
    // reads (minified; reformatted here for readability, not a literal
    // multi-line quote):
    //   this._element.hasAttribute("aria-label") ||
    //     this._element.setAttribute("aria-label", e._getUIString("Marker.Title")),
    //   this._element.hasAttribute("role") ||
    //     this._element.setAttribute("role", "button"),
    //   e.getCanvasContainer().appendChild(this._element)
    // i.e. both attributes are set (if not already present) before the
    // appendChild call, in the same synchronous statement — so a childList
    // mutation record's addedNodes already carry the attribute; there's no
    // async gap where a node could be observed pre-attribute. Re-verify this
    // exact ordering against the new dist on any maplibre-gl upgrade — the
    // narrowed observer below (no `subtree`, no `attributeFilter`) depends
    // on it holding. That means: no `subtree` (markers never nest deeper than a
    // direct child) and no `attributeFilter` (the attribute is already
    // present by the time the addedNodes record fires) — narrower than the
    // previous whole-container/subtree/attribute-watching observer, and the
    // callback below strips only the nodes actually added in each batch
    // instead of re-querying every marker in the container on every
    // mutation. This observer is load-bearing, not just an optimization:
    // MapLibre sets role="button" unconditionally on every addTo() call
    // (guarded only by "skip if already present," not by draggable/popup
    // state — there is no such gating in this maplibre-gl version), so any
    // newly-mounted marker (new upload, re-cluster, or a previously culled
    // marker panned back into view) needs this to run again, not just the
    // initial pass.
    const canvasContainer = mapRef.current?.getMap().getCanvasContainer?.();
    if (canvasContainer) {
      canvasContainer
        .querySelectorAll<HTMLElement>('.maplibregl-marker[role="button"]')
        .forEach(stripMarkerRole);

      const mo = new MutationObserver((mutations) => {
        for (const record of mutations) {
          record.addedNodes.forEach(stripMarkerRole);
        }
      });
      mo.observe(canvasContainer, { childList: true });
      moRef.current = mo;
    }

    // Seed the initial viewport bounds for the marker-culling memo above —
    // without this, viewportBounds stays null (culling disabled) until the
    // first moveend, which would briefly mount every facility on load.
    updateViewportBounds();

    // Deep-linked arrival with an active filter: run the survey-pass once the
    // map is ready, rather than starting on the default US view then jumping.
    if (surveyOnMount) {
      surveyToFacilities();
    }
    mapReadyRef.current = true;
  }, [surveyOnMount, surveyToFacilities, updateViewportBounds]);

  // Disconnect observer on unmount
  useEffect(() => () => moRef.current?.disconnect(), []);

  // Tracks whether the most recent user interaction was keyboard-driven
  // (Tab/Shift+Tab), so the focus-tracking effect below can tell a
  // Tab-driven focusin from a mouse/touch-driven one and only auto-pan the
  // camera for the former — mirroring the browser's own :focus-visible
  // heuristic, tracked by hand (rather than
  // `element.matches(":focus-visible")`) so the check is a plain boolean
  // read synchronously, independent of any CSS engine's support for that
  // pseudo-class. Defaults true so a marker focused before any prior
  // pointer interaction (e.g. the very first Tab press on the page) still
  // counts as keyboard focus. Listeners are capture-phase on `document` so
  // they see every keydown/mousedown/pointerdown/touchstart regardless of
  // where in the tree it originates, same delegation approach as the
  // focusin/focusout listeners below.
  const hadKeyboardEventRef = useRef(true);
  useEffect(() => {
    const markKeyboard = () => {
      hadKeyboardEventRef.current = true;
    };
    const markPointer = () => {
      hadKeyboardEventRef.current = false;
    };
    document.addEventListener("keydown", markKeyboard, true);
    document.addEventListener("mousedown", markPointer, true);
    document.addEventListener("pointerdown", markPointer, true);
    document.addEventListener("touchstart", markPointer, true);
    return () => {
      document.removeEventListener("keydown", markKeyboard, true);
      document.removeEventListener("mousedown", markPointer, true);
      document.removeEventListener("pointerdown", markPointer, true);
      document.removeEventListener("touchstart", markPointer, true);
    };
  }, []);

  // Tracks which marker/cluster button (if any) currently holds DOM focus,
  // so the culling memo above can force-keep it mounted (see its comment,
  // and the ViewportBounds/keepIds doc comments in lib/cluster.ts). Wired on
  // `document` — not the map container — because focus tracking only needs
  // markerIdByElement (populated by the marker ref callbacks below,
  // regardless of map-load state) and works the same however many times the
  // map itself (re)loads. `focusin`/`focusout` (not `focus`/`blur`) so this
  // one delegated pair covers every marker button without attaching a
  // listener per marker.
  //
  // Extended (not paralleled) for keyboard-focus-pan: a marker inside the
  // buffered-but-not-strictly-visible band is mounted and reachable by Tab
  // but not actually on screen (see findOffscreenTarget's doc comment
  // above) — a gap that doesn't exist for mouse clicks, which can only ever
  // land on a marker that's already painted inside the map's overflow-
  // hidden container. So this only auto-pans for keyboard-driven focusin
  // (hadKeyboardEventRef) — belt-and-braces against ever double-moving the
  // camera on a click (handleSelectFacility already eases to it), not a
  // case this has been observed to hit.
  useEffect(() => {
    const handleMarkerFocusChange = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLButtonElement)) return;
      const id = markerIdByElement.current.get(e.target);
      if (!id) return;
      if (e.type === "focusin") {
        setFocusedMarkerId(id);
        if (hadKeyboardEventRef.current) {
          const target = findOffscreenTarget(
            id,
            clustersRef.current,
            viewportBoundsRef.current
          );
          // This easeTo settles via onMoveEnd -> updateViewportBounds -> the
          // clusters memo recomputing with the new (now-containing) bounds
          // — which cannot loop back into another auto-pan. `id` is already
          // force-kept mounted via focusedMarkerId in keepIds (set by
          // setFocusedMarkerId just above, in the same event), so the
          // marker keeps its DOM identity across that re-render — React
          // reconciles the same <button> by key instead of unmounting/
          // remounting it, and a re-render alone never fires a new focusin.
          if (target) {
            mapRef.current?.easeTo({
              center: [target.lon, target.lat],
              duration: reducedMotionRef.current ? 0 : 600,
            });
          }
        }
      } else {
        setFocusedMarkerId((cur) => (cur === id ? null : cur));
      }
    };
    document.addEventListener("focusin", handleMarkerFocusChange);
    document.addEventListener("focusout", handleMarkerFocusChange);
    return () => {
      document.removeEventListener("focusin", handleMarkerFocusChange);
      document.removeEventListener("focusout", handleMarkerFocusChange);
    };
  }, []);

  // Survey-pass on filter changes (facilities identity change), skipping the
  // initial mount — that's handled by handleMapLoad above (once, gated on
  // surveyOnMount) so a fresh mount never double-fires the camera move. This
  // is also what fires when filters are CLEARED (facilities grows back to
  // the full dataset) — surveyToFacilities itself branches on `isFiltered`
  // to return to INITIAL_VIEW_STATE rather than fitting bounds in that case.
  // `surveyToFacilities`'s identity already changes when `isFiltered` alone
  // flips (see its useCallback deps), so this effect re-fires correctly even
  // in the hypothetical case where a caller changes `isFiltered` without
  // also changing `facilities`.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!mapReadyRef.current) return;
    surveyToFacilities();
  }, [facilities, surveyToFacilities]);

  // rAF-throttled pointer-coordinate readout. Raw `mousemove` can fire far
  // faster than the display's refresh rate (well above 60Hz on a
  // high-poll-rate mouse/trackpad), and every `setCursor` call re-renders
  // this component — including the .map() over every currently-mounted
  // marker. Coalescing to at most one `setCursor` per animation frame caps
  // that re-render rate to the display's own, instead of the raw input
  // rate. Desktop-only in effect (touch has no hover; no touch handlers are
  // wired here), so this doesn't touch the touch/drag path at all.
  const cursorRafRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<{ lat: number; lon: number } | null>(null);

  const handleMapMouseMove = useCallback((e: MapLayerMouseEvent) => {
    pendingCursorRef.current = { lat: e.lngLat.lat, lon: e.lngLat.lng };
    if (cursorRafRef.current !== null) return; // an update is already scheduled this frame
    cursorRafRef.current = requestAnimationFrame(() => {
      cursorRafRef.current = null;
      setCursor(pendingCursorRef.current);
    });
  }, []);

  const handleMapMouseOut = useCallback(() => {
    // Cancel any already-scheduled update so a stale coordinate can't flash
    // in on the next frame after the pointer has already left the map.
    if (cursorRafRef.current !== null) {
      cancelAnimationFrame(cursorRafRef.current);
      cursorRafRef.current = null;
    }
    pendingCursorRef.current = null;
    setCursor(null);
  }, []);

  // Cancel any in-flight rAF on unmount so it doesn't call setCursor on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (cursorRafRef.current !== null) {
        cancelAnimationFrame(cursorRafRef.current);
      }
    };
  }, []);

  return (
    <div
      role="region"
      aria-label="Map of data centers in the United States"
      className={heightClass}
    >
      {/* Visually-hidden guidance for screen reader users. Every clause
          here is load-bearing and has been wrong twice already — keep it
          describing MECHANISM, not outcome.
          "Nearby locations" (not "in view", and not "each location"): the
          viewport-culling memo above mounts a buffered band of markers
          around the visible area (VIEWPORT_CULL_BUFFER_RATIO in
          lib/cluster.ts), so a focusable marker isn't always already on
          screen — "each location" was false once culling landed, and
          "currently in view" was false because the buffer band is
          focusable while off screen.
          "Moves the camera to bring it into view" (NOT "brings it fully
          into view"): the focus-pan effect above eases to any marker
          outside the true unbuffered viewport at focus time, but it tests
          visibility against map.getBounds(), which under this app's globe
          projection is an APPROXIMATE lon/lat rectangle rather than the
          true pixel viewport — measured: a marker read as visible by
          bounds while sitting 14px off a 375px-wide canvas. So the camera
          move is guaranteed; full visibility afterwards is not. Promising
          the outcome would overstate what the code can deliver to exactly
          the users who cannot check it for themselves. */}
      <p className="sr-only">
        Interactive map showing data center locations across the United
        States. Nearby locations are focusable buttons — tabbing to one
        moves the camera to bring it into view; pan or zoom the map to
        reach other areas. A data table alternative listing every location is
        available at the{" "}
        <a href="/table" className="underline">
          data table page
        </a>
        .
      </p>

      {/*
       * Full-bleed container (Phase 1c): no rounded-lg or side border so the map
       * meets the viewport edges below the sticky header. A bottom hairline (border-b)
       * separates map from content below the fold.
       */}
      <div className="relative h-full w-full overflow-hidden border-b">
        {/*
         * Rendered BEFORE <Map> below — not after, despite being visually "on
         * top" via position:absolute + a positive z-index — so these two
         * interactive overlays land earlier in DOM/tab order than the ~27+
         * facility marker buttons that mount as <Map> children. Previously,
         * with this JSX placed after </Map>, keyboard users had to tab
         * through every visible marker before reaching LocationSearch or the
         * Tools column (measured at 320×568: LocationSearch was tab stop 37,
         * with markers starting at stop 8). Positioning is unaffected — both
         * wrappers use `absolute`, computed against the outer `.relative`
         * container, not against sibling DOM order; and their explicit
         * z-20/z-30 already paint them above <Map>'s implicit (z-index:auto)
         * stacking level regardless of DOM order, so this is a pure tab-order
         * fix with no visual change. Do not move this back after <Map> "for
         * readability" — that silently regresses tab order again.
         */}
        {/* Top-left: location search widget */}
        <div className="absolute top-3 left-3 z-20 max-w-[calc(100%-1rem)]">
          <LocationSearch onSelect={handleGoToPlace} />
        </div>

        {/*
         * Top-right: custom compass rose, stacked below NavigationControl.
         * NavigationControl (~29 px buttons × 2 = ~70 px) + margin → top-20 (~80 px).
         * Not a MapLibre control — a plain positioned element so it doesn't fight
         * MapLibre's ctrl-group z-index stacking.
         */}
        <div className="absolute top-20 right-2 z-30 flex flex-col items-end gap-2">
          {/* Single disclosure toggle for the compass/3D/basemap/layers/radius
              stack below — collapsed by default to maximize the visible map.
              NavigationControl (zoom +/-, top-2) is separate and always shown.
              `items-end` on this column (and the panel below) right-aligns
              every child regardless of its own width — without it, the
              default flex `stretch` cross-alignment left-anchors fixed-width
              buttons inside the wider box the MapLayerControl/radius-caption
              panels create when expanded, so the Tools toggle and icon
              buttons visibly drift left off the right-2 edge. */}
          <button
            type="button"
            onClick={() => setShowTools((s) => !s)}
            aria-expanded={showTools}
            aria-controls={TOOLS_PANEL_ID}
            aria-label={showTools ? "Hide map tools" : "Show map tools"}
            title="Map tools"
            className={[
              "flex h-11 w-11 items-center justify-center",
              "rounded-sm bg-popover border border-border",
              "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
              "cursor-pointer transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              showTools ? "ring-1 ring-primary/50" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <SlidersHorizontal
              aria-hidden="true"
              className={["size-4", showTools ? "text-primary" : "text-foreground"].join(
                " "
              )}
            />
          </button>

          {showTools && (
            <div
              id={TOOLS_PANEL_ID}
              ref={toolsPanelRef}
              style={
                toolsPanelMaxHeight !== undefined
                  ? { maxHeight: `${toolsPanelMaxHeight}px` }
                  : undefined
              }
              className="flex max-h-[calc(100dvh-8rem)] flex-col items-end gap-2 overflow-y-auto overscroll-contain motion-safe:transition-opacity motion-safe:duration-150 motion-reduce:transition-none"
            >
              <CompassRose bearing={bearing} onResetNorth={handleResetNorth} />
              <ViewToggle3D is3D={is3D} onToggle={handleToggle3D} />
              <BasemapToggle
                isSatellite={isSatellite}
                onToggle={() => setIsSatellite((s) => !s)}
              />

              {/* Radius-ring measurement tool toggle. Reuses BasemapToggle's
                  parchment button styling: ≥44px hit target, aria-pressed,
                  focus-visible ring, primary-tinted icon when active. */}
              <button
                type="button"
                onClick={handleToggleRings}
                aria-pressed={ringsEnabled}
                aria-label="Toggle radius rings tool"
                title="Radius rings"
                className={[
                  "flex h-11 w-11 items-center justify-center",
                  "rounded-sm bg-popover border border-border",
                  "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
                  "cursor-pointer transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  ringsEnabled ? "ring-1 ring-primary/50" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <Radius
                  aria-hidden="true"
                  className={[
                    "size-4",
                    ringsEnabled ? "text-primary" : "text-foreground",
                  ].join(" ")}
                />
              </button>
              {ringsEnabled && (
                <p className="max-w-[8.5rem] rounded-sm border border-border bg-popover px-2 py-1 font-mono text-[9px] leading-tight tabular-nums text-muted-foreground shadow-[0_1px_4px_rgba(0,0,0,0.12)]">
                  rings: 5 · 10 · 25 mi
                  {!ringCenter && (
                    <>
                      <br />
                      click map to place
                    </>
                  )}
                </p>
              )}

              {/* Keyboard/SR-accessible counterpart to the bottom-center
                  hover-only coordinate readout (which is aria-hidden and
                  mouse-only — unaffected by this). Toggling this on shows a
                  focusable, non-hidden live readout of the current map
                  center, which updates on keyboard pan/zoom same as mouse
                  drag (both fire onMoveEnd). */}
              <button
                type="button"
                onClick={() => setCoordsLocked((s) => !s)}
                aria-pressed={coordsLocked}
                aria-label={
                  coordsLocked ? "Hide map coordinates readout" : "Show map coordinates readout"
                }
                title="Lock coordinates"
                className={[
                  "flex h-11 w-11 items-center justify-center",
                  "rounded-sm bg-popover border border-border",
                  "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
                  "cursor-pointer transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  coordsLocked ? "ring-1 ring-primary/50" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <Crosshair
                  aria-hidden="true"
                  className={["size-4", coordsLocked ? "text-primary" : "text-foreground"].join(
                    " "
                  )}
                />
              </button>

              {/* Layers control is last in the stack — its own root
                  right-aligns itself independently (see map-layer-control.tsx),
                  so its position here doesn't depend on being narrowest. */}
              <MapLayerControl
                showWater={showWater}
                onToggleWater={() => setShowWater((s) => !s)}
                showPower={showPower}
                onTogglePower={() => setShowPower((s) => !s)}
                showDrought={showDrought}
                onToggleDrought={() => setShowDrought((s) => !s)}
                showWaterStress={showWaterStress}
                onToggleWaterStress={() => setShowWaterStress((s) => !s)}
                showGroundwater={showGroundwater}
                onToggleGroundwater={() => setShowGroundwater((s) => !s)}
                showAquifers={showAquifers}
                onToggleAquifers={() => setShowAquifers((s) => !s)}
                isSatellite={isSatellite}
              />
            </div>
          )}
        </div>

        <Map
          ref={mapRef}
          mapStyle={BASEMAP_STYLE_URL}
          initialViewState={INITIAL_VIEW_STATE}
          style={{ width: "100%", height: "100%" }}
          reuseMaps
          attributionControl={false}
          // Drag must always pan, never tilt/rotate — tilt is opt-in via
          // ViewToggle3D and bearing reset via CompassRose only (see the
          // touchZoomRotate.disableRotation() call in handleMapLoad for the
          // touch two-finger-rotate counterpart). Deliberate: previously
          // ctrl+drag (or right-drag) — a stray modifier on a trackpad, easy
          // to trigger by accident — tilted the map into 3D when a user only
          // meant to pan. Do not restore these default MapLibre bindings.
          dragRotate={false}
          touchPitch={false}
          onLoad={handleMapLoad}
          onClick={handleMapClick}
          onZoomEnd={(e) => setZoom(e.viewState.zoom)}
          onMoveEnd={(e) => {
            setBearing(e.viewState.bearing);
            setIs3D(e.viewState.pitch > 5);
            setMapCenter({ lat: e.viewState.latitude, lon: e.viewState.longitude });
            // Recompute the culled marker set's viewport box. moveend covers
            // pan, zoom, rotate and pitch settling (MapLibre fires it for
            // any camera transform, not just drag) plus every programmatic
            // easeTo/fitBounds/flyTo elsewhere in this file — deliberately
            // not `onMove`, which fires every animation frame mid-gesture.
            updateViewportBounds();
          }}
          onResize={updateViewportBounds}
          onMouseMove={handleMapMouseMove}
          onMouseOut={handleMapMouseOut}
        >
          {/* Zoom controls — compass arrow hidden (replaced by custom CompassRose below) */}
          <NavigationControl
            position="top-right"
            showCompass={false}
          />

          {/* Imperial scale bar — themed to parchment/ink via globals.css */}
          <ScaleControl position="bottom-right" unit="imperial" />

          {/* Esri World Imagery satellite raster, toggled over the vector basemap.
              Added as a layer (NOT a mapStyle swap) so the globe projection set in
              handleMapLoad and the DOM markers persist. Sits above the parchment
              style layers; hidden via layout.visibility unless satellite mode is on. */}
          <Source
            id="esri-satellite"
            type="raster"
            tiles={[SATELLITE_TILE_URL]}
            tileSize={256}
            maxzoom={SATELLITE_MAX_ZOOM}
            attribution={SATELLITE_ATTRIBUTION}
          >
            <Layer
              id="esri-satellite-layer"
              type="raster"
              layout={{ visibility: isSatellite ? "visible" : "none" }}
              paint={{ "raster-fade-duration": 0 }}
            />
          </Source>

          {/* Survey graticule — a lat/long grid that curves under the globe
              projection, part of the "atlas being surveyed" conceit. Hidden
              over satellite imagery (contrast problem there) and faded out
              by z7 so it never clutters facility-level zoom. */}
          <Source id="graticule" type="geojson" data={graticuleData}>
            <Layer
              id="graticule-layer"
              type="line"
              layout={{
                "line-join": "round",
                visibility: isSatellite ? "none" : "visible",
              }}
              paint={{
                "line-color": "#B9A67F",
                "line-width": 0.6,
                "line-opacity": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  2,
                  0.55,
                  5,
                  0.4,
                  7,
                  0,
                ],
              }}
            />
          </Source>

          {/* Optional overlay: drought areas (fill), off by default (Layers control).
              Rendered first among the overlay sources so water/transmission draw on
              top of it. Fill hidden over satellite imagery — a fill clashes with the
              raster. Lazy-loaded: drought.geojson is fetched only while this is on. */}
          {showDrought && (
            <Source id="drought" type="geojson" data="/data/drought.geojson">
              <Layer
                id="drought-fill-layer"
                type="fill"
                layout={{ visibility: isSatellite ? "none" : "visible" }}
                paint={{
                  "fill-color": [
                    "match",
                    ["get", "dm"],
                    0,
                    DROUGHT_RAMP[0],
                    1,
                    DROUGHT_RAMP[1],
                    2,
                    DROUGHT_RAMP[2],
                    3,
                    DROUGHT_RAMP[3],
                    4,
                    DROUGHT_RAMP[4],
                    DROUGHT_RAMP[0],
                  ],
                  "fill-opacity": 0.35,
                }}
              />
            </Source>
          )}

          {/* Optional overlay: waterways (lakes as fill + outline, rivers as line),
              off by default. Lake fill hides over satellite (clashes with imagery);
              the lake outline and river lines stay visible over satellite — lines
              read fine over imagery. Lazy-loaded: water.geojson fetched only when on. */}
          {showWater && (
            <Source id="water" type="geojson" data="/data/water.geojson">
              <Layer
                id="water-lake-fill-layer"
                type="fill"
                filter={["==", ["get", "waterKind"], "lake"]}
                layout={{ visibility: isSatellite ? "none" : "visible" }}
                paint={{ "fill-color": "#8FA9B3", "fill-opacity": 0.35 }}
              />
              <Layer
                id="water-lake-outline-layer"
                type="line"
                filter={["==", ["get", "waterKind"], "lake"]}
                paint={{ "line-color": WATERWAYS_COLOR, "line-width": 0.5 }}
              />
              <Layer
                id="water-river-layer"
                type="line"
                filter={["==", ["get", "waterKind"], "river"]}
                layout={{ "line-join": "round" }}
                paint={{
                  "line-color": WATERWAYS_COLOR,
                  "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 8, 1.6],
                  "line-opacity": 0.65,
                }}
              />
            </Source>
          )}

          {/* Optional overlay: transmission lines >=230 kV, off by default. 1.9 MB —
              lazy-loaded so it's fetched only once this Source mounts, drawn above
              water so lines read clearly over the water/drought fills. */}
          {showPower && (
            <Source id="power" type="geojson" data="/data/power.geojson">
              <Layer
                id="power-layer"
                type="line"
                layout={{ "line-join": "round" }}
                paint={{
                  "line-color": TRANSMISSION_COLOR,
                  "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 1.4],
                  "line-opacity": 0.55,
                }}
              />
            </Source>
          )}

          {/* Optional overlay: WRI Aqueduct baseline water stress (fill), off by
              default. Single-hue light->dark blue-teal ramp keyed on bws_cat
              (0=low .. 4=extreme) — severity reads by LUMINANCE, not hue, so it
              stays legible for color-deficient users. Fill hidden over satellite
              like the other overlay fills. Lazy-loaded: fetched only when on. */}
          {showWaterStress && (
            <Source id="water-stress" type="geojson" data="/data/water-stress.geojson">
              <Layer
                id="water-stress-fill-layer"
                type="fill"
                layout={{ visibility: isSatellite ? "none" : "visible" }}
                paint={{
                  "fill-color": [
                    "match",
                    ["get", "bws_cat"],
                    0,
                    WATER_STRESS_RAMP[0],
                    1,
                    WATER_STRESS_RAMP[1],
                    2,
                    WATER_STRESS_RAMP[2],
                    3,
                    WATER_STRESS_RAMP[3],
                    4,
                    WATER_STRESS_RAMP[4],
                    WATER_STRESS_RAMP[0],
                  ],
                  "fill-opacity": 0.4,
                }}
              />
            </Source>
          )}

          {/* Optional overlay: WRI Aqueduct groundwater table decline (fill), off
              by default. Same single-hue light->dark ramp technique as water
              stress above, but a DIFFERENT hue (violet/plum) so the two water
              layers stay distinguishable while both remain luminance-ordered.
              Keyed on gtd_cat (0=low .. 4=extreme). Lazy-loaded. */}
          {showGroundwater && (
            <Source
              id="groundwater-decline"
              type="geojson"
              data="/data/groundwater-decline.geojson"
            >
              <Layer
                id="groundwater-decline-fill-layer"
                type="fill"
                layout={{ visibility: isSatellite ? "none" : "visible" }}
                paint={{
                  "fill-color": [
                    "match",
                    ["get", "gtd_cat"],
                    0,
                    GROUNDWATER_RAMP[0],
                    1,
                    GROUNDWATER_RAMP[1],
                    2,
                    GROUNDWATER_RAMP[2],
                    3,
                    GROUNDWATER_RAMP[3],
                    4,
                    GROUNDWATER_RAMP[4],
                    GROUNDWATER_RAMP[0],
                  ],
                  "fill-opacity": 0.4,
                }}
              />
            </Source>
          )}

          {/* Optional overlay: USGS principal aquifers (fill + outline), off by
              default. Categorical, not ordinal — a single flat muted earth-tone
              tint (there are too many named aquifers for a per-category scale;
              this is context, not a severity gradient). Fill hidden over
              satellite; the outline stays visible. Lazy-loaded. */}
          {showAquifers && (
            <Source id="aquifers" type="geojson" data="/data/aquifers.geojson">
              <Layer
                id="aquifers-fill-layer"
                type="fill"
                layout={{ visibility: isSatellite ? "none" : "visible" }}
                paint={{ "fill-color": AQUIFER_FILL_COLOR, "fill-opacity": 0.18 }}
              />
              <Layer
                id="aquifers-outline-layer"
                type="line"
                paint={{
                  "line-color": AQUIFER_OUTLINE_COLOR,
                  "line-width": 0.6,
                  "line-opacity": 0.6,
                }}
              />
            </Source>
          )}

          {/* Radius-ring measurement tool: outline-only (no fill) 5/10/25 mi rings
              around the last clicked center, drawn above the optional data
              overlays. Mounts only once a center has been placed; unmounts
              (clearing the rings) when the tool is toggled off. */}
          {ringsData && (
            <Source id="radius-rings" type="geojson" data={ringsData}>
              <Layer
                id="radius-rings-layer"
                type="line"
                layout={{ "line-join": "round" }}
                paint={{
                  "line-color": "#5C5344",
                  "line-width": 1,
                  "line-opacity": 0.7,
                  "line-dasharray": [2, 2],
                  "line-opacity-transition": { duration: reducedMotion ? 0 : 300 },
                }}
              />
            </Source>
          )}

          {clusters.map((cluster) => {
            if (cluster.members.length === 1) {
              const facility = cluster.members[0];
              return (
                <Marker
                  key={facility.id}
                  longitude={facility.location.lon}
                  latitude={facility.location.lat}
                  anchor="center"
                >
                  <FacilityMarker
                    ref={(el) => {
                      markerRefs.current[facility.id] = el;
                      // See the focusin/focusout effect above: reverse
                      // lookup from the DOM node so the culling memo can
                      // tell which cluster currently holds focus.
                      if (el) markerIdByElement.current.set(el, facility.id);
                    }}
                    facility={facility}
                    isSelected={selectedFacility?.id === facility.id}
                    onSelect={handleSelectFacility}
                  />
                </Marker>
              );
            }

            return (
              <Marker
                key={cluster.id}
                longitude={cluster.lon}
                latitude={cluster.lat}
                anchor="center"
              >
                <ClusterMarker
                  ref={(el) => {
                    markerRefs.current[cluster.id] = el;
                    if (el) markerIdByElement.current.set(el, cluster.id);
                  }}
                  count={cluster.members.length}
                  label={`Cluster of ${cluster.members.length} datacenters — activate to zoom in`}
                  onSelect={() => zoomToCluster(cluster)}
                />
              </Marker>
            );
          })}

          {selectedFacility && (
            <Popup
              longitude={selectedFacility.location.lon}
              latitude={selectedFacility.location.lat}
              onClose={handleClosePopup}
              closeOnClick={false}
              closeButton={false}
              // No fixed `anchor` — MapLibre dynamically picks whichever anchor
              // (bottom/top/left/right/corners) keeps the popup inside the map
              // container, preferring "bottom" when there's room (matches the
              // old fixed behavior on every viewport that isn't short). A
              // hardcoded anchor="bottom" always opened the popup ABOVE the
              // marker regardless of available space, which clipped its top
              // (name, operator, status, Close button) on short/landscape-phone
              // maps. `offset={16}` still applies correctly to whichever anchor
              // is chosen — MapLibre derives a symmetric per-anchor offset from
              // a single number (always pushing the popup further away from the
              // marker), so this isn't a fixed-anchor-only behavior. `padding`
              // keeps the chosen anchor's box clear of the map's own edges, the
              // "clamp within the container" half of the fix.
              offset={16}
              padding={{ top: 16, bottom: 16, left: 16, right: 16 }}
              className="atlas-popup"
              maxWidth="none"
            >
              <FacilityPopup
                facility={selectedFacility}
                onClose={handleClosePopup}
              />
            </Popup>
          )}
        </Map>

        {/* Bottom-left: map legend (unchanged position) */}
        <MapLegend />

        {/* Bottom-center: surveyor-style pointer coordinate readout, part of
            the "atlas being surveyed" conceit. Hover-only instrument — not
            meaningful to keyboard/SR users (they can't hover); the sr-only
            guidance above and the /table alternative cover them instead. */}
        {cursor && !coordsLocked && (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 z-10 rounded-sm px-2 py-0.5 font-mono text-[10px] leading-tight tabular-nums text-muted-foreground bg-background/85 backdrop-blur-sm"
          >
            {formatLatLon(cursor.lat, cursor.lon)}
          </p>
        )}

        {/* Keyboard/SR-visible coordinate readout — shown instead of the
            hover-only one above while "lock coordinates" (Crosshair toggle,
            Tools column) is on. Not aria-hidden, so it's announced to screen
            readers as the map center changes; role="status" + aria-live
            keeps that announcement polite rather than interrupting. */}
        {coordsLocked && (
          <p
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 z-10 rounded-sm px-2 py-0.5 font-mono text-[10px] leading-tight tabular-nums text-foreground bg-background/95 border border-border backdrop-blur-sm"
          >
            {formatLatLon(cursor?.lat ?? mapCenter.lat, cursor?.lon ?? mapCenter.lon)}
          </p>
        )}

        {/*
         * Bottom-right: basemap attribution as a small semi-opaque overlay, stacked
         * BELOW the MapLibre ScaleControl — `.maplibregl-ctrl-bottom-right` is shifted
         * up in globals.css to clear this element (see the comment there); the two
         * used to occupy the same bottom-right corner and overlap at every viewport.
         * Inline text links are EXEMPT from WCAG 2.5.8 target-size — these are inline
         * flow links, not interactive controls.
         */}
        {isSatellite ? (
          <p className="absolute bottom-1 right-2 z-10 rounded-sm px-1 py-0.5 text-[10px] leading-tight text-muted-foreground bg-background/85 backdrop-blur-sm">
            Imagery ©{" "}
            <a
              href="https://www.esri.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Esri
            </a>
            , Vantor, Earthstar Geographics
          </p>
        ) : (
          <p className="absolute bottom-1 right-2 z-10 rounded-sm px-1 py-0.5 text-[10px] leading-tight text-muted-foreground bg-background/85 backdrop-blur-sm">
            <a
              href="https://openfreemap.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              OpenFreeMap
            </a>{" "}
            <a
              href="https://www.openmaptiles.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              © OpenMapTiles
            </a>{" "}
            Data from{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              OpenStreetMap
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
