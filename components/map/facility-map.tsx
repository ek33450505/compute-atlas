"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
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
import { Radius } from "lucide-react";
import type { FeatureCollection, Polygon } from "geojson";

import {
  BASEMAP_STYLE_URL,
  INITIAL_VIEW_STATE,
  SATELLITE_TILE_URL,
  SATELLITE_ATTRIBUTION,
  SATELLITE_MAX_ZOOM,
  computeFacilitiesBounds,
} from "@/lib/map";
import { clusterFacilities, type Cluster } from "@/lib/cluster";
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
import type { Facility } from "@/lib/schema";
import type { GeocodeResult } from "@/lib/geocode";

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
  // Optional overlay layers (Layers control) — off by default, lazy-loaded:
  // each corresponding <Source> only mounts (and fetches its GeoJSON) once
  // its flag flips true, so the 1.9 MB power.geojson never loads unrequested.
  const [showWater, setShowWater] = useState<boolean>(false);
  const [showPower, setShowPower] = useState<boolean>(false);
  const [showDrought, setShowDrought] = useState<boolean>(false);

  // Radius-ring measurement tool: off by default, on-demand. When enabled, the
  // next map click sets a center; 3, distance rings (5/10/25 mi) are drawn
  // around it. Toggling off (or re-toggling on) clears the center, which
  // unmounts the rings Source below.
  const [ringsEnabled, setRingsEnabled] = useState<boolean>(false);
  const [ringCenter, setRingCenter] = useState<{ lon: number; lat: number } | null>(
    null
  );

  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const lastSelectedIdRef = useRef<string | null>(null);
  const mapRef = useRef<MapRef>(null);

  // Recompute clusters only when facilities or zoom changes (pan-invariant).
  const clusters = useMemo(
    () => clusterFacilities(facilities, zoom),
    [facilities, zoom]
  );

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
   */
  const surveyToFacilities = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const b = computeFacilitiesBounds(facilities);
    if (!b) return; // empty filtered set — leave the camera where it is

    const duration = reducedMotion ? 0 : 1400; // slower, deliberate "survey pass"
    if (b.isCoincident) {
      map.easeTo({ center: b.center, zoom: 9, duration });
    } else {
      map.fitBounds(b.bounds, { padding: 96, maxZoom: 9, duration });
    }
  }, [facilities, reducedMotion]);

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

    const strip = () => {
      mapEl
        .querySelectorAll<HTMLElement>('.maplibregl-marker[role="button"]')
        .forEach((el) => {
          el.removeAttribute("role");
          el.removeAttribute("aria-label");
        });
    };

    strip();

    const mo = new MutationObserver(strip);
    mo.observe(mapEl, {
      childList: true,
      subtree: true,
      attributeFilter: ["role"],
    });
    moRef.current = mo;

    // Deep-linked arrival with an active filter: run the survey-pass once the
    // map is ready, rather than starting on the default US view then jumping.
    if (surveyOnMount) {
      surveyToFacilities();
    }
    mapReadyRef.current = true;
  }, [surveyOnMount, surveyToFacilities]);

  // Disconnect observer on unmount
  useEffect(() => () => moRef.current?.disconnect(), []);

  // Survey-pass on filter changes (facilities identity change), skipping the
  // initial mount — that's handled by handleMapLoad above (once, gated on
  // surveyOnMount) so a fresh mount never double-fires the camera move.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!mapReadyRef.current) return;
    surveyToFacilities();
  }, [facilities, surveyToFacilities]);

  return (
    <div
      role="region"
      aria-label="Map of data centers in the United States"
      className={heightClass}
    >
      {/* Visually-hidden guidance for screen reader users */}
      <p className="sr-only">
        Interactive map showing data center locations across the United
        States. Each location is a focusable button. A data table alternative
        is available at the{" "}
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
        <Map
          ref={mapRef}
          mapStyle={BASEMAP_STYLE_URL}
          initialViewState={INITIAL_VIEW_STATE}
          style={{ width: "100%", height: "100%" }}
          reuseMaps
          attributionControl={false}
          onLoad={handleMapLoad}
          onClick={handleMapClick}
          onZoomEnd={(e) => setZoom(e.viewState.zoom)}
          onMoveEnd={(e) => {
            setBearing(e.viewState.bearing);
            setIs3D(e.viewState.pitch > 5);
          }}
          onMouseMove={(e) =>
            setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng })
          }
          onMouseOut={() => setCursor(null)}
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
                    "#EBD9B0",
                    1,
                    "#E3C489",
                    2,
                    "#D69C5A",
                    3,
                    "#B5702F",
                    4,
                    "#8F4108",
                    "#EBD9B0",
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
                paint={{ "line-color": "#5E7D8A", "line-width": 0.5 }}
              />
              <Layer
                id="water-river-layer"
                type="line"
                filter={["==", ["get", "waterKind"], "river"]}
                layout={{ "line-join": "round" }}
                paint={{
                  "line-color": "#5E7D8A",
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
                  "line-color": "#8F4108",
                  "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 1.4],
                  "line-opacity": 0.55,
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
              anchor="bottom"
              offset={16}
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
        <div className="absolute top-20 right-2 z-20 flex flex-col gap-2">
          <CompassRose bearing={bearing} onResetNorth={handleResetNorth} />
          <ViewToggle3D is3D={is3D} onToggle={handleToggle3D} />
          <BasemapToggle
            isSatellite={isSatellite}
            onToggle={() => setIsSatellite((s) => !s)}
          />
          <MapLayerControl
            showWater={showWater}
            onToggleWater={() => setShowWater((s) => !s)}
            showPower={showPower}
            onTogglePower={() => setShowPower((s) => !s)}
            showDrought={showDrought}
            onToggleDrought={() => setShowDrought((s) => !s)}
          />

          {/* Radius-ring measurement tool toggle. Reuses BasemapToggle's
              parchment button styling: ≥44px hit target, aria-pressed,
              focus-visible ring, primary-tinted icon when active. */}
          <button
            type="button"
            onClick={handleToggleRings}
            aria-pressed={ringsEnabled}
            aria-label="Toggle radius rings tool"
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
              className={["size-4", ringsEnabled ? "text-primary" : "text-foreground"].join(
                " "
              )}
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
        </div>

        {/* Bottom-left: map legend (unchanged position) */}
        <MapLegend />

        {/* Bottom-center: surveyor-style pointer coordinate readout, part of
            the "atlas being surveyed" conceit. Hover-only instrument — not
            meaningful to keyboard/SR users (they can't hover); the sr-only
            guidance above and the /table alternative cover them instead. */}
        {cursor && (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 z-10 rounded-sm px-2 py-0.5 font-mono text-[10px] leading-tight tabular-nums text-muted-foreground bg-background/85 backdrop-blur-sm"
          >
            {formatLatLon(cursor.lat, cursor.lon)}
          </p>
        )}

        {/*
         * Bottom-right: basemap attribution as a small semi-opaque overlay, stacked
         * beneath the MapLibre ScaleControl. Inline text links are EXEMPT from
         * WCAG 2.5.8 target-size — these are inline flow links, not interactive controls.
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
