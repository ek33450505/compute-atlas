import type { FacilityHistoryRow } from "@/lib/db/schema";
import type { Facility } from "@/lib/schema";

/**
 * Pure builder for an edition's `changelog.json` and the short summary stored
 * with the edition row and shown in the weekly notice. No DB, no fs: the cron
 * loads `facility_history` and the current facilities and passes them in.
 *
 * The output deliberately carries only ids, names, states and changed field
 * KEYS. No diff values, no row ids, no per-change timestamps and never the
 * row's `source` (actor / submitter provenance); the input type does not even
 * accept it, and the builders copy named fields only.
 */

export interface ChangelogEntry {
  id: string;
  /** Absent only for a removed facility whose delete diff carried no name. */
  name?: string;
  state?: string;
  /** Changed top-level field keys, sorted. Present on `updated` entries only. */
  fields?: string[];
}

export interface DatasetChangelogSummary {
  added: number;
  updated: number;
  removed: number;
  /** At most `MAX_HEADLINES`, plain and impersonal. */
  headlines: string[];
  /** Records with a value per field key; added by the edition builder, not by `buildChangelog`. */
  coverage?: Record<string, number>;
}

export interface EditionWindow {
  /** `null` for the first edition. */
  from: string | null;
  to: string;
}

/**
 * Discriminated on `initial`. The first edition (no previous build) carries a
 * record count instead of a history dump; every later edition lists changes
 * inside its window.
 */
export type DatasetChangelog =
  | { initial: true; editionWindow: EditionWindow; recordCount: number }
  | {
      initial: false;
      editionWindow: EditionWindow;
      added: ChangelogEntry[];
      updated: ChangelogEntry[];
      removed: ChangelogEntry[];
    };

export interface BuildChangelogInput {
  history: Array<Pick<FacilityHistoryRow, "facilityId" | "changedAt" | "changeType" | "diff">>;
  facilities: Facility[];
  prevBuiltAt: Date | null;
  builtAt: Date;
}

export const MAX_HEADLINES = 10;

type HistoryRow = BuildChangelogInput["history"][number];

/**
 * Tie-break for rows with the same `changedAt`: create, then update, then
 * delete. Timestamps cannot say which of two simultaneous rows came first, so
 * this fixes the outcome by rule, not by causality: a delete tied with an update
 * is `removed`, and a create tied with a delete reads as created then deleted
 * (omitted). A genuine delete-then-create at one instant is not recoverable.
 */
const CHANGE_RANK: Record<HistoryRow["changeType"], number> = {
  create: 0,
  update: 1,
  editorial: 1,
  delete: 2,
};

interface Collapsed {
  entry: ChangelogEntry;
  statusChange?: { before: unknown; after: unknown };
}

/** Code-point comparison: locale-independent, so output is deterministic. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byNameThenId(a: ChangelogEntry, b: ChangelogEntry): number {
  return cmp(a.name ?? a.id, b.name ?? b.id) || cmp(a.id, b.id);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The newest diff value for `key`, read from `before` (delete rows) or `after`. */
function lastDiffValue(rows: HistoryRow[], key: string, side: "before" | "after"): unknown {
  for (let i = rows.length - 1; i >= 0; i--) {
    const hit = rows[i].diff.find((d) => d.key === key);
    if (hit && hit[side] != null) return hit[side];
  }
  return undefined;
}

function stateFromLocation(location: unknown): string | undefined {
  return isRecord(location) && typeof location.state === "string" ? location.state : undefined;
}

function makeEntry(
  id: string,
  rows: HistoryRow[],
  current: Facility | undefined,
  side: "before" | "after",
): ChangelogEntry {
  const diffName = lastDiffValue(rows, "name", side);
  const name = current?.name ?? (typeof diffName === "string" ? diffName : undefined);
  const state = current?.location.state ?? stateFromLocation(lastDiffValue(rows, "location", side));
  const entry: ChangelogEntry = { id };
  if (name !== undefined) entry.name = name;
  if (state !== undefined) entry.state = state;
  return entry;
}

function statusChangeOf(rows: HistoryRow[]): Collapsed["statusChange"] {
  const withStatus = rows.filter((r) => r.diff.some((d) => d.key === "status"));
  if (withStatus.length === 0) return undefined;
  const first = withStatus[0].diff.find((d) => d.key === "status");
  const last = withStatus[withStatus.length - 1].diff.find((d) => d.key === "status");
  if (!first || !last) return undefined;
  return { before: first.before, after: last.after };
}

function show(v: unknown): string {
  return v === null || v === undefined ? "none" : String(v);
}

/**
 * Builds the changelog for the window `(prevBuiltAt, builtAt]`: a row exactly
 * at `prevBuiltAt` belongs to the previous edition, one exactly at `builtAt`
 * to this one. The caller may pass rows outside the window; they are ignored.
 *
 * Per facility, rows in the window collapse in time order to one entry:
 * - first row is a create and last row is a delete: omitted;
 * - last row is a delete: `removed`;
 * - first row is a create: `added` (even if updated later in the window);
 * - otherwise `updated`, carrying the sorted union of changed top-level keys.
 *   An update whose diffs changed no key is omitted.
 * `editorial` rows (notes-only db:sync updates) never count.
 *
 * Deterministic: entries are sorted by name then id, and row order in the
 * input does not matter (ties on `changedAt` keep a stable, input-independent
 * order via `CHANGE_RANK`, then diff keys).
 */
export function buildChangelog(input: BuildChangelogInput): {
  changelog: DatasetChangelog;
  summary: DatasetChangelogSummary;
} {
  const { facilities, prevBuiltAt, builtAt } = input;
  const editionWindow: EditionWindow = {
    from: prevBuiltAt ? prevBuiltAt.toISOString() : null,
    to: builtAt.toISOString(),
  };

  if (prevBuiltAt === null) {
    return {
      changelog: { initial: true, editionWindow, recordCount: facilities.length },
      summary: {
        added: 0,
        updated: 0,
        removed: 0,
        headlines: [`Initial edition: ${facilities.length} records`],
      },
    };
  }

  const lower = prevBuiltAt.getTime();
  const upper = builtAt.getTime();
  const rowKey = (r: HistoryRow) => r.diff.map((d) => d.key).join(",");

  const byFacility = new Map<string, HistoryRow[]>();
  for (const r of input.history) {
    const t = r.changedAt.getTime();
    if (r.changeType === "editorial" || !(t > lower && t <= upper)) continue;
    const list = byFacility.get(r.facilityId);
    if (list) list.push(r);
    else byFacility.set(r.facilityId, [r]);
  }

  const currentById = new Map(facilities.map((f) => [f.id, f]));
  const added: Collapsed[] = [];
  const updated: Collapsed[] = [];
  const removed: Collapsed[] = [];

  for (const [id, unsorted] of byFacility) {
    const rows = [...unsorted].sort(
      (a, b) =>
        a.changedAt.getTime() - b.changedAt.getTime() ||
        (CHANGE_RANK[a.changeType] ?? 1) - (CHANGE_RANK[b.changeType] ?? 1) ||
        cmp(rowKey(a), rowKey(b)),
    );
    const firstIsCreate = rows[0].changeType === "create";
    const lastIsDelete = rows[rows.length - 1].changeType === "delete";
    const current = currentById.get(id);

    if (lastIsDelete) {
      if (!firstIsCreate) removed.push({ entry: makeEntry(id, rows, undefined, "before") });
    } else if (firstIsCreate) {
      added.push({ entry: makeEntry(id, rows, current, "after") });
    } else {
      const fields = [...new Set(rows.flatMap((r) => r.diff.map((d) => d.key)))].sort(cmp);
      if (fields.length === 0) continue;
      const entry = { ...makeEntry(id, rows, current, "after"), fields };
      updated.push({ entry, statusChange: statusChangeOf(rows) });
    }
  }

  const sortCollapsed = (list: Collapsed[]) =>
    list.sort((a, b) => byNameThenId(a.entry, b.entry));
  sortCollapsed(added);
  sortCollapsed(updated);
  sortCollapsed(removed);

  const label = (e: ChangelogEntry) => e.name ?? e.id;
  const statusMoves = updated.filter(
    (u) => u.statusChange && show(u.statusChange.before) !== show(u.statusChange.after),
  );
  const otherUpdates = updated.filter(
    (u) => !statusMoves.includes(u) && u.entry.fields?.some((k) => k !== "status"),
  );
  // Removals rank above updates so the cap never drops the rarer, weightier change.
  const headlines = [
    ...added.map((a) => `Added: ${label(a.entry)}`),
    ...removed.map((r) => `Removed: ${label(r.entry)}`),
    ...statusMoves.map(
      (u) => `${label(u.entry)}: ${show(u.statusChange?.before)} → ${show(u.statusChange?.after)}`,
    ),
    ...otherUpdates.map((u) => `Updated: ${label(u.entry)} (${u.entry.fields?.join(", ")})`),
  ].slice(0, MAX_HEADLINES);

  return {
    changelog: {
      initial: false,
      editionWindow,
      added: added.map((c) => c.entry),
      updated: updated.map((c) => c.entry),
      removed: removed.map((c) => c.entry),
    },
    summary: {
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      headlines,
    },
  };
}
