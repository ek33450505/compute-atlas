"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Facility } from "@/lib/schema";

// ---------------------------------------------------------------------------
// energy{} / water{} fieldsets (Phase 2b-4).
//
// Both are plain OPTIONAL nested objects with no arrays — a simple grouped
// set of inputs each, no add/remove/reorder machinery like the array
// sections. Per the shallow-merge rule shared across this whole phase,
// whichever of these two objects is present in the submitted payload must
// always be the FULL object (never a partial patch) — `facility-form.tsx`'s
// `buildFacilityPayload` already submits `state.energy`/`state.water` whole,
// this component only needs to keep every field of each object in sync via
// one `onChange` callback per object.
// ---------------------------------------------------------------------------

type EnergyState = NonNullable<Facility["energy"]> | Record<string, never>;
type WaterState = NonNullable<Facility["water"]> | Record<string, never>;

const ENERGY_SOURCE_LABELS: Record<
  NonNullable<NonNullable<Facility["energy"]>["source"]>,
  string
> = {
  grid: "Grid",
  on_site_gas: "On-site gas",
  nuclear: "Nuclear",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  mixed: "Mixed",
  other: "Other",
};

const COOLING_TYPE_LABELS: Record<
  NonNullable<NonNullable<Facility["water"]>["coolingType"]>,
  string
> = {
  evaporative: "Evaporative",
  air: "Air",
  closed_loop: "Closed loop",
  hybrid: "Hybrid",
  unknown: "Unknown",
};

export interface FacilityEnergyWaterSectionProps {
  energy: EnergyState;
  water: WaterState;
  onChangeEnergy: (next: EnergyState) => void;
  onChangeWater: (next: WaterState) => void;
}

export function FacilityEnergyWaterSection({
  energy,
  water,
  onChangeEnergy,
  onChangeWater,
}: FacilityEnergyWaterSectionProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Energy</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="energy.source">Source (optional)</Label>
              <Select
                value={energy.source ?? ""}
                onValueChange={(v) =>
                  onChangeEnergy({
                    ...energy,
                    source: v as NonNullable<Facility["energy"]>["source"],
                  })
                }
              >
                <SelectTrigger id="energy.source" className="w-full">
                  <SelectValue placeholder="Select a source" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(ENERGY_SOURCE_LABELS) as [
                      keyof typeof ENERGY_SOURCE_LABELS,
                      string,
                    ][]
                  ).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="energy.utility">Utility (optional)</Label>
              <Input
                id="energy.utility"
                name="energy.utility"
                value={energy.utility ?? ""}
                onChange={(e) => onChangeEnergy({ ...energy, utility: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="energy.onSiteGenerationMw">
              On-site generation (MW, optional)
            </Label>
            <Input
              id="energy.onSiteGenerationMw"
              name="energy.onSiteGenerationMw"
              type="number"
              value={
                energy.onSiteGenerationMw != null ? String(energy.onSiteGenerationMw) : ""
              }
              onChange={(e) => {
                const v = e.target.value;
                onChangeEnergy({
                  ...energy,
                  onSiteGenerationMw: v.trim() === "" ? undefined : Number(v),
                });
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="energy.notes">Notes (optional)</Label>
            <Input
              id="energy.notes"
              name="energy.notes"
              value={energy.notes ?? ""}
              onChange={(e) => onChangeEnergy({ ...energy, notes: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Water</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="water.coolingType">Cooling type (optional)</Label>
              <Select
                value={water.coolingType ?? ""}
                onValueChange={(v) =>
                  onChangeWater({
                    ...water,
                    coolingType: v as NonNullable<Facility["water"]>["coolingType"],
                  })
                }
              >
                <SelectTrigger id="water.coolingType" className="w-full">
                  <SelectValue placeholder="Select a cooling type" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(COOLING_TYPE_LABELS) as [
                      keyof typeof COOLING_TYPE_LABELS,
                      string,
                    ][]
                  ).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="water.reportedMgd">Reported (MGD, optional)</Label>
              <Input
                id="water.reportedMgd"
                name="water.reportedMgd"
                type="number"
                value={water.reportedMgd != null ? String(water.reportedMgd) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChangeWater({
                    ...water,
                    reportedMgd: v.trim() === "" ? undefined : Number(v),
                  });
                }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="water.notes">Notes (optional)</Label>
            <Input
              id="water.notes"
              name="water.notes"
              value={water.notes ?? ""}
              onChange={(e) => onChangeWater({ ...water, notes: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
