import type { Facility } from "@/lib/schema";

const TILE = 256;

/**
 * At or above this zoom, clustering is disabled entirely: every facility renders
 * as its own marker. Chosen so that by the time the viewport shows roughly a
 * multi-state / large-region view, all individual sites are visible sooner —
 * surfacing the drama of the total site count earlier in the zoom-in.
 */
export const UNCLUSTER_ZOOM = 4.3;

/** Web-Mercator world-pixel X at a given zoom. */
export function lonToX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * TILE * 2 ** zoom;
}

/** Web-Mercator world-pixel Y at a given zoom. */
export function latToY(lat: number, zoom: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** zoom;
}

export interface Cluster {
  /** Stable id: the anchor (first-member) facility id, prefixed for multi-member clusters. */
  id: string;
  /** Render position = anchor facility's coordinates. */
  lon: number;
  lat: number;
  members: Facility[];
}

/**
 * Greedy pixel-proximity clustering. A facility joins the first existing cluster
 * whose anchor is within radiusPx (at `zoom`); otherwise it anchors a new cluster.
 * GUARANTEE: all returned cluster anchors are pairwise ≥ radiusPx apart, so no two
 * rendered markers overlap below the target-size threshold. Deterministic (sorted by id).
 */
export function clusterFacilities(
  facilities: Facility[],
  zoom: number,
  radiusPx = 44,
  unclusterZoom = UNCLUSTER_ZOOM
): Cluster[] {
  const sorted = [...facilities].sort((a, b) => a.id.localeCompare(b.id));

  // Above the uncluster threshold, every facility is its own marker —
  // no greedy grouping needed. Sorted-by-id order is preserved for determinism.
  if (zoom >= unclusterZoom) {
    return sorted.map((f) => ({
      id: f.id,
      lon: f.location.lon,
      lat: f.location.lat,
      members: [f],
    }));
  }
  const clusters: Array<Cluster & { _x: number; _y: number }> = [];
  const r2 = radiusPx * radiusPx;

  for (const f of sorted) {
    const x = lonToX(f.location.lon, zoom);
    const y = latToY(f.location.lat, zoom);
    let joined = false;
    for (const c of clusters) {
      const dx = x - c._x;
      const dy = y - c._y;
      if (dx * dx + dy * dy < r2) {
        c.members.push(f);
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({
        id: f.id,
        lon: f.location.lon,
        lat: f.location.lat,
        members: [f],
        _x: x,
        _y: y,
      });
    }
  }

  return clusters.map((c) => ({
    id: c.members.length > 1 ? `cluster-${c.id}` : c.id,
    lon: c.lon,
    lat: c.lat,
    members: c.members,
  }));
}

/**
 * Axis-aligned lon/lat viewport bounds — the shape produced from MapLibre's
 * `Map#getBounds()` (via its `getWest`/`getSouth`/`getEast`/`getNorth`
 * accessors). Kept as a plain interface here (rather than importing a
 * maplibre-gl type) so this module has no dependency on the map library.
 */
export interface ViewportBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Fraction of the viewport's own width/height added as a buffer on every
 * side before culling. Without a buffer, a marker at the very edge of the
 * visible viewport would mount/unmount abruptly as it crosses the boundary
 * mid-drag — this keeps a band of markers just outside the visible box
 * mounted, so they're already in place once a small pan brings them into
 * view.
 */
export const VIEWPORT_CULL_BUFFER_RATIO = 0.25;

/**
 * Filters `clusters` down to those likely to be visible: the anchor point
 * (the coordinate a cluster actually renders at — see `Cluster.lon`/`lat`)
 * falls within `bounds`, expanded by `bufferRatio` on every side.
 *
 * `bounds === null` culls nothing (returns `clusters` unchanged) — that's
 * the state before the map's first `load`/`moveend` has fired, when there's
 * no real viewport box to test against yet. Failing open matches the
 * pre-culling behavior for that brief window rather than hiding everything.
 *
 * `keepIds`, if given, force-keeps any cluster whose id it contains
 * regardless of bounds. Used by facility-map.tsx to keep a marker that
 * currently holds DOM focus (or has an open popup) mounted even if a pan
 * has carried it outside the viewport — otherwise React would remove that
 * DOM node out from under the user, and the browser would strand focus on
 * `<body>` with no visible indicator.
 *
 * Deliberately does NOT unwrap the antimeridian (±180° longitude): the
 * dataset and default view are US-only, so a viewport that crosses ±180°
 * longitude is out of scope for this comparison — a documented limitation,
 * not a silent bug.
 */
export function cullClustersToViewport(
  clusters: Cluster[],
  bounds: ViewportBounds | null,
  keepIds?: ReadonlySet<string>,
  bufferRatio: number = VIEWPORT_CULL_BUFFER_RATIO
): Cluster[] {
  if (!bounds) return clusters;

  const lonPad = (bounds.east - bounds.west) * bufferRatio;
  const latPad = (bounds.north - bounds.south) * bufferRatio;
  const west = bounds.west - lonPad;
  const east = bounds.east + lonPad;
  const south = bounds.south - latPad;
  const north = bounds.north + latPad;

  return clusters.filter(
    (c) =>
      (c.lon >= west && c.lon <= east && c.lat >= south && c.lat <= north) ||
      (keepIds?.has(c.id) ?? false)
  );
}
