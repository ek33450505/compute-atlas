const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export interface ParsedCoordinates {
  lat: number;
  lon: number;
}

const SIGNED_DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Parses a combined "lat, lon" string — the format Google Maps puts on the
 * clipboard when you right-click a spot and choose the coordinates — into
 * numeric latitude/longitude. Pure and synchronous: no network call, so it's
 * unit-testable with zero mocking (see geocodeUS below for the network half).
 *
 * Tolerates the variants people actually paste: extra whitespace, no space
 * after the comma, surrounding parentheses, and a trailing degree symbol on
 * either number (e.g. "(39.51°, -98.53°)"). Returns `null` — never throws —
 * for anything that doesn't resolve to two numbers within valid coordinate
 * ranges (lat -90..90, lon -180..180).
 *
 * Every valid US longitude is NEGATIVE. Do not "helpfully" coerce sign here —
 * a parser that drops the minus would place a facility in China.
 */
export function parseCoordinateString(input: string): ParsedCoordinates | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Strip one layer of surrounding parentheses: "(39.51, -98.53)".
  const unwrapped =
    trimmed.startsWith("(") && trimmed.endsWith(")")
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  const parts = unwrapped.split(",");
  if (parts.length !== 2) return null;

  const [rawLat, rawLon] = parts.map((p) => p.trim().replace(/°/g, "").trim());
  if (!rawLat || !rawLon) return null;
  if (!SIGNED_DECIMAL_RE.test(rawLat) || !SIGNED_DECIMAL_RE.test(rawLon)) return null;

  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;

  return { lat, lon };
}

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
