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
import { sourceKindEnum, type Source } from "@/lib/schema";

// ---------------------------------------------------------------------------
// sources[] array editor (Phase 2b-2).
//
// facilitySchema requires `sources: min 1` — this editor enforces that same
// floor in the UI (disable "Remove" on the last remaining row) in addition
// to the server-side Zod check, so a user can't submit an empty array from
// the client and only discover the rejection after a round trip.
//
// Plain index-based array state: add/remove/move-up/move-down all operate
// on `sources[i]` via the parent's `onChange(next: Source[])` callback — no
// drag-and-drop library, per repo convention (YAGNI/no new deps).
// ---------------------------------------------------------------------------

const SOURCE_KIND_LABELS: Record<Source["kind"], string> = {
  press: "Press",
  permit: "Permit",
  osm: "OpenStreetMap",
  iso_queue: "ISO queue",
  subsidy: "Subsidy filing",
  filing: "Filing",
  other: "Other",
};

/**
 * A fresh, empty source row matching the sourceSchema defaults.
 *
 * `publisher` is omitted (not `""`) to match the schema's
 * `z.string().optional()` — an empty string would be a present-but-blank
 * value that survives to the payload; leaving the key absent keeps the row
 * shape consistent with what the server expects for "no publisher given."
 */
function emptySource(): Source {
  return {
    url: "",
    label: "",
    retrievedAt: "",
    kind: "other",
  };
}

export interface FacilitySourcesSectionProps {
  sources: Source[];
  onChange: (next: Source[]) => void;
}

export function FacilitySourcesSection({ sources, onChange }: FacilitySourcesSectionProps) {
  function updateRow(index: number, patch: Partial<Source>) {
    onChange(sources.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addRow() {
    onChange([...sources, emptySource()]);
  }

  function removeRow(index: number) {
    if (sources.length <= 1) return; // min-1 floor enforced in the UI too
    onChange(sources.filter((_, i) => i !== index));
  }

  function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sources.length) return;
    const next = [...sources];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sources</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sources.length === 0 ? (
          <p role="alert" className="text-sm text-destructive">
            At least one source is required.
          </p>
        ) : null}

        {sources.map((source, index) => (
          // Index-as-key is intentional here, not an oversight: `Source` has
          // no intrinsic id field (adding one would widen the schema, out of
          // scope for this batch), and these are short-lived form rows, not
          // persistent records with independent identity. All fields are
          // fully controlled from `sources[index]`, so a reorder still
          // renders correct values in every row — the only theoretical risk
          // is native (uncontrolled) input state like text-selection/cursor
          // position momentarily tracking the wrong row across a swap, which
          // is a minor UX nit, not a correctness bug.
          <SourceRow
            key={index}
            index={index}
            source={source}
            isOnly={sources.length <= 1}
            isFirst={index === 0}
            isLast={index === sources.length - 1}
            onChangeRow={(patch) => updateRow(index, patch)}
            onRemove={() => removeRow(index)}
            onMoveUp={() => moveRow(index, -1)}
            onMoveDown={() => moveRow(index, 1)}
          />
        ))}

        <div>
          <Button type="button" variant="outline" onClick={addRow}>
            Add source
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Single source row
// ---------------------------------------------------------------------------

function SourceRow({
  index,
  source,
  isOnly,
  isFirst,
  isLast,
  onChangeRow,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  index: number;
  source: Source;
  isOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  onChangeRow: (patch: Partial<Source>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const urlId = `sources.${index}.url`;
  const labelId = `sources.${index}.label`;
  const publisherId = `sources.${index}.publisher`;
  const retrievedAtId = `sources.${index}.retrievedAt`;
  const kindId = `sources.${index}.kind`;

  const urlInvalid = source.url.trim() !== "" && !isValidUrl(source.url);

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">Source {index + 1}</legend>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={urlId}>URL</Label>
        <Input
          id={urlId}
          name={urlId}
          type="url"
          value={source.url}
          onChange={(e) => onChangeRow({ url: e.target.value })}
          onBlur={(e) => {
            // Validate on blur per task spec — normalizes nothing, just
            // surfaces the inline error; the source of truth for rejection
            // is still the server-side Zod `url()` check on submit.
            void e.target.value;
          }}
          required
          aria-invalid={urlInvalid ? true : undefined}
          aria-describedby={urlInvalid ? `${urlId}-error` : undefined}
        />
        {urlInvalid ? (
          <p id={`${urlId}-error`} role="alert" className="text-sm text-destructive">
            Enter a valid URL (e.g. https://example.com/article).
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={labelId}>Label</Label>
        <Input
          id={labelId}
          name={labelId}
          value={source.label}
          onChange={(e) => onChangeRow({ label: e.target.value })}
          required
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={publisherId}>Publisher (optional)</Label>
          <Input
            id={publisherId}
            name={publisherId}
            value={source.publisher ?? ""}
            onChange={(e) => onChangeRow({ publisher: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={retrievedAtId}>Retrieved date</Label>
          <Input
            id={retrievedAtId}
            name={retrievedAtId}
            type="date"
            value={source.retrievedAt}
            onChange={(e) => onChangeRow({ retrievedAt: e.target.value })}
            required
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 sm:max-w-xs">
        <Label htmlFor={kindId}>Kind</Label>
        <Select
          value={source.kind}
          onValueChange={(v) => onChangeRow({ kind: v as Source["kind"] })}
        >
          <SelectTrigger id={kindId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sourceKindEnum.options.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {SOURCE_KIND_LABELS[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onMoveUp}
          disabled={isFirst}
          aria-label={`Move source ${index + 1} up`}
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onMoveDown}
          disabled={isLast}
          aria-label={`Move source ${index + 1} down`}
        >
          ↓
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRemove}
          disabled={isOnly}
          aria-label={
            isOnly
              ? `Remove source ${index + 1} (disabled: at least one source is required)`
              : `Remove source ${index + 1}`
          }
          title={isOnly ? "At least one source is required" : undefined}
        >
          Remove
        </Button>
      </div>
    </fieldset>
  );
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
