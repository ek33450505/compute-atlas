"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Source, Facility } from "@/lib/schema";
import { FacilitySourceIndexPicker } from "@/app/admin/facilities/facility-source-index-picker";
import { useFocusAfterRemove } from "@/lib/use-focus-after-remove";

// ---------------------------------------------------------------------------
// subsidies[] array editor (Phase 2b-3).
//
// `facilitySchema.subsidies` is fully optional (`z.array(...).optional()`,
// no default in the schema) — the form state always carries a real array
// (see facility-form.tsx's `subsidies: []` default / `?? []` on load), and
// an empty array is a valid, complete submission.
//
// `amountUsd` is a nonneg NUMBER input — parsed via the same
// empty-string-means-absent convention `buildFacilityPayload` already uses
// elsewhere in facility-form.tsx (empty string persists as `undefined` here
// in form state too, so the payload builder's existing `num()` helper can
// treat a per-row numeric string field the same way it treats top-level
// ones).
//
// Same plain index-based array-state pattern as 2b-2/2b-3's other editors.
// ---------------------------------------------------------------------------

export type SubsidyEntry = NonNullable<Facility["subsidies"]>[number];

/** A fresh, empty subsidies row — every field is optional per the schema. */
function emptySubsidyEntry(): SubsidyEntry {
  return {};
}

export interface FacilitySubsidiesSectionProps {
  subsidies: SubsidyEntry[];
  sources: Source[];
  onChange: (next: SubsidyEntry[]) => void;
}

export function FacilitySubsidiesSection({
  subsidies,
  sources,
  onChange,
}: FacilitySubsidiesSectionProps) {
  const { registerRemoveButton, registerAddButton, focusAfterRemove } = useFocusAfterRemove();

  function updateRow(index: number, patch: Partial<SubsidyEntry>) {
    onChange(subsidies.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    onChange([...subsidies, emptySubsidyEntry()]);
  }

  function removeRow(index: number) {
    const next = subsidies.filter((_, i) => i !== index);
    onChange(next);
    focusAfterRemove(index, next.length);
  }

  function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= subsidies.length) return;
    const next = [...subsidies];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subsidies</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {subsidies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subsidies recorded yet.</p>
        ) : null}

        {subsidies.map((entry, index) => (
          // Index-as-key: same rationale as the other 2b-2/2b-3 array
          // editors — no intrinsic id, short-lived form rows, fully
          // controlled from subsidies[index].
          <SubsidyRow
            key={index}
            index={index}
            entry={entry}
            sources={sources}
            isFirst={index === 0}
            isLast={index === subsidies.length - 1}
            onChangeRow={(patch) => updateRow(index, patch)}
            onRemove={() => removeRow(index)}
            onMoveUp={() => moveRow(index, -1)}
            onMoveDown={() => moveRow(index, 1)}
            removeButtonRef={registerRemoveButton(index)}
          />
        ))}

        <div>
          <Button type="button" variant="outline" onClick={addRow} ref={registerAddButton}>
            Add subsidy
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Single subsidy row
// ---------------------------------------------------------------------------

function SubsidyRow({
  index,
  entry,
  sources,
  isFirst,
  isLast,
  onChangeRow,
  onRemove,
  onMoveUp,
  onMoveDown,
  removeButtonRef,
}: {
  index: number;
  entry: SubsidyEntry;
  sources: Source[];
  isFirst: boolean;
  isLast: boolean;
  onChangeRow: (patch: Partial<SubsidyEntry>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  removeButtonRef: (el: HTMLButtonElement | null) => void;
}) {
  const programId = `subsidies.${index}.program`;
  const amountUsdId = `subsidies.${index}.amountUsd`;
  const jurisdictionId = `subsidies.${index}.jurisdiction`;
  const yearId = `subsidies.${index}.year`;
  const sourceIndexId = `subsidies.${index}.sourceIndex`;

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">Subsidy {index + 1}</legend>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={programId}>Program (optional)</Label>
        <Input
          id={programId}
          name={programId}
          value={entry.program ?? ""}
          onChange={(e) => onChangeRow({ program: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={amountUsdId}>Amount (USD, optional)</Label>
          <Input
            id={amountUsdId}
            name={amountUsdId}
            type="number"
            min={0}
            value={entry.amountUsd != null ? String(entry.amountUsd) : ""}
            onChange={(e) => {
              const raw = e.target.value;
              onChangeRow({ amountUsd: raw.trim() === "" ? undefined : Number(raw) });
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={jurisdictionId}>Jurisdiction (optional)</Label>
          <Input
            id={jurisdictionId}
            name={jurisdictionId}
            value={entry.jurisdiction ?? ""}
            onChange={(e) => onChangeRow({ jurisdiction: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={yearId}>Year (optional)</Label>
          <Input
            id={yearId}
            name={yearId}
            value={entry.year ?? ""}
            onChange={(e) => onChangeRow({ year: e.target.value })}
          />
        </div>
      </div>

      <div className="sm:max-w-xs">
        <FacilitySourceIndexPicker
          id={sourceIndexId}
          label="Source (optional)"
          sources={sources}
          value={entry.sourceIndex}
          onChange={(index) => onChangeRow({ sourceIndex: index })}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onMoveUp}
          disabled={isFirst}
          aria-label={`Move subsidy ${index + 1} up`}
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onMoveDown}
          disabled={isLast}
          aria-label={`Move subsidy ${index + 1} down`}
        >
          ↓
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRemove}
          aria-label={`Remove subsidy ${index + 1}`}
          ref={removeButtonRef}
        >
          Remove
        </Button>
      </div>
    </fieldset>
  );
}
