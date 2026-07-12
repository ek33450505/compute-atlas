/**
 * Graticule generation for the "atlas being surveyed" map conceit — a lat/long
 * grid of meridians and parallels, densified so each straight-line segment
 * curves smoothly when MapLibre projects it under the globe projection.
 */

/** Degrees of longitude/latitude spanned by one densified vertex step. */
const DEFAULT_STEP_DEG = 10;
const DEFAULT_DENSIFY_DEG = 2;

/** Meridians/parallels stop short of the poles to avoid degenerate geometry there. */
const LAT_BOUND = 80;
const LON_BOUND = 180;

/** Small epsilon for float-drift guarding when stepping toward a bound. */
const EPS = 1e-9;

/**
 * Builds a densified lat/long graticule as a GeoJSON FeatureCollection of
 * LineStrings — meridians (constant longitude) and parallels (constant
 * latitude) — so each line renders as a smooth curve under MapLibre's globe
 * projection (which projects every vertex independently).
 *
 * Meridians run lat -80..80 at each `stepDeg` step of longitude in [-180, 180].
 * Parallels run lon -180..180 at each `stepDeg` step of latitude in [-80, 80].
 * Each line is densified with a vertex every `densifyDeg` degrees, and the
 * final vertex is snapped exactly to the bound (guards against float drift).
 */
export function buildGraticuleGeoJSON(
  stepDeg: number = DEFAULT_STEP_DEG,
  densifyDeg: number = DEFAULT_DENSIFY_DEG
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  for (let lon = -LON_BOUND; lon <= LON_BOUND + EPS; lon += stepDeg) {
    const clampedLon = Math.min(lon, LON_BOUND);
    features.push(meridian(clampedLon, densifyDeg));
  }

  for (let lat = -LAT_BOUND; lat <= LAT_BOUND + EPS; lat += stepDeg) {
    const clampedLat = Math.min(lat, LAT_BOUND);
    features.push(parallel(clampedLat, densifyDeg));
  }

  return { type: "FeatureCollection", features };
}

/** A single meridian (constant longitude) LineString from lat -80 to 80. */
function meridian(lon: number, densifyDeg: number): GeoJSON.Feature<GeoJSON.LineString> {
  const coordinates = densifiedRange(-LAT_BOUND, LAT_BOUND, densifyDeg).map(
    (lat): GeoJSON.Position => [lon, lat]
  );
  return { type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} };
}

/** A single parallel (constant latitude) LineString from lon -180 to 180. */
function parallel(lat: number, densifyDeg: number): GeoJSON.Feature<GeoJSON.LineString> {
  const coordinates = densifiedRange(-LON_BOUND, LON_BOUND, densifyDeg).map(
    (lon): GeoJSON.Position => [lon, lat]
  );
  return { type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} };
}

/**
 * Vertices from `start` to `end` every `stepDeg` degrees, guaranteed to land
 * exactly on `end` as the final vertex (guards against float drift).
 */
function densifiedRange(start: number, end: number, stepDeg: number): number[] {
  const values: number[] = [];
  for (let v = start; v < end - EPS; v += stepDeg) {
    values.push(v);
  }
  values.push(end);
  return values;
}

/**
 * Surveyor-style pointer readout, e.g. lat 40.7128, lon -74.006 →
 * "40.71° N · 74.01° W". Two decimals, absolute values, hemisphere suffix
 * (N/S for latitude, E/W for longitude); the equator and prime meridian
 * report N/E respectively (lat >= 0 -> N, lon >= 0 -> E).
 */
export function formatLatLon(lat: number, lon: number): string {
  const latHemi = lat >= 0 ? "N" : "S";
  const lonHemi = lon >= 0 ? "E" : "W";
  const latStr = Math.abs(lat).toFixed(2);
  const lonStr = Math.abs(lon).toFixed(2);
  return `${latStr}° ${latHemi} · ${lonStr}° ${lonHemi}`;
}
