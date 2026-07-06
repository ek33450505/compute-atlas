"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Map, {
  Marker,
  Popup,
  NavigationControl,
  type MapRef,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

import { BASEMAP_STYLE_URL, INITIAL_VIEW_STATE } from "@/lib/map";
import { clusterFacilities, type Cluster } from "@/lib/cluster";
import { FacilityMarker } from "@/components/map/facility-marker";
import { ClusterMarker } from "@/components/map/cluster-marker";
import { FacilityPopup } from "@/components/map/facility-popup";
import { MapLegend } from "@/components/map/map-legend";
import type { Facility } from "@/lib/schema";

interface FacilityMapProps {
  facilities: Facility[];
  /** Tailwind height classes for the map container. Defaults to "h-[70vh] min-h-[420px]". */
  heightClass?: string;
}

/**
 * Interactive map of AI datacenter facilities.
 *
 * Design decisions:
 * - Accessible DOM markers (<button> elements), NOT canvas cluster layers.
 *   Screen readers can tab through all visible markers/clusters; each has a descriptive aria-label.
 *   Clustering is zoom-dependent: facilities within 44px of each other are grouped into a
 *   ClusterMarker bubble. Activating a cluster calls fitBounds to zoom into that group.
 * - Basemap: OpenFreeMap positron (free, no API key, low-saturation).
 *   TODO: theme-aware/dark basemap + self-hosted PMTiles later.
 * - prefers-reduced-motion: when enabled, easeTo/fitBounds uses duration 0 (instant);
 *   otherwise animation runs over 600 ms.
 * - Focus management: closing a popup returns focus to the triggering marker button.
 */
export function FacilityMap({
  facilities,
  heightClass = "h-[70vh] min-h-[420px]",
}: FacilityMapProps) {
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(
    null
  );
  const [zoom, setZoom] = useState<number>(INITIAL_VIEW_STATE.zoom);
  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const lastSelectedIdRef = useRef<string | null>(null);
  const mapRef = useRef<MapRef>(null);

  // Recompute clusters only when facilities or zoom changes (pan-invariant).
  const clusters = useMemo(
    () => clusterFacilities(facilities, zoom),
    [facilities, zoom]
  );

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

      const lons = cluster.members.map((f) => f.location.lon);
      const lats = cluster.members.map((f) => f.location.lat);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);

      // Degenerate bbox: all members are essentially co-located — just zoom in.
      const isCoinPoint = maxLon - minLon < 0.001 && maxLat - minLat < 0.001;
      if (isCoinPoint) {
        map.easeTo({
          center: [cluster.lon, cluster.lat],
          zoom: Math.min(zoom + 3, 12),
          duration: reducedMotion ? 0 : 600,
        });
      } else {
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
          padding: 80,
          maxZoom: 12,
          duration: reducedMotion ? 0 : 600,
        });
      }
    },
    [zoom, reducedMotion]
  );

  // MapLibre adds role="button" + aria-label="Map marker" to every Marker
  // wrapper div automatically, creating a nested-interactive a11y violation
  // (role="button" > <button>) flagged by WCAG 2.5.8 / axe nested-interactive.
  // We strip the outer role/label via the map's onLoad event (fired after the
  // maplibre Map and all markers have fully initialised) and then watch for any
  // future additions via a MutationObserver.
  const moRef = useRef<MutationObserver | null>(null);

  const handleMapLoad = useCallback(() => {
    const mapEl = mapRef.current?.getContainer();
    if (!mapEl) return;

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
  }, []);

  // Disconnect observer on unmount
  useEffect(() => () => moRef.current?.disconnect(), []);

  return (
    <div
      role="region"
      aria-label="Map of AI datacenters in the United States"
    >
      {/* Visually-hidden guidance for screen reader users */}
      <p className="sr-only">
        Interactive map showing AI datacenter locations across the United
        States. Each location is a focusable button. A data table alternative
        is available at the{" "}
        <a href="/table" className="underline">
          data table page
        </a>
        .
      </p>

      <div className={`relative ${heightClass} w-full rounded-lg overflow-hidden border`}>
        <Map
          ref={mapRef}
          mapStyle={BASEMAP_STYLE_URL}
          initialViewState={INITIAL_VIEW_STATE}
          style={{ width: "100%", height: "100%" }}
          reuseMaps
          attributionControl={false}
          onLoad={handleMapLoad}
          onZoomEnd={(e) => setZoom(e.viewState.zoom)}
        >
          <NavigationControl
            position="top-right"
            showCompass={false}
          />

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
            >
              <FacilityPopup
                facility={selectedFacility}
                onClose={handleClosePopup}
              />
            </Popup>
          )}
        </Map>

        <MapLegend />
      </div>

      {/* Basemap attribution rendered below the map canvas (not overlaid) so it
          never collides with geo-positioned markers — WCAG 2.5.8 target-size.
          Inline links in text flow are exempt from the minimum target-size rule. */}
      <p className="mt-2 text-xs text-muted-foreground">
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
    </div>
  );
}
