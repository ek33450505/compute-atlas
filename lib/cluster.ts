import type { Facility } from "@/lib/schema";

const TILE = 256;

/** Web-Mercator world-pixel X at a given zoom (matches scripts/compute-marker-offsets.py). */
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
  radiusPx = 44
): Cluster[] {
  const sorted = [...facilities].sort((a, b) => a.id.localeCompare(b.id));
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
