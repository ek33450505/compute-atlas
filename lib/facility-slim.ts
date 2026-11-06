import type { Facility, Source } from "@/lib/schema";
import type { NearestTransmission, NearestWater, SitingContext } from "@/lib/siting-context";

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

/**
 * Row shape for the /table client tree (PERF-1 unit C).
 *
 * What the table columns and filters read: no statusHistory, community, notes,
 * full `sources` array or coordinates (the dataset is a paid product; bulk
 * coordinates leave the server only as rounded `MapPoint`s). `sources` still
 * holds only the first source and `sourceCount` carries the real length.
 */
interface TableExtras {
  lastUpdated: Facility["lastUpdated"];
  announcedDate?: string;
  /** `sources.length` of the full record (the projected `sources` holds only the first). */
  sourceCount: number;
  location: { county?: string };
}

/** `MapFacility` location without coordinates. */
type RowLocation = Omit<MapFacilityBase["location"], "lat" | "lon">;
type WithoutCoords<T extends MapFacilityBase> = Omit<T, "location"> & { location: RowLocation };

export type TableRow =
  | (WithoutCoords<MapDataCenter> & TableExtras)
  | (WithoutCoords<MapCryptoMining> & TableExtras & { aiClassification?: "confirmed" | "likely" | "mixed_use" })
  | (WithoutCoords<MapPowerGeneration> & TableExtras & { generation?: { offtaker?: string } });

/** Projects a full facility to a `TableRow`. Optional fields are omitted, not `undefined`. */
export function toTableRow(f: Facility): TableRow {
  const { location: mapLocation, ...slim } = toMapFacility(f);
  const coordFree: RowLocation = { state: mapLocation.state };
  if (mapLocation.city !== undefined) coordFree.city = mapLocation.city;
  if (mapLocation.precision !== undefined) coordFree.precision = mapLocation.precision;
  if (mapLocation.multiSite !== undefined) coordFree.multiSite = mapLocation.multiSite;
  const extras = {
    location: f.location.county !== undefined ? { ...coordFree, county: f.location.county } : coordFree,
    lastUpdated: f.lastUpdated,
    sourceCount: f.sources.length,
    ...(f.announcedDate !== undefined ? { announcedDate: f.announcedDate } : {}),
  };
  switch (slim.facilityType) {
    case "data_center":
      return { ...slim, ...extras };
    case "crypto_mining":
      return {
        ...slim,
        ...extras,
        ...(f.facilityType === "crypto_mining" && f.aiClassification
          ? { aiClassification: f.aiClassification }
          : {}),
      };
    case "power_generation": {
      const offtaker = f.facilityType === "power_generation" ? f.generation?.offtaker : undefined;
      return { ...slim, ...extras, ...(offtaker !== undefined ? { generation: { offtaker } } : {}) };
    }
  }
}

/**
 * Minimal map payload: just enough to place and color a marker. No name,
 * operator, city or capacity; details load on click via `PopupSummary`.
 * Coordinates are rounded to 2 decimals (~1 km).
 */
export interface MapPoint {
  id: string;
  facilityType: Facility["facilityType"];
  status: Facility["status"];
  location: { lat: number; lon: number; state: string };
}

const POINT_DP = 2;

function roundPoint(n: number): number {
  const m = 10 ** POINT_DP;
  // Half away from zero, so +/- ties round symmetrically.
  return (Math.sign(n) * Math.round(Math.abs(n) * m)) / m;
}

export function toMapPoint(f: Facility): MapPoint {
  return {
    id: f.id,
    facilityType: f.facilityType,
    status: f.status,
    location: {
      lat: roundPoint(f.location.lat),
      lon: roundPoint(f.location.lon),
      state: f.location.state,
    },
  };
}

/**
 * Click-time popup payload. Deliberately carries NO coordinates: the rounded
 * marker position is all the client ever gets.
 */
export interface PopupSummary {
  id: string;
  name: string;
  operator: string;
  status: Facility["status"];
  facilityType: Facility["facilityType"];
  confidence: Facility["confidence"];
  city?: string;
  state: string;
  multiSiteStates?: string[];
  /** Present only when the location is not exact. */
  precision?: Facility["location"]["precision"];
  capacityMw?: Facility["capacityMw"];
  aiClassification?: "confirmed" | "likely" | "mixed_use";
  mining?: { hashRateThPerS?: number; powerArrangement?: string };
  carbonIntensityProxy?: number;
  source?: MapSource;
  nearestWater?: NearestWater;
  nearestTransmission?: NearestTransmission;
}

export function toPopupSummary(f: Facility, siting?: SitingContext): PopupSummary {
  const m = toMapFacility(f);
  const out: PopupSummary = {
    id: f.id,
    name: f.name,
    operator: f.operator,
    status: f.status,
    facilityType: f.facilityType,
    confidence: f.confidence,
    state: f.location.state,
  };
  if (m.location.city !== undefined) out.city = m.location.city;
  if (m.location.multiSite) out.multiSiteStates = m.location.multiSite.states;
  if (m.location.precision) out.precision = m.location.precision;
  if (m.capacityMw) out.capacityMw = m.capacityMw;
  if (m.sources[0]) out.source = m.sources[0];
  if (f.facilityType !== "power_generation" && f.aiClassification) {
    out.aiClassification = f.aiClassification;
  }
  if (m.facilityType === "crypto_mining") {
    if (m.mining) out.mining = m.mining;
    if (m.environmental?.carbonIntensityProxy !== undefined) {
      out.carbonIntensityProxy = m.environmental.carbonIntensityProxy;
    }
  }
  // Copied field by field so a key added to the siting JSON later can't ride
  // along into a public payload.
  if (siting?.nearestWater) {
    const { name, kind, distanceMi } = siting.nearestWater;
    out.nearestWater = { name, kind, distanceMi };
  }
  if (siting?.nearestTransmission) {
    const { voltageKv, distanceMi } = siting.nearestTransmission;
    out.nearestTransmission = { voltageKv, distanceMi };
  }
  return out;
}
