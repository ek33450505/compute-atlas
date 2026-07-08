const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export interface GeocodeResult {
  lon: number;
  lat: number;
  label: string;
  /** [minLon, minLat, maxLon, maxLat] when Nominatim returns a boundingbox. */
  bbox?: [number, number, number, number];
}

/** Minimal shape of a single Nominatim /search result item. */
interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  boundingbox?: string[];
}

/**
 * Geocodes a free-text query against OpenStreetMap Nominatim, restricted to
 * the United States. Returns up to 5 results ordered by Nominatim relevance.
 *
 * No API key required. Nominatim's usage policy for websites is satisfied by
 * the browser supplying Origin/Referer headers automatically.
 */
export async function geocodeUS(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const params = new URLSearchParams({
    q: trimmed,
    format: "jsonv2",
    countrycodes: "us",
    addressdetails: "1",
    limit: "5",
  });

  // Nominatim usage policy is satisfied by the browser automatically supplying
  // Referer/Origin headers. User-Agent is a forbidden header for browser fetch
  // and is silently dropped — do NOT attempt to set it here.
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Geocoding failed (${res.status})`);
  }

  const items = (await res.json()) as NominatimItem[];

  return items.map((item): GeocodeResult => {
    const result: GeocodeResult = {
      lon: parseFloat(item.lon),
      lat: parseFloat(item.lat),
      label: item.display_name,
    };

    // Nominatim boundingbox order: [minLat, maxLat, minLon, maxLon] (strings).
    // Convert to GeoJSON-style [minLon, minLat, maxLon, maxLat] numbers.
    if (item.boundingbox && item.boundingbox.length === 4) {
      const [minLat, maxLat, minLon, maxLon] = item.boundingbox.map(Number);
      if ([minLat, maxLat, minLon, maxLon].every(isFinite)) {
        result.bbox = [minLon, minLat, maxLon, maxLat];
      }
    }

    return result;
  });
}
