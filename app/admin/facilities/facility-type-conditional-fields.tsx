"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { aiClassificationEnum } from "@/lib/schema";
import type { FacilityType } from "@/lib/facility-type";

// ---------------------------------------------------------------------------
// facilityType-conditional fieldsets (Phase 2b-4) — the 3 branches of
// `facilitySchema`'s discriminated union, switched on the form's CURRENT
// `facilityType`. Only the active branch is rendered; the other two
// branches' state slices are untouched here (facility-form.tsx's
// `handleFacilityTypeChange` is responsible for resetting the INACTIVE
// slices on a type switch — this component just renders whichever slice is
// currently relevant).
//
// IMPORTANT — data_center vs crypto_mining `environmental` shapes are
// COMPLETELY DIFFERENT and must NEVER be conflated into one shared
// sub-component, despite sharing the key name "environmental":
//   - data_center.environmental:   { pue?, pueConfidence?, wue?,
//                                    gridCarbonIntensityGCo2PerKwh?,
//                                    renewablePercent?, waterStress }
//   - crypto_mining.environmental: { carbonIntensityProxy?,
//                                    carbonIntensityBasis? }
// These are rendered by two entirely separate functions below
// (`DataCenterEnvironmentalFields` / `CryptoMiningEnvironmentalFields`) that
// happen to write into differently-named state slices
// (`dataCenterEnvironmental` / `cryptoMiningEnvironmental`) on the parent
// form, precisely so they can never be accidentally merged.
// ---------------------------------------------------------------------------

/** A minimal, id+name-only projection of an existing facility, used only to
 *  populate the power_generation `poweredFacilityIds` combobox. Deliberately
 *  NOT the full `Facility` type — this component only ever needs id/name. */
export interface FacilityOption {
  id: string;
  name: string;
}

export interface FacilityTypeConditionalFieldsProps {
  facilityType: FacilityType;
  aiClassification: string;
  onChangeAiClassification: (next: string) => void;
  dataCenterEnvironmental: Record<string, unknown>;
  onChangeDataCenterEnvironmental: (next: Record<string, unknown>) => void;
  mining: Record<string, unknown>;
  onChangeMining: (next: Record<string, unknown>) => void;
  cryptoMiningEnvironmental: Record<string, unknown>;
  onChangeCryptoMiningEnvironmental: (next: Record<string, unknown>) => void;
  generation: Record<string, unknown>;
  onChangeGeneration: (next: Record<string, unknown>) => void;
  /** Existing facilities available to reference via `poweredFacilityIds`.
   *  Excludes the facility currently being edited (a facility cannot power
   *  itself) — filtering is the caller's responsibility since only the
   *  caller knows the current facility's id in edit mode. */
  availableFacilities: FacilityOption[];
  /** The current facility's own id, in edit mode — used only to exclude
   *  self-reference from `availableFacilities`. Undefined on create (no id
   *  assigned yet, so no self-reference is possible). */
  currentFacilityId?: string;
}

export function FacilityTypeConditionalFields({
  facilityType,
  aiClassification,
  onChangeAiClassification,
  dataCenterEnvironmental,
  onChangeDataCenterEnvironmental,
  mining,
  onChangeMining,
  cryptoMiningEnvironmental,
  onChangeCryptoMiningEnvironmental,
  generation,
  onChangeGeneration,
  availableFacilities,
  currentFacilityId,
}: FacilityTypeConditionalFieldsProps) {
  if (facilityType === "data_center") {
    return (
      <DataCenterFields
        aiClassification={aiClassification}
        onChangeAiClassification={onChangeAiClassification}
        environmental={dataCenterEnvironmental}
        onChangeEnvironmental={onChangeDataCenterEnvironmental}
      />
    );
  }

  if (facilityType === "crypto_mining") {
    return (
      <CryptoMiningFields
        aiClassification={aiClassification}
        onChangeAiClassification={onChangeAiClassification}
        mining={mining}
        onChangeMining={onChangeMining}
        environmental={cryptoMiningEnvironmental}
        onChangeEnvironmental={onChangeCryptoMiningEnvironmental}
      />
    );
  }

  return (
    <PowerGenerationFields
      generation={generation}
      onChangeGeneration={onChangeGeneration}
      availableFacilities={availableFacilities}
      currentFacilityId={currentFacilityId}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared: aiClassification select (data_center + crypto_mining only)
// ---------------------------------------------------------------------------

const AI_CLASSIFICATION_LABELS: Record<
  (typeof aiClassificationEnum.options)[number],
  string
> = {
  confirmed: "Confirmed",
  likely: "Likely",
  mixed_use: "Mixed use",
};

function AiClassificationField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:max-w-xs">
      <Label htmlFor="aiClassification">AI classification (optional)</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger id="aiClassification" className="w-full">
          <SelectValue placeholder="Select a classification" />
        </SelectTrigger>
        <SelectContent>
          {aiClassificationEnum.options.map((option) => (
            <SelectItem key={option} value={option}>
              {AI_CLASSIFICATION_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numeric field helper — shared across all three branches below.
// ---------------------------------------------------------------------------

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (next: number | undefined) => void;
}) {
  const stringValue = value != null ? String(value) : "";
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type="number"
        value={stringValue}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v.trim() === "" ? undefined : Number(v));
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch (a): data_center — aiClassification + environmental{pue/wue/...}
// ---------------------------------------------------------------------------

const PUE_CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  reported: "Reported",
  rumored: "Rumored",
};

const WATER_STRESS_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extreme: "Extreme",
  unknown: "Unknown",
};

function DataCenterFields({
  aiClassification,
  onChangeAiClassification,
  environmental,
  onChangeEnvironmental,
}: {
  aiClassification: string;
  onChangeAiClassification: (next: string) => void;
  environmental: Record<string, unknown>;
  onChangeEnvironmental: (next: Record<string, unknown>) => void;
}) {
  const renewablePercent =
    typeof environmental.renewablePercent === "number" ? environmental.renewablePercent : 0;
  const waterStress =
    typeof environmental.waterStress === "string" ? environmental.waterStress : "unknown";

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Data center classification</CardTitle>
        </CardHeader>
        <CardContent>
          <AiClassificationField
            value={aiClassification}
            onChange={onChangeAiClassification}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environmental (data center)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              id="environmental.pue"
              label="PUE (optional)"
              value={environmental.pue}
              onChange={(v) => onChangeEnvironmental({ ...environmental, pue: v })}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="environmental.pueConfidence">PUE confidence (optional)</Label>
              <Select
                value={typeof environmental.pueConfidence === "string" ? environmental.pueConfidence : ""}
                onValueChange={(v) =>
                  onChangeEnvironmental({ ...environmental, pueConfidence: v })
                }
              >
                <SelectTrigger id="environmental.pueConfidence" className="w-full">
                  <SelectValue placeholder="Select a confidence level" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PUE_CONFIDENCE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              id="environmental.wue"
              label="WUE (optional)"
              value={environmental.wue}
              onChange={(v) => onChangeEnvironmental({ ...environmental, wue: v })}
            />
            <NumberField
              id="environmental.gridCarbonIntensityGCo2PerKwh"
              label="Grid carbon intensity (gCO2/kWh, optional)"
              value={environmental.gridCarbonIntensityGCo2PerKwh}
              onChange={(v) =>
                onChangeEnvironmental({
                  ...environmental,
                  gridCarbonIntensityGCo2PerKwh: v,
                })
              }
            />
          </div>

          <div className="flex flex-col gap-2 sm:max-w-md">
            <Label htmlFor="environmental.renewablePercent">
              Renewable percent (optional): {renewablePercent}%
            </Label>
            <Slider
              id="environmental.renewablePercent"
              min={0}
              max={100}
              step={1}
              value={[renewablePercent]}
              onValueChange={(v) => {
                const next = Array.isArray(v) ? v[0] : v;
                onChangeEnvironmental({ ...environmental, renewablePercent: next });
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="environmental.waterStress">Water stress</Label>
            <Select
              value={waterStress}
              onValueChange={(v) => onChangeEnvironmental({ ...environmental, waterStress: v })}
            >
              <SelectTrigger id="environmental.waterStress" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(WATER_STRESS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Branch (b): crypto_mining — aiClassification + mining{} +
// environmental{carbonIntensityProxy/carbonIntensityBasis} (a DIFFERENT
// shape from data_center's environmental — see the file-level note above).
// ---------------------------------------------------------------------------

const HARDWARE_TYPE_LABELS: Record<string, string> = {
  asic: "ASIC",
  gpu: "GPU",
  mixed: "Mixed",
  unknown: "Unknown",
};

const MINING_COOLING_TYPE_LABELS: Record<string, string> = {
  immersion: "Immersion",
  air: "Air",
  hydro: "Hydro",
  hybrid: "Hybrid",
  unknown: "Unknown",
};

const POWER_ARRANGEMENT_LABELS: Record<string, string> = {
  grid: "Grid",
  stranded_gas: "Stranded gas",
  flared_gas: "Flared gas",
  curtailed_renewable: "Curtailed renewable",
  behind_meter: "Behind meter",
  mixed: "Mixed",
  unknown: "Unknown",
};

const CARBON_INTENSITY_BASIS_LABELS: Record<string, string> = {
  self_reported: "Self-reported",
  grid_average: "Grid average",
  estimated: "Estimated",
  unknown: "Unknown",
};

function CryptoMiningFields({
  aiClassification,
  onChangeAiClassification,
  mining,
  onChangeMining,
  environmental,
  onChangeEnvironmental,
}: {
  aiClassification: string;
  onChangeAiClassification: (next: string) => void;
  mining: Record<string, unknown>;
  onChangeMining: (next: Record<string, unknown>) => void;
  environmental: Record<string, unknown>;
  onChangeEnvironmental: (next: Record<string, unknown>) => void;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Crypto mining classification</CardTitle>
        </CardHeader>
        <CardContent>
          <AiClassificationField
            value={aiClassification}
            onChange={onChangeAiClassification}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mining</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              id="mining.hashRateThPerS"
              label="Hash rate (TH/s, optional)"
              value={mining.hashRateThPerS}
              onChange={(v) => onChangeMining({ ...mining, hashRateThPerS: v })}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mining.hardwareType">Hardware type (optional)</Label>
              <Select
                value={typeof mining.hardwareType === "string" ? mining.hardwareType : ""}
                onValueChange={(v) => onChangeMining({ ...mining, hardwareType: v })}
              >
                <SelectTrigger id="mining.hardwareType" className="w-full">
                  <SelectValue placeholder="Select a hardware type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(HARDWARE_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mining.coolingType">Cooling type (optional)</Label>
              <Select
                value={typeof mining.coolingType === "string" ? mining.coolingType : ""}
                onValueChange={(v) => onChangeMining({ ...mining, coolingType: v })}
              >
                <SelectTrigger id="mining.coolingType" className="w-full">
                  <SelectValue placeholder="Select a cooling type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MINING_COOLING_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mining.powerArrangement">Power arrangement (optional)</Label>
              <Select
                value={
                  typeof mining.powerArrangement === "string" ? mining.powerArrangement : ""
                }
                onValueChange={(v) => onChangeMining({ ...mining, powerArrangement: v })}
              >
                <SelectTrigger id="mining.powerArrangement" className="w-full">
                  <SelectValue placeholder="Select a power arrangement" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(POWER_ARRANGEMENT_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environmental (crypto mining)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              id="environmental.carbonIntensityProxy"
              label="Carbon intensity proxy (optional)"
              value={environmental.carbonIntensityProxy}
              onChange={(v) =>
                onChangeEnvironmental({ ...environmental, carbonIntensityProxy: v })
              }
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="environmental.carbonIntensityBasis">
                Carbon intensity basis (optional)
              </Label>
              <Select
                value={
                  typeof environmental.carbonIntensityBasis === "string"
                    ? environmental.carbonIntensityBasis
                    : ""
                }
                onValueChange={(v) =>
                  onChangeEnvironmental({ ...environmental, carbonIntensityBasis: v })
                }
              >
                <SelectTrigger id="environmental.carbonIntensityBasis" className="w-full">
                  <SelectValue placeholder="Select a basis" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CARBON_INTENSITY_BASIS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Branch (c): power_generation — generation{technology/offtaker/
// poweredFacilityIds/unitCount/notes}
// ---------------------------------------------------------------------------

const TECHNOLOGY_LABELS: Record<string, string> = {
  nuclear_smr: "Nuclear (SMR)",
  nuclear: "Nuclear",
  natural_gas: "Natural gas",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  geothermal: "Geothermal",
  battery: "Battery",
  other: "Other",
};

function PowerGenerationFields({
  generation,
  onChangeGeneration,
  availableFacilities,
  currentFacilityId,
}: {
  generation: Record<string, unknown>;
  onChangeGeneration: (next: Record<string, unknown>) => void;
  availableFacilities: FacilityOption[];
  currentFacilityId?: string;
}) {
  const poweredFacilityIds: string[] = Array.isArray(generation.poweredFacilityIds)
    ? (generation.poweredFacilityIds as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  function updatePoweredFacilityIds(next: string[]) {
    onChangeGeneration({ ...generation, poweredFacilityIds: next });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="generation.technology">Technology (optional)</Label>
            <Select
              value={typeof generation.technology === "string" ? generation.technology : ""}
              onValueChange={(v) => onChangeGeneration({ ...generation, technology: v })}
            >
              <SelectTrigger id="generation.technology" className="w-full">
                <SelectValue placeholder="Select a technology" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TECHNOLOGY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="generation.offtaker">Offtaker (optional)</Label>
            <Input
              id="generation.offtaker"
              name="generation.offtaker"
              value={typeof generation.offtaker === "string" ? generation.offtaker : ""}
              onChange={(e) => onChangeGeneration({ ...generation, offtaker: e.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="generation.unitCount">Unit count (optional)</Label>
          <Input
            id="generation.unitCount"
            name="generation.unitCount"
            type="number"
            min={1}
            step={1}
            value={generation.unitCount != null ? String(generation.unitCount) : ""}
            onChange={(e) => {
              const v = e.target.value;
              onChangeGeneration({
                ...generation,
                unitCount: v.trim() === "" ? undefined : Math.trunc(Number(v)),
              });
            }}
          />
        </div>

        <PoweredFacilitiesPicker
          selectedIds={poweredFacilityIds}
          onChange={updatePoweredFacilityIds}
          availableFacilities={availableFacilities}
          currentFacilityId={currentFacilityId}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="generation.notes">Notes (optional)</Label>
          <Input
            id="generation.notes"
            name="generation.notes"
            value={typeof generation.notes === "string" ? generation.notes : ""}
            onChange={(e) => onChangeGeneration({ ...generation, notes: e.target.value })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// poweredFacilityIds — searchable multi-select with removable chips.
//
// The repo's existing search machinery (`lib/search.ts` + the ⌘K command
// palette, `components/search/command-palette.tsx`) is a Fuse-based ranker
// tuned for a `cmdk`-style single-select "jump to a page" flow, built against
// an async-loaded, all-entity-type search index (pages/facilities/operators/
// states) — a materially different shape than what's needed here: a
// same-page multi-select tag list scoped to ONLY existing facilities, from a
// small id/name list already available as a prop. Per the plan's explicit
// fallback, this uses a simpler combobox instead: a Popover-housed text
// filter over `availableFacilities` (plain substring match — Fuse's fuzzy
// ranking is unnecessary overhead for a same-page list already capped to a
// few hundred rows), with selections rendered as removable `Badge` chips.
// ---------------------------------------------------------------------------

function PoweredFacilitiesPicker({
  selectedIds,
  onChange,
  availableFacilities,
  currentFacilityId,
}: {
  selectedIds: string[];
  onChange: (next: string[]) => void;
  availableFacilities: FacilityOption[];
  currentFacilityId?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const selectableFacilities = useMemo(
    () => availableFacilities.filter((f) => f.id !== currentFacilityId),
    [availableFacilities, currentFacilityId]
  );

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const candidates = selectableFacilities.filter((f) => !selectedSet.has(f.id));
    if (!trimmed) return candidates.slice(0, 20);
    return candidates
      .filter((f) => f.name.toLowerCase().includes(trimmed) || f.id.includes(trimmed))
      .slice(0, 20);
  }, [query, selectableFacilities, selectedSet]);

  const selectedFacilities = selectedIds
    .map((id) => selectableFacilities.find((f) => f.id === id))
    .filter((f): f is FacilityOption => f != null);

  function addFacility(id: string) {
    if (!selectedSet.has(id)) onChange([...selectedIds, id]);
    setQuery("");
  }

  function removeFacility(id: string) {
    onChange(selectedIds.filter((existing) => existing !== id));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="generation.poweredFacilityIds">Powered facilities (optional)</Label>

      {selectedFacilities.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Selected powered facilities">
          {selectedFacilities.map((f) => (
            <li key={f.id}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {f.name}
                <button
                  type="button"
                  onClick={() => removeFacility(f.id)}
                  className="ml-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label={`Remove ${f.name} from powered facilities`}
                >
                  ×
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              id="generation.poweredFacilityIds"
              aria-haspopup="listbox"
            />
          }
        >
          Add a powered facility…
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search facilities by name…"
            aria-label="Search facilities to add as powered facilities"
            autoFocus
          />
          <ul role="listbox" aria-label="Facility search results" className="mt-2 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">No matches.</li>
            ) : (
              filtered.map((f) => (
                // `role="option"` lives on the BUTTON itself (the actual
                // interactive/clickable element), not the wrapping `<li>` —
                // a listbox's options should be the focus/activation
                // targets a screen reader lands on, not a non-interactive
                // ancestor of one.
                <li key={f.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => addFacility(f.id)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                  >
                    {f.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
