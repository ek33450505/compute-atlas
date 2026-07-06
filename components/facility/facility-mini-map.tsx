"use client";

import Map, { Marker } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

import { BASEMAP_STYLE_URL } from "@/lib/map";
import { getStatusColor } from "@/lib/status";
import { formatLocation } from "@/lib/format";
import type { Facility } from "@/lib/schema";

interface FacilityMiniMapProps {
  facility: Facility;
}

/**
 * Small supplementary map centered on the facility location.
 *
 * Accessibility contract:
 * - Wrapped in role="img" with aria-label (decorative-supplementary;
 *   the location is fully conveyed in the Key facts text above)
 * - All map interactions disabled (interactive={false}) and NavigationControl
 *   removed so no focusable controls exist inside role="img" (WCAG nested-interactive)
 * - Attribution control disabled (attributionControl={false}) to prevent
 *   anchor links from appearing inside role="img"
 * - Color-only encoding avoided: the status dot is decorative (aria-hidden)
 * - No animation needed; no prefers-reduced-motion handling required
 *
 * Rendered only via FacilityMiniMapDynamic (ssr:false) to keep WebGL
 * out of the SSR boundary.
 */
export function FacilityMiniMap({ facility }: FacilityMiniMapProps) {
  const { location, name, status } = facility;
  const locationLabel = formatLocation(facility);

  return (
    <div
      role="img"
      aria-label={`Map showing ${name} in ${locationLabel}`}
      className="h-64 w-full rounded-lg border overflow-hidden"
    >
      <Map
        mapStyle={BASEMAP_STYLE_URL}
        initialViewState={{
          longitude: location.lon,
          latitude: location.lat,
          zoom: 9,
        }}
        style={{ width: "100%", height: "100%" }}
        reuseMaps
        interactive={false}
        attributionControl={false}
      >
        <Marker
          longitude={location.lon}
          latitude={location.lat}
          anchor="center"
        >
          <div
            aria-hidden="true"
            className="size-4 rounded-full border-2 border-white shadow-md"
            style={{ backgroundColor: getStatusColor(status) }}
          />
        </Marker>
      </Map>
    </div>
  );
}
