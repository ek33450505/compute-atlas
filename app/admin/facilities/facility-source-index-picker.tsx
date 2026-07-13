"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { Source } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Reusable sourceIndex picker (Phase 2b-3).
//
// Given the CURRENT in-form `sources[]` array, renders a `Select` listing
// each populated source by a short label (kind + truncated url/label) and
// emits the selected array index, or `undefined` for "none".
//
// Shared by `statusHistory[].sourceIndex` and `subsidies[].sourceIndex` in
// this batch; reused again by `jobs.sourceIndex`/`community.sourceIndex` in
// 2b-4 — kept generic (no statusHistory/subsidies-specific naming) so those
// call sites can drop it in unchanged.
//
// Renders off the LIVE `sources` prop on every render, not a snapshot taken
// at mount — sources can be added/removed in the same session before submit
// (2b-2's array editor), so the option list always reflects what's actually
// in the form right now. This does NOT retroactively fix a `sourceIndex`
// that already points at a since-removed/reordered source (see the known,
// accepted positional-index tradeoff noted in the security review of
// Phase 2b-2 and the plan) — it only guarantees the PICKER itself never
// *offers* a currently-invalid index.
// ---------------------------------------------------------------------------

/**
 * Base UI's `Select.Root` (like Radix) has no clean way to represent "no
 * value selected" as an item — every `SelectItem` needs a non-empty string
 * value. This sentinel represents the "None" option internally; it is
 * translated to/from `number | undefined` at the picker's props boundary so
 * no caller ever sees or stores the sentinel string.
 */
const NONE_VALUE = "__none__";

export interface FacilitySourceIndexPickerProps {
  /** The current in-form sources array (live state, not a snapshot). */
  sources: Source[];
  /** The currently-selected source index, or undefined for "none". */
  value: number | undefined;
  /** Called with the new index, or undefined when "None" is selected. */
  onChange: (index: number | undefined) => void;
  /** Accessible label text; also used to derive a stable id. */
  label: string;
  id: string;
}

const SOURCE_KIND_SHORT_LABELS: Record<Source["kind"], string> = {
  press: "Press",
  permit: "Permit",
  osm: "OSM",
  iso_queue: "ISO queue",
  subsidy: "Subsidy",
  filing: "Filing",
  other: "Other",
};

/** A short "kind + truncated url/label" option label for one source row. */
function sourceOptionLabel(source: Source, index: number): string {
  const kindLabel = SOURCE_KIND_SHORT_LABELS[source.kind];
  const text = source.label.trim() || source.url.trim();
  const truncated = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return truncated ? `${index + 1}. ${kindLabel} — ${truncated}` : `${index + 1}. ${kindLabel}`;
}

export function FacilitySourceIndexPicker({
  sources,
  value,
  onChange,
  label,
  id,
}: FacilitySourceIndexPickerProps) {
  const selectValue = value != null && value < sources.length ? String(value) : NONE_VALUE;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={selectValue}
        onValueChange={(v) => onChange(v === NONE_VALUE ? undefined : Number(v))}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {sources.map((source, index) => (
            <SelectItem key={index} value={String(index)}>
              {sourceOptionLabel(source, index)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
