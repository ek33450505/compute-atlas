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
 * Row shape for the /table client tree (PERF-1 unit C; trimmed in the 2026-11-07 leak audit).
 *
 * Exactly what the table columns and the client-side sort icons read, nothing
 * more: filtering and sorting run on the server over the full record, so no
 * source, county, precision, count or date-announced field ships. No
 * coordinates (the dataset is a paid product; bulk coordinates leave the server
 * only as rounded `MapPoint`s).
 */
interface TableRowBase {
  id: string;
  name: string;
  operator: string;
  status: Facility["status"];
  confidence: Facility["confidence"];
  lastUpdated: Facility["lastUpdated"];
  capacityMw?: Facility["capacityMw"];
  location: { city?: string; state: string };
}

export type TableRow =
  | (TableRowBase & { facilityType: "data_center"; aiClassification?: "confirmed" | "likely" | "mixed_use" })
  | (TableRowBase & { facilityType: "crypto_mining"; aiClassification?: "confirmed" | "likely" | "mixed_use" })
  | (TableRowBase & { facilityType: "power_generation" });

/** Projects a full facility to a `TableRow`. Optional fields are omitted, not `undefined`. */
export function toTableRow(f: Facility): TableRow {
  const base: TableRowBase = {
    id: f.id,
    name: f.name,
    operator: f.operator,
    status: f.status,
    confidence: f.confidence,
    lastUpdated: f.lastUpdated,
    ...(f.capacityMw !== undefined ? { capacityMw: f.capacityMw } : {}),
    location: f.location.city !== undefined
      ? { city: f.location.city, state: f.location.state }
      : { state: f.location.state },
  };
  switch (f.facilityType) {
    case "data_center":
      return {
        ...base,
        facilityType: "data_center",
        ...(f.aiClassification ? { aiClassification: f.aiClassification } : {}),
      };
    case "crypto_mining":
      return {
        ...base,
        facilityType: "crypto_mining",
        ...(f.aiClassification ? { aiClassification: f.aiClassification } : {}),
      };
    case "power_generation":
      return { ...base, facilityType: "power_generation" };
  }
}

/** Mini-map props for the facility detail page: name, status and the one coordinate pair the map centers on. */
export interface MiniMapFacility {
  name: string;
  status: Facility["status"];
  location: { lat: number; lon: number; city?: string; state: string };
}

export function toMiniMapFacility(f: Facility): MiniMapFacility {
  return {
    name: f.name,
    status: f.status,
    location: {
      lat: f.location.lat,
      lon: f.location.lon,
      ...(f.location.city !== undefined ? { city: f.location.city } : {}),
      state: f.location.state,
    },
  };
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
  /** The record's lastUpdated, as stored. */
  lastUpdated: string;
  sourceCount: number;
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
    lastUpdated: f.lastUpdated,
    sourceCount: f.sources.length,
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
