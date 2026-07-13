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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATUS_ORDER, STATUS_META, type Status } from "@/lib/status";
import type { Source, Facility } from "@/lib/schema";
import { FacilitySourceIndexPicker } from "@/app/admin/facilities/facility-source-index-picker";

// ---------------------------------------------------------------------------
// statusHistory[] array editor (Phase 2b-3).
//
// `facilitySchema.statusHistory` defaults to `[]` — this array is OPTIONAL
// in the sense that an empty array is a valid, complete submission (unlike
// `sources[]`'s min-1 floor), so there is no "at least one required" message
// here.
//
// Same plain index-based array-state pattern as the 2b-2 sources editor:
// add/remove/move-up/move-down all operate on `statusHistory[i]` via the
// parent's `onChange(next) callback — no drag-and-drop library.
// ---------------------------------------------------------------------------

type StatusHistoryEntry = Facility["statusHistory"][number];

/** A fresh, empty statusHistory row matching statusEventSchema's shape. */
function emptyStatusHistoryEntry(): StatusHistoryEntry {
  return {
    status: "proposed",
    date: "",
  };
}

export interface FacilityStatusHistorySectionProps {
  statusHistory: StatusHistoryEntry[];
  sources: Source[];
  onChange: (next: StatusHistoryEntry[]) => void;
}

export function FacilityStatusHistorySection({
  statusHistory,
  sources,
  onChange,
}: FacilityStatusHistorySectionProps) {
  function updateRow(index: number, patch: Partial<StatusHistoryEntry>) {
    onChange(statusHistory.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    onChange([...statusHistory, emptyStatusHistoryEntry()]);
  }

  function removeRow(index: number) {
    onChange(statusHistory.filter((_, i) => i !== index));
  }

  function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= statusHistory.length) return;
    const next = [...statusHistory];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Status history</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {statusHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No status history entries yet.</p>
        ) : null}

        {statusHistory.map((entry, index) => (
          // Index-as-key: same rationale as FacilitySourcesSection — these
          // rows have no intrinsic id, are short-lived form state, and are
          // fully controlled from statusHistory[index], so a reorder always
          // renders correct values.
          <StatusHistoryRow
            key={index}
            index={index}
            entry={entry}
            sources={sources}
            isFirst={index === 0}
            isLast={index === statusHistory.length - 1}
            onChangeRow={(patch) => updateRow(index, patch)}
            onRemove={() => removeRow(index)}
            onMoveUp={() => moveRow(index, -1)}
            onMoveDown={() => moveRow(index, 1)}
          />
        ))}

        <div>
          <Button type="button" variant="outline" onClick={addRow}>
            Add status history entry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Single statusHistory row
// ---------------------------------------------------------------------------

function StatusHistoryRow({
  index,
  entry,
  sources,
  isFirst,
  isLast,
  onChangeRow,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  index: number;
  entry: StatusHistoryEntry;
  sources: Source[];
  isFirst: boolean;
  isLast: boolean;
  onChangeRow: (patch: Partial<StatusHistoryEntry>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const statusId = `statusHistory.${index}.status`;
  const dateId = `statusHistory.${index}.date`;
  const noteId = `statusHistory.${index}.note`;
  const sourceIndexId = `statusHistory.${index}.sourceIndex`;

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">Status history entry {index + 1}</legend>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={statusId}>Status</Label>
          <Select
            value={entry.status}
            onValueChange={(v) => onChangeRow({ status: v as Status })}
          >
            <SelectTrigger id={statusId} className="w-full">
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
          <Label htmlFor={dateId}>Date</Label>
          <Input
            id={dateId}
            name={dateId}
            type="date"
            value={entry.date}
            onChange={(e) => onChangeRow({ date: e.target.value })}
            required
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Input
          id={noteId}
          name={noteId}
          value={entry.note ?? ""}
          onChange={(e) => onChangeRow({ note: e.target.value })}
        />
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
          aria-label={`Move status history entry ${index + 1} up`}
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onMoveDown}
          disabled={isLast}
          aria-label={`Move status history entry ${index + 1} down`}
        >
          ↓
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRemove}
          aria-label={`Remove status history entry ${index + 1}`}
        >
          Remove
        </Button>
      </div>
    </fieldset>
  );
}
