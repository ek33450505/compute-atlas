import type { DiffEntry } from "@/lib/doc-diff";
import { Badge } from "@/components/ui/badge";

/**
 * Renders a pre-computed shallow top-level diff (`DiffEntry[]`) as a
 * Badge-labeled Before/After grid, one card per changed key. Purely
 * presentational — takes already-computed entries, does no diffing itself.
 *
 * Extracted from `app/admin/submissions/submission-detail.tsx`'s original
 * inline `UpdateDiff` JSX (same visual design) so both the submission diff
 * view and the facility history panel (`app/admin/facilities/[id]/history-panel.tsx`)
 * share one rendering implementation.
 */

export function stringifyValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

export function DocDiffView({ entries }: { entries: DiffEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No field-level changes detected.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <div key={entry.key} className="rounded-md border border-border p-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{entry.key}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Badge variant="outline" className="mb-1">
                Before
              </Badge>
              <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
                {stringifyValue(entry.before)}
              </p>
            </div>
            <div>
              <Badge variant="secondary" className="mb-1">
                After
              </Badge>
              <p className="text-sm break-words whitespace-pre-wrap">
                {stringifyValue(entry.after)}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
