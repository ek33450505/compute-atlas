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
        // Deliberately NOT `reuseMaps`. `reuseMaps` pools maplibre-gl Map
        // instances in a GLOBAL stack (@vis.gl/react-maplibre's
        // Maplibre.savedMaps) shared by every <Map reuseMaps> in the app —
        // including FacilityMap on /map. This map is `interactive={false}`,
        // which suppresses maplibre-gl's one-time initial handler.enable()
        // calls at construction (dragPan/touchZoomRotate/scrollZoom/etc. are
        // never truly enabled). If THIS instance were pooled and later
        // recycled into /map, react-map-gl's prop-diffing can't detect
        // anything changed for any handler prop neither component sets
        // explicitly (`nextProp ?? true` equals `prevProp ?? true`), so it
        // never re-enables them — silently killing drag-pan, pinch-zoom,
        // wheel-zoom, and keyboard pan on /map after visiting any facility
        // page. Root-caused via reproduction: /facilities/[slug] -> in-page
        // nav to /map. See facility-map.tsx's handleMapLoad for the
        // matching defensive fix on the consuming side — keep BOTH; this
        // one stops a non-interactive instance from ever entering the pool,
        // that one makes /map correct regardless of what any other
        // <Map reuseMaps> consumer does. Do not re-add reuseMaps here
        // without also auditing every other pooled consumer's handler props.
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
