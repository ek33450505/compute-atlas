import { desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { facilityHistoryTable, type FacilityHistoryRow } from "@/lib/db/schema";
import { DocDiffView } from "@/components/admin/doc-diff";

const CHANGE_TYPE_LABEL: Record<string, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
};

function formatChangedAt(changedAt: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(changedAt);
}

function HistoryEntry({ entry }: { entry: FacilityHistoryRow }) {
  const label = CHANGE_TYPE_LABEL[entry.changeType] ?? entry.changeType;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground">via {entry.source}</span>
        </div>
        <span className="text-xs text-muted-foreground">{formatChangedAt(entry.changedAt)}</span>
      </div>
      <DocDiffView entries={entry.diff} />
    </div>
  );
}

/**
 * /admin/facilities/[id]'s "History" tab content. Queries `facility_history`
 * directly (reverse-chronological via the table's own
 * `facility_history_facility_id_changed_at_idx`) and renders each row's
 * already-computed `diff` column via the shared `DocDiffView` — no live
 * diffing happens here, this is a direct render of stored audit data.
 */
export async function HistoryPanel({ facilityId }: { facilityId: string }) {
  const db = getDb();
  const entries = await db
    .select()
    .from(facilityHistoryTable)
    .where(eq(facilityHistoryTable.facilityId, facilityId))
    .orderBy(desc(facilityHistoryTable.changedAt));

  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No history recorded for this facility yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <HistoryEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
