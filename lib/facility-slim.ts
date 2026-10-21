import type { Facility, Source } from "@/lib/schema";

/**
 * Slim facility shape for the /map client tree (PERF-1).
 *
 * `/map` is a server page that hands facilities to a client component, so every
 * field on the prop is serialized into the HTML/RSC payload. The full record is
 * ~6.2 MB raw, ~70% of it (sources, notes, statusHistory, ...) never read by the
 * map. `toMapFacility` projects on the server so only the fields the map's
 * markers, filters, clustering and popup actually read cross the boundary.
 *
 * The field list is derived from the client tree (facility-marker, facility-popup,
 * facility-map, lib/map, lib/cluster, lib/filters) and enforced by the type
 * system: those modules accept `MapFacility`/`FilterableFacility`, so reading a
 * dropped field is a compile error. A full `Facility` is structurally assignable
 * to `MapFacility`, so non-/map callers (e.g. /embed) keep passing full records.
 *
 * Marker coordinates are rounded to 4 decimal places (~11 m).
 */

/** Fields `filterFacilities` / `getFilterOptions` read. */
export interface FilterableFacility {
  name: string;
  operator: string;
  status: Facility["status"];
  facilityType: Facility["facilityType"];
  capacityMw?: Facility["capacityMw"];
  location: { city?: string; state: string };
}

/** Only the first source is ever shown (popup "Source" link). */
export type MapSource = Pick<Source, "url" | "label">;

interface MapFacilityBase extends FilterableFacility {
  id: string;
  confidence: Facility["confidence"];
  location: {
    lat: number;
    lon: number;
    city?: string;
    state: string;
    /** Omitted by the projector when "exact" (the default). */
    precision?: Facility["location"]["precision"];
    multiSite?: { states: string[] };
  };
  sources: MapSource[];
}

interface MapDataCenter extends MapFacilityBase {
  facilityType: "data_center";
  aiClassification?: "confirmed" | "likely" | "mixed_use";
}

interface MapCryptoMining extends MapFacilityBase {
  facilityType: "crypto_mining";
  mining?: {
    hashRateThPerS?: number;
    powerArrangement?: string;
  };
  environmental?: { carbonIntensityProxy?: number };
}

interface MapPowerGeneration extends MapFacilityBase {
  facilityType: "power_generation";
}

export type MapFacility = MapDataCenter | MapCryptoMining | MapPowerGeneration;

/** Marker coordinate precision: 4 dp is ~11 m. */
const COORD_DP = 4;

function roundCoord(n: number): number {
  const m = 10 ** COORD_DP;
  return Math.round(n * m) / m;
}

/**
 * Projects a full facility to the fields the /map client tree reads.
 * Optional fields are omitted (not `undefined`) so they do not serialize.
 */
export function toMapFacility(f: Facility): MapFacility {
  const location: MapFacilityBase["location"] = {
    lat: roundCoord(f.location.lat),
    lon: roundCoord(f.location.lon),
    state: f.location.state,
  };
  if (f.location.city !== undefined) location.city = f.location.city;
  if (f.location.precision && f.location.precision !== "exact") location.precision = f.location.precision;
  if (f.location.multiSite) {
    location.multiSite = { states: f.location.multiSite.states };
  }

  // Runtime DB reads are not re-validated (lib/data.ts), so a row may have no
  // sources; project an empty list rather than throwing and failing /map.
  const first: Source | undefined = f.sources[0];
  const base = {
    id: f.id,
    name: f.name,
    operator: f.operator,
    status: f.status,
    confidence: f.confidence,
    location,
    sources: first ? [{ url: first.url, label: first.label }] : [],
    ...(f.capacityMw ? { capacityMw: f.capacityMw } : {}),
  };

  switch (f.facilityType) {
    case "data_center":
      return {
        ...base,
        facilityType: "data_center",
        ...(f.aiClassification ? { aiClassification: f.aiClassification } : {}),
      };
    case "crypto_mining": {
      const mining: NonNullable<MapCryptoMining["mining"]> = {};
      if (f.mining?.hashRateThPerS !== undefined) {
        mining.hashRateThPerS = f.mining.hashRateThPerS;
      }
      if (f.mining?.powerArrangement) {
        mining.powerArrangement = f.mining.powerArrangement;
      }
      return {
        ...base,
        facilityType: "crypto_mining",
        ...(Object.keys(mining).length > 0 ? { mining } : {}),
        ...(f.environmental?.carbonIntensityProxy !== undefined
          ? { environmental: { carbonIntensityProxy: f.environmental.carbonIntensityProxy } }
          : {}),
      };
    }
    case "power_generation":
      return { ...base, facilityType: "power_generation" };
  }
}
