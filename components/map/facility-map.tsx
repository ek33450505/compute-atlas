"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Map, {
  Marker,
  Popup,
  NavigationControl,
  type MapRef,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

import { BASEMAP_STYLE_URL, INITIAL_VIEW_STATE } from "@/lib/map";
import { FacilityMarker } from "@/components/map/facility-marker";
import { FacilityPopup } from "@/components/map/facility-popup";
import { MapLegend } from "@/components/map/map-legend";
import type { Facility } from "@/lib/schema";

interface FacilityMapProps {
  facilities: Facility[];
}

/**
 * Interactive map of AI datacenter facilities.
 *
 * Design decisions:
 * - Accessible DOM markers (<button> elements), NOT canvas cluster layers.
 *   Screen readers can tab through all 22 markers; each has a descriptive aria-label.
 *   TODO(M3+): clustering when dataset grows beyond ~50 facilities.
 * - Basemap: OpenFreeMap positron (free, no API key, low-saturation).
 *   TODO: theme-aware/dark basemap + self-hosted PMTiles later.
 * - prefers-reduced-motion: when enabled, easeTo uses duration 0 (instant);
 *   otherwise the selected marker eases into view over 600 ms.
 * - Focus management: closing a popup returns focus to the triggering marker button.
 */
export function FacilityMap({ facilities }: FacilityMapProps) {
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(
    null
  );
  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const lastSelectedIdRef = useRef<string | null>(null);
  const mapRef = useRef<MapRef>(null);

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

      <div className="relative h-[70vh] min-h-[420px] w-full rounded-lg overflow-hidden border">
        <Map
          ref={mapRef}
          mapStyle={BASEMAP_STYLE_URL}
          initialViewState={INITIAL_VIEW_STATE}
          style={{ width: "100%", height: "100%" }}
          reuseMaps
        >
          <NavigationControl
            position="top-right"
            showCompass={false}
          />

          {/* TODO(M3+): clustering when dataset grows */}
          {facilities.map((facility) => (
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
          ))}

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
    </div>
  );
}
