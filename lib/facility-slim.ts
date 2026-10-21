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

/**
 * Row shape for the /table client tree (PERF-1 unit C).
 *
 * What the table columns, the filters, the CSV export and the toggle-mode map
 * read: no statusHistory, community, notes or full `sources` array. It extends
 * `MapFacility` (so the toggle map takes rows directly, which is why it also
 * carries precision, multiSite and the crypto fields the map popup shows) with
 * the CSV and table-only fields. Coordinates keep FULL
 * precision because the CSV exports them; `sources` still holds only the
 * first source and `sourceCount` carries the real length.
 */
interface TableExtras {
  lastUpdated: Facility["lastUpdated"];
  announcedDate?: string;
  /** `sources.length` of the full record (the projected `sources` holds only the first). */
  sourceCount: number;
  location: { county?: string };
}

export type TableRow =
  | (MapDataCenter & TableExtras)
  | (MapCryptoMining & TableExtras & { aiClassification?: "confirmed" | "likely" | "mixed_use" })
  | (MapPowerGeneration & TableExtras & { generation?: { offtaker?: string } });

/** Projects a full facility to a `TableRow`. Optional fields are omitted, not `undefined`. */
export function toTableRow(f: Facility): TableRow {
  const slim = toMapFacility(f);
  const location = { ...slim.location, lat: f.location.lat, lon: f.location.lon };
  const extras = {
    location: f.location.county !== undefined ? { ...location, county: f.location.county } : location,
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
