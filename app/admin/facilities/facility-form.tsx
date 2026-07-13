"use client";

import { useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confidenceEnum, type Facility } from "@/lib/schema";
import { STATUS_ORDER, STATUS_META, type Status } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META, type FacilityType } from "@/lib/facility-type";
import {
  createFacilityAction,
  updateFacilityAction,
} from "@/app/admin/facilities/facility-form-actions";

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
function emptyTypeConditionalState() {
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

/**
 * Builds the `unknown` payload sent to `createFacility`/`updateFacility`.
 * Numeric string fields parse to `number | undefined` (empty string ->
 * undefined, never `NaN` or `0`). Nested objects (`location`, `capacityMw`,
 * `energy`, `water`, `jobs`, `community`) are ALWAYS submitted as complete
 * objects (never a partial/omitted-key patch) — required because
 * `updateFacility` does a shallow top-level merge; a partial nested object
 * would look "present" to the merge and silently blank sibling fields.
 */
export function buildFacilityPayload(state: FacilityFormState): Record<string, unknown> {
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));

  const location: Record<string, unknown> = {
    lat: num(state.location.lat) ?? 0,
    lon: num(state.location.lon) ?? 0,
    state: state.location.state.toUpperCase(),
    precision: state.location.precision,
  };
  if (state.location.city.trim()) location.city = state.location.city.trim();
  if (state.location.county.trim()) location.county = state.location.county.trim();
  if (state.location.multiSite.enabled) {
    location.multiSite = {
      states: state.location.multiSite.states
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      ...(state.location.multiSite.siteCountNote.trim()
        ? { siteCountNote: state.location.multiSite.siteCountNote.trim() }
        : {}),
    };
  }

  const capacityMw: Record<string, unknown> = {};
  const planned = num(state.capacityMw.planned);
  const operational = num(state.capacityMw.operational);
  if (planned !== undefined) capacityMw.planned = planned;
  if (operational !== undefined) capacityMw.operational = operational;

  const payload: Record<string, unknown> = {
    id: state.id,
    name: state.name,
    operator: state.operator,
    status: state.status,
    confidence: state.confidence,
    facilityType: state.facilityType,
    location,
    capacityMw,
    statusHistory: state.statusHistory,
    sources: state.sources,
    energy: state.energy,
    water: state.water,
    subsidies: state.subsidies,
    jobs: state.jobs,
    community: state.community,
    lastUpdated: state.lastUpdated,
  };
  if (state.poweredBy.trim()) payload.poweredBy = state.poweredBy.trim();
  if (state.announcedDate.trim()) payload.announcedDate = state.announcedDate.trim();
  if (state.notes.trim()) payload.notes = state.notes.trim();
  const investmentUsd = num(state.investmentUsd);
  if (investmentUsd !== undefined) payload.investmentUsd = investmentUsd;
  const landAcres = num(state.landAcres);
  if (landAcres !== undefined) payload.landAcres = landAcres;

  if (state.facilityType === "data_center") {
    if (state.aiClassification) payload.aiClassification = state.aiClassification;
    payload.environmental = state.dataCenterEnvironmental;
  } else if (state.facilityType === "crypto_mining") {
    if (state.aiClassification) payload.aiClassification = state.aiClassification;
    payload.mining = state.mining;
    payload.environmental = state.cryptoMiningEnvironmental;
  } else {
    payload.generation = state.generation;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Field-level error surfacing (from a Zod `issues` array on a 400 response)
// ---------------------------------------------------------------------------

type FieldIssues = Record<string, string>;

function issuesToFieldMap(issues: unknown): FieldIssues {
  const map: FieldIssues = {};
  if (!Array.isArray(issues)) return map;
  for (const issue of issues) {
    if (
      issue &&
      typeof issue === "object" &&
      "path" in issue &&
      "message" in issue &&
      Array.isArray((issue as { path: unknown }).path)
    ) {
      const path = (issue as { path: (string | number)[] }).path.join(".");
      map[path] = String((issue as { message: unknown }).message);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Reusable small field wrappers
// ---------------------------------------------------------------------------

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  required,
  type = "text",
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? <div id={`${id}-error`}><FieldError message={error} /></div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: scalars (name/operator/status/confidence/facilityType)
// ---------------------------------------------------------------------------

function CoreFieldsSection({
  state,
  setState,
  isEdit,
  errors,
}: {
  state: FacilityFormState;
  setState: Dispatch<SetStateAction<FacilityFormState>>;
  isEdit: boolean;
  errors: FieldIssues;
}) {
  function handleFacilityTypeChange(next: FacilityType) {
    setState((prev) => {
      if (prev.facilityType === next) return prev;
      // Switching type on CREATE resets the type-conditional slices so no
      // stale field from a prior selection leaks into the new type's
      // payload. On EDIT we still reset the INACTIVE slices (they were
      // already inert for the previous type) but never touch the fields
      // this sub-unit renders — the type switch alone must not blank
      // already-populated scalar/location/capacityMw data.
      return { ...prev, facilityType: next, ...emptyTypeConditionalState() };
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Core details</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!isEdit ? (
          <TextField
            id="id"
            label="Facility ID (kebab-slug, immutable)"
            value={state.id}
            onChange={(v) => setState((prev) => ({ ...prev, id: v }))}
            error={errors["id"]}
            required
          />
        ) : null}

        <TextField
          id="name"
          label="Name"
          value={state.name}
          onChange={(v) => setState((prev) => ({ ...prev, name: v }))}
          error={errors["name"]}
          required
        />
        <TextField
          id="operator"
          label="Operator"
          value={state.operator}
          onChange={(v) => setState((prev) => ({ ...prev, operator: v }))}
          error={errors["operator"]}
          required
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="facilityType">Facility type</Label>
            <Select
              value={state.facilityType}
              onValueChange={(v) => handleFacilityTypeChange(v as FacilityType)}
            >
              <SelectTrigger id="facilityType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FACILITY_TYPE_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {FACILITY_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="status">Status</Label>
            <Select
              value={state.status}
              onValueChange={(v) => setState((prev) => ({ ...prev, status: v as Status }))}
            >
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confidence">Confidence</Label>
            <Select
              value={state.confidence}
              onValueChange={(v) =>
                setState((prev) => ({ ...prev, confidence: v as Facility["confidence"] }))
              }
            >
              <SelectTrigger id="confidence" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {confidenceEnum.options.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <TextField
          id="poweredBy"
          label="Powered by (optional)"
          value={state.poweredBy}
          onChange={(v) => setState((prev) => ({ ...prev, poweredBy: v }))}
          error={errors["poweredBy"]}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="announcedDate"
            label="Announced date (optional)"
            value={state.announcedDate}
            onChange={(v) => setState((prev) => ({ ...prev, announcedDate: v }))}
            error={errors["announcedDate"]}
          />
          <TextField
            id="lastUpdated"
            label="Last updated"
            value={state.lastUpdated}
            onChange={(v) => setState((prev) => ({ ...prev, lastUpdated: v }))}
            error={errors["lastUpdated"]}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notes">Notes (optional)</Label>
          <textarea
            id="notes"
            name="notes"
            value={state.notes}
            onChange={(e) => setState((prev) => ({ ...prev, notes: e.target.value }))}
            rows={3}
            className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-invalid={errors["notes"] ? true : undefined}
            aria-describedby={errors["notes"] ? "notes-error" : undefined}
          />
          {errors["notes"] ? <div id="notes-error"><FieldError message={errors["notes"]} /></div> : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="investmentUsd"
            label="Investment (USD, optional)"
            type="number"
            value={state.investmentUsd}
            onChange={(v) => setState((prev) => ({ ...prev, investmentUsd: v }))}
            error={errors["investmentUsd"]}
          />
          <TextField
            id="landAcres"
            label="Land (acres, optional)"
            type="number"
            value={state.landAcres}
            onChange={(v) => setState((prev) => ({ ...prev, landAcres: v }))}
            error={errors["landAcres"]}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: location (grouped fieldset — always submitted whole)
// ---------------------------------------------------------------------------

function LocationSection({
  state,
  setState,
  errors,
}: {
  state: FacilityFormState;
  setState: Dispatch<SetStateAction<FacilityFormState>>;
  errors: FieldIssues;
}) {
  const location = state.location;

  function updateLocation(patch: Partial<FacilityFormState["location"]>) {
    setState((prev) => ({ ...prev, location: { ...prev.location, ...patch } }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Location</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="location.lat"
            label="Latitude"
            type="number"
            value={location.lat}
            onChange={(v) => updateLocation({ lat: v })}
            error={errors["location.lat"]}
            required
          />
          <TextField
            id="location.lon"
            label="Longitude"
            type="number"
            value={location.lon}
            onChange={(v) => updateLocation({ lon: v })}
            error={errors["location.lon"]}
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            id="location.city"
            label="City (optional)"
            value={location.city}
            onChange={(v) => updateLocation({ city: v })}
            error={errors["location.city"]}
          />
          <TextField
            id="location.county"
            label="County (optional)"
            value={location.county}
            onChange={(v) => updateLocation({ county: v })}
            error={errors["location.county"]}
          />
          <TextField
            id="location.state"
            label="State (2-letter)"
            value={location.state}
            onChange={(v) => updateLocation({ state: v.toUpperCase().slice(0, 2) })}
            error={errors["location.state"]}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="location.precision">Precision</Label>
          <Select
            value={location.precision}
            onValueChange={(v) =>
              updateLocation({ precision: v as FacilityFormState["location"]["precision"] })
            }
          >
            <SelectTrigger id="location.precision" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exact">Exact</SelectItem>
              <SelectItem value="approximate">Approximate</SelectItem>
              <SelectItem value="representative_multi_site">
                Representative (multi-site)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <label
            htmlFor="location.multiSite.enabled"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <input
              id="location.multiSite.enabled"
              type="checkbox"
              checked={location.multiSite.enabled}
              onChange={(e) =>
                updateLocation({
                  multiSite: { ...location.multiSite, enabled: e.target.checked },
                })
              }
            />
            This facility spans multiple sites
          </label>
          {location.multiSite.enabled ? (
            <div className="flex flex-col gap-3">
              <TextField
                id="location.multiSite.states"
                label="States (comma-separated 2-letter codes)"
                value={location.multiSite.states}
                onChange={(v) =>
                  updateLocation({ multiSite: { ...location.multiSite, states: v } })
                }
                error={errors["location.multiSite.states"]}
                required
              />
              <TextField
                id="location.multiSite.siteCountNote"
                label="Site count note (optional)"
                value={location.multiSite.siteCountNote}
                onChange={(v) =>
                  updateLocation({ multiSite: { ...location.multiSite, siteCountNote: v } })
                }
                error={errors["location.multiSite.siteCountNote"]}
              />
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: capacityMw
// ---------------------------------------------------------------------------

function CapacitySection({
  state,
  setState,
  errors,
}: {
  state: FacilityFormState;
  setState: Dispatch<SetStateAction<FacilityFormState>>;
  errors: FieldIssues;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capacity</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="capacityMw.planned"
          label="Planned (MW, optional)"
          type="number"
          value={state.capacityMw.planned}
          onChange={(v) =>
            setState((prev) => ({ ...prev, capacityMw: { ...prev.capacityMw, planned: v } }))
          }
          error={errors["capacityMw.planned"]}
        />
        <TextField
          id="capacityMw.operational"
          label="Operational (MW, optional)"
          type="number"
          value={state.capacityMw.operational}
          onChange={(v) =>
            setState((prev) => ({
              ...prev,
              capacityMw: { ...prev.capacityMw, operational: v },
            }))
          }
          error={errors["capacityMw.operational"]}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Extension-point placeholders (real components wired in by later sub-units:
// 2b-2 sources, 2b-3 statusHistory/subsidies, 2b-4 energy/water/jobs/
// community/type-conditional). Rendering nothing keeps the live UI free of
// "coming soon" placeholders between sub-unit commits, while giving each
// later sub-unit an obvious, named spot to plug a real `<FacilityXSection
// state={state} setState={setState} />` component into.
// ---------------------------------------------------------------------------

type FacilitySectionProps = {
  state: FacilityFormState;
  setState: Dispatch<SetStateAction<FacilityFormState>>;
};

function FacilitySourcesSection(props: FacilitySectionProps) {
  void props;
  return null; // wired in by 2b-2
}

function FacilityStatusHistorySection(props: FacilitySectionProps) {
  void props;
  return null; // wired in by 2b-3
}

function FacilitySubsidiesSection(props: FacilitySectionProps) {
  void props;
  return null; // wired in by 2b-3
}

function FacilityEnergyWaterSection(props: FacilitySectionProps) {
  void props;
  return null; // wired in by 2b-4
}

function FacilityJobsCommunitySection(props: FacilitySectionProps) {
  void props;
  return null; // wired in by 2b-4
}

function FacilityTypeConditionalFields(props: FacilitySectionProps) {
  void props;
  return null; // wired in by 2b-4
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FacilityFormProps {
  initialState: FacilityFormState;
  mode: "create" | "edit";
}

export function FacilityForm({ initialState, mode }: FacilityFormProps) {
  const router = useRouter();
  const [state, setState] = useState<FacilityFormState>(initialState);
  const [errors, setErrors] = useState<FieldIssues>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    setErrors({});

    const payload = buildFacilityPayload(state);

    startTransition(async () => {
      const result =
        mode === "create"
          ? await createFacilityAction(payload)
          : await updateFacilityAction(state.id, payload);

      if (result.ok) {
        toast.success(`${mode === "create" ? "Created" : "Updated"} "${result.facility.name}".`);
        router.push("/admin/facilities");
        return;
      }

      setErrors(issuesToFieldMap(result.issues));
      setFormError(result.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <CoreFieldsSection
        state={state}
        setState={setState}
        isEdit={mode === "edit"}
        errors={errors}
      />
      <LocationSection state={state} setState={setState} errors={errors} />
      <CapacitySection state={state} setState={setState} errors={errors} />

      <FacilitySourcesSection state={state} setState={setState} />
      <FacilityStatusHistorySection state={state} setState={setState} />
      <FacilitySubsidiesSection state={state} setState={setState} />
      <FacilityEnergyWaterSection state={state} setState={setState} />
      <FacilityJobsCommunitySection state={state} setState={setState} />
      <FacilityTypeConditionalFields state={state} setState={setState} />

      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/admin/facilities")}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : mode === "create" ? "Create facility" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
