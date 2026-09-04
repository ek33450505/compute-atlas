import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";

import { facilitySchema, type Facility } from "@/lib/schema";
import { tagsForFacility } from "@/lib/cache-tags";
import { getDb } from "@/lib/db/client";
import { facilitiesTable, type FacilityRow } from "@/lib/db/schema";
import { docToRow } from "@/lib/db/serialize";
import { computeDocDiff, type DiffEntry } from "@/lib/doc-diff";
import { insertFacilityHistoryRow } from "@/lib/facility-history";
import { statusUpdateIntentSchema, applyStatusUpdate } from "@/lib/status-update";
import { enrichmentUpdateIntentSchema, applyEnrichmentUpdate } from "@/lib/enrichment-update";

export type WriteResult =
  | { ok: true; facility: Facility; historyRecorded?: boolean }
  | { ok: false; status: number; error: string; issues?: unknown };

/**
 * Busts only the scoped `unstable_cache` tags that could have changed for
 * this write, instead of the old global `"facilities"` nuke. Which tags
 * those are lives in `lib/cache-tags.ts` — shared with `POST /api/revalidate`
 * so the app's own busting and an out-of-band bulk CLI's can't drift apart.
 * `revalidatePath("/", "layout")` is also dropped: it was redundant with
 * (and broader than) the tag nuke it accompanied.
 *
 * Next 16's `revalidateTag` takes a mandatory cache-life `profile` — "max"
 * fully expires the tag immediately (no stale window), which is what a write
 * needs (contrast with a timed profile like "hours" that permits staleness).
 */
function revalidateForFacility(doc: Facility, prevDoc?: Facility): void {
  for (const tag of tagsForFacility(doc, prevDoc)) {
    revalidateTag(tag, "max");
  }
}

/**
 * Thin wrapper over the shared `insertFacilityHistoryRow` leaf
 * (`lib/facility-history.ts`) so the call sites below keep reading
 * `recordFacilityHistory`, and so `WriteResult.historyRecorded` plumbing
 * doesn't change. The insert itself, and the log-and-continue-on-failure
 * design it implements — losing one audit row is recoverable, whereas
 * failing a facility save because the audit table hiccuped would be a worse
 * outcome (judgment call per Phase 5a of the admin-ui-part2 plan) — now live
 * in the leaf, shared with `scripts/sync-to-neon.ts` and `scripts/seed.ts`
 * (previously three separate copies of this same body, kept separate only
 * because this file also imports `next/cache` at module scope, which throws
 * outside the Next.js runtime — see the leaf's header comment). This wrapper
 * just forwards the boolean so callers here can carry it on
 * `WriteResult.historyRecorded`.
 */
async function recordFacilityHistory(
  facilityId: string,
  changeType: "create" | "update" | "delete",
  diff: DiffEntry[],
  source: string
): Promise<boolean> {
  return insertFacilityHistoryRow(facilityId, changeType, diff, source);
}

/**
 * Shared "fetch by id or 404" for every mutation below except
 * `createFacility` (which checks for a 409 on a *different* query, not a
 * 404). `updateFacility`, `writeStatusUpdate`, `writeEnrichmentUpdate`, and
 * `deleteFacility` all need the existing row in hand before deciding what to
 * merge/apply/delete, and all 404 identically when it's missing. Returns the
 * `WriteResult`-shaped miss directly so a call site can `return` it as-is;
 * narrows to `{ ok: true; row }` otherwise.
 */
async function fetchExistingRowOr404(
  id: string
): Promise<{ ok: true; row: FacilityRow } | { ok: false; status: number; error: string }> {
  const db = getDb();
  const existingRows = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, id));
  const existingRow = existingRows[0];
  if (!existingRow) {
    return { ok: false, status: 404, error: "Facility not found" };
  }
  return { ok: true, row: existingRow };
}

/**
 * Shared "persist the merged doc, record history, revalidate, return ok"
 * tail for `updateFacility`, `writeStatusUpdate`, and
 * `writeEnrichmentUpdate` — each arrives at `doc` via a different merge
 * strategy (shallow patch, `applyStatusUpdate`, `applyEnrichmentUpdate`) but
 * finishes identically from there. `deleteFacility` is deliberately not a
 * caller: it deletes rather than updates, and diffs against `null` rather
 * than a new `doc`.
 */
async function persistUpdateAndRecordHistory(
  id: string,
  doc: Facility,
  prevDoc: Facility,
  source: string
): Promise<WriteResult> {
  const db = getDb();
  await db
    .update(facilitiesTable)
    .set({ ...docToRow(doc), updatedAt: new Date() })
    .where(eq(facilitiesTable.id, id));
  const historyRecorded = await recordFacilityHistory(id, "update", computeDocDiff(prevDoc, doc), source);
  revalidateForFacility(doc, prevDoc);
  return { ok: true, facility: doc, historyRecorded };
}

/**
 * Validates and inserts a new facility. Rejects with 400 on schema failure,
 * 409 if a row with the same id already exists (checked directly against the
 * DB, not the cached read path — the cache can be stale by definition).
 *
 * `source` attributes the resulting audit-log row: `"admin-direct"` for a
 * direct admin write, or a submission id when the write came from an
 * approved submission (see `lib/submissions.ts`'s `approveSubmission`).
 */
export async function createFacility(
  input: unknown,
  source: string = "admin-direct"
): Promise<WriteResult> {
  const parsed = facilitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  const db = getDb();
  const existing = await db
    .select({ id: facilitiesTable.id })
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, doc.id));
  if (existing.length > 0) {
    return { ok: false, status: 409, error: "Facility already exists" };
  }

  await db.insert(facilitiesTable).values(docToRow(doc));
  const historyRecorded = await recordFacilityHistory(doc.id, "create", computeDocDiff(null, doc), source);
  revalidateForFacility(doc);
  return { ok: true, facility: doc, historyRecorded };
}

/**
 * Shallow top-level merge of `patch` onto the existing doc, then re-validates
 * the whole merged object against `facilitySchema`. `id` is always forced
 * from the URL — a body carrying a different `id` can never move a record.
 *
 * PATCH replaces top-level fields wholesale (no deep merge): to change a
 * nested field like `location.city`, send the full `location` object. YAGNI —
 * a deep-merge patch format isn't needed yet.
 *
 * `source` attributes the resulting audit-log row (see `createFacility`).
 */
export async function updateFacility(
  id: string,
  patch: unknown,
  source: string = "admin-direct"
): Promise<WriteResult> {
  const found = await fetchExistingRowOr404(id);
  if (!found.ok) {
    return found;
  }
  const existingRow = found.row;

  const merged = { ...existingRow.doc, ...(patch as object), id };
  const parsed = facilitySchema.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  return persistUpdateAndRecordHistory(id, doc, existingRow.doc, source);
}

/**
 * Applies a status-transition intent to an existing facility via the
 * append-only applyStatusUpdate (lib/status-update.ts) — the safe alternative
 * to updateFacility's shallow merge for discovery status refreshes. Because it
 * only appends to `sources`, existing sourceIndex references (community,
 * subsidies, jobs, prior statusHistory) stay in range, so the merged doc can't
 * become internally inconsistent the way a sources-replacing update patch can.
 * Re-validates the result against facilitySchema as defense-in-depth.
 */
export async function writeStatusUpdate(
  id: string,
  intent: unknown,
  source: string = "admin-direct"
): Promise<WriteResult> {
  const parsedIntent = statusUpdateIntentSchema.safeParse(intent);
  if (!parsedIntent.success) {
    return { ok: false, status: 400, error: "Invalid status update", issues: parsedIntent.error.issues };
  }

  const found = await fetchExistingRowOr404(id);
  if (!found.ok) {
    return found;
  }
  const existingRow = found.row;

  const applied = applyStatusUpdate(existingRow.doc, parsedIntent.data);
  const parsed = facilitySchema.safeParse(applied);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  return persistUpdateAndRecordHistory(id, doc, existingRow.doc, source);
}

/**
 * Applies an enrichment intent to an existing facility via the append-only
 * applyEnrichmentUpdate (lib/enrichment-update.ts) — the safe alternative to
 * updateFacility's shallow merge for discovery enrichment runs. Because it
 * only fills currently-`undefined` fields and only appends to `sources`, it
 * can never contest a curated value or move an existing sourceIndex-bearing
 * field out of range, so the merged doc can't become internally inconsistent
 * the way a sources-replacing update patch can. Re-validates the result
 * against facilitySchema as defense-in-depth.
 */
export async function writeEnrichmentUpdate(
  id: string,
  intent: unknown,
  source: string = "admin-direct"
): Promise<WriteResult> {
  const parsedIntent = enrichmentUpdateIntentSchema.safeParse(intent);
  if (!parsedIntent.success) {
    return { ok: false, status: 400, error: "Invalid enrichment update", issues: parsedIntent.error.issues };
  }

  const found = await fetchExistingRowOr404(id);
  if (!found.ok) {
    return found;
  }
  const existingRow = found.row;

  const applied = applyEnrichmentUpdate(existingRow.doc, parsedIntent.data);
  const parsed = facilitySchema.safeParse(applied);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  return persistUpdateAndRecordHistory(id, doc, existingRow.doc, source);
}

/**
 * Deletes a facility by id. 404s (rather than no-op 200) if it doesn't exist.
 *
 * `source` attributes the resulting audit-log row (see `createFacility`).
 */
export async function deleteFacility(
  id: string,
  source: string = "admin-direct"
): Promise<WriteResult> {
  const found = await fetchExistingRowOr404(id);
  if (!found.ok) {
    return found;
  }
  const existingRow = found.row;

  const db = getDb();
  await db.delete(facilitiesTable).where(eq(facilitiesTable.id, id));
  const historyRecorded = await recordFacilityHistory(id, "delete", computeDocDiff(existingRow.doc, null), source);
  // Only the deleted doc exists (no prevDoc) — still correctly busts
  // facility:${id}, state:${state}, and power-generation (if applicable).
  revalidateForFacility(existingRow.doc);
  return { ok: true, facility: existingRow.doc, historyRecorded };
}
