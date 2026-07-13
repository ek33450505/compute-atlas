import type { Facility } from "@/lib/schema";
import type { Status } from "@/lib/status";
import type { FacilityType } from "@/lib/facility-type";

// ---------------------------------------------------------------------------
// Form state — mirrors `facilitySchema` (lib/schema.ts) field-for-field.
//
// Every branch of the discriminated union, every array, and every nested
// object gets a slot here even though this sub-unit (2b-1) only renders UI
// for the scalar/location/capacityMw fields. Later sub-units (2b-2 sources,
// 2b-3 statusHistory/subsidies, 2b-4 energy/water/jobs/community/type-
// conditional) add UI against this SAME shape — they must not need to widen
// it. Keeping every field present (at its schema default) from day one means
// every submit in every sub-unit is shape-complete, which matters because
// `updateFacility` does a SHALLOW top-level merge — an absent nested object
// in the patch is fine (merge just won't touch it), but a PRESENT nested
// object must always be the full object, never a partial one.
//
// This module holds ONLY plain, pure state-shaping helpers (no hooks, no
// browser APIs) so it can be imported directly from server components
// (`new/page.tsx`, `[id]/page.tsx`). It intentionally has NO "use client"
// directive — `facility-form.tsx` re-exports these for the client tree, but
// the canonical definitions live here so server components never cross a
// client-file boundary just to build initial state.
// ---------------------------------------------------------------------------

export interface FacilityFormState {
  id: string;
  name: string;
  operator: string;
  status: Status;
  confidence: Facility["confidence"];
  facilityType: FacilityType;
  location: {
    lat: string;
    lon: string;
    city: string;
    county: string;
    state: string;
    precision: "exact" | "approximate" | "representative_multi_site";
    multiSite: {
      enabled: boolean;
      states: string;
      siteCountNote: string;
    };
  };
  capacityMw: {
    planned: string;
    operational: string;
  };
  poweredBy: string;
  announcedDate: string;
  lastUpdated: string;
  notes: string;
  investmentUsd: string;
  landAcres: string;

  // --- Extension points: empty/default shape only, no UI in this sub-unit ---
  statusHistory: Facility["statusHistory"];
  sources: Facility["sources"];
  energy: NonNullable<Facility["energy"]> | Record<string, never>;
  water: NonNullable<Facility["water"]> | Record<string, never>;
  subsidies: NonNullable<Facility["subsidies"]>;
  jobs: NonNullable<Facility["jobs"]> | Record<string, never>;
  community: NonNullable<Facility["community"]> | Record<string, never>;

  // Type-conditional slices (only one is relevant at a time, per facilityType;
  // all three are always present in state so switching facilityType is a pure
  // reset of the inactive slices rather than a shape change).
  aiClassification: string;
  dataCenterEnvironmental: Record<string, unknown>;
  mining: Record<string, unknown>;
  cryptoMiningEnvironmental: Record<string, unknown>;
  generation: Record<string, unknown>;
}

/** Empty type-conditional slice defaults, used both at init and on a type switch. */
export function emptyTypeConditionalState() {
  return {
    aiClassification: "",
    dataCenterEnvironmental: {},
    mining: {},
    cryptoMiningEnvironmental: {},
    generation: {},
  };
}

/** Fresh, empty form state for the CREATE form. */
export function emptyFacilityFormState(): FacilityFormState {
  return {
    id: "",
    name: "",
    operator: "",
    status: "proposed",
    confidence: "reported",
    facilityType: "data_center",
    location: {
      lat: "",
      lon: "",
      city: "",
      county: "",
      state: "",
      precision: "exact",
      multiSite: { enabled: false, states: "", siteCountNote: "" },
    },
    capacityMw: { planned: "", operational: "" },
    poweredBy: "",
    announcedDate: "",
    lastUpdated: "",
    notes: "",
    investmentUsd: "",
    landAcres: "",
    statusHistory: [],
    sources: [],
    energy: {},
    water: {},
    subsidies: [],
    jobs: {},
    community: {},
    ...emptyTypeConditionalState(),
  };
}

/** Converts a loaded `Facility` (edit mode) into the form's string-keyed state shape. */
export function facilityToFormState(facility: Facility): FacilityFormState {
  const base = emptyFacilityFormState();
  return {
    ...base,
    id: facility.id,
    name: facility.name,
    operator: facility.operator,
    status: facility.status,
    confidence: facility.confidence,
    facilityType: facility.facilityType,
    location: {
      lat: String(facility.location.lat),
      lon: String(facility.location.lon),
      city: facility.location.city ?? "",
      county: facility.location.county ?? "",
      state: facility.location.state,
      precision: facility.location.precision ?? "exact",
      multiSite: facility.location.multiSite
        ? {
            enabled: true,
            states: facility.location.multiSite.states.join(", "),
            siteCountNote: facility.location.multiSite.siteCountNote ?? "",
          }
        : base.location.multiSite,
    },
    capacityMw: {
      planned: facility.capacityMw?.planned != null ? String(facility.capacityMw.planned) : "",
      operational:
        facility.capacityMw?.operational != null ? String(facility.capacityMw.operational) : "",
    },
    poweredBy: facility.poweredBy ?? "",
    announcedDate: facility.announcedDate ?? "",
    lastUpdated: facility.lastUpdated,
    notes: facility.notes ?? "",
    investmentUsd: facility.investmentUsd != null ? String(facility.investmentUsd) : "",
    landAcres: facility.landAcres != null ? String(facility.landAcres) : "",
    statusHistory: facility.statusHistory,
    sources: facility.sources,
    energy: facility.energy ?? {},
    water: facility.water ?? {},
    subsidies: facility.subsidies ?? [],
    jobs: facility.jobs ?? {},
    community: facility.community ?? {},
    aiClassification:
      (facility.facilityType === "data_center" || facility.facilityType === "crypto_mining"
        ? facility.aiClassification
        : undefined) ?? "",
    dataCenterEnvironmental:
      facility.facilityType === "data_center" ? (facility.environmental ?? {}) : {},
    mining: facility.facilityType === "crypto_mining" ? (facility.mining ?? {}) : {},
    cryptoMiningEnvironmental:
      facility.facilityType === "crypto_mining" ? (facility.environmental ?? {}) : {},
    generation: facility.facilityType === "power_generation" ? (facility.generation ?? {}) : {},
  };
}
