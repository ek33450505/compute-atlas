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
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

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
