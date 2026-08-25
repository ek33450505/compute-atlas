import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";

import { facilitySchema, type Facility } from "@/lib/schema";
import { tagsForFacility } from "@/lib/cache-tags";
import { getDb } from "@/lib/db/client";
import { facilitiesTable, facilityHistoryTable } from "@/lib/db/schema";
import { docToRow } from "@/lib/db/serialize";
import { computeDocDiff, type DiffEntry } from "@/lib/doc-diff";
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
 * Inserts one `facility_history` audit row. Deliberately log-and-continue on
 * failure rather than propagating/rolling back the facility mutation — the
 * facility write is the source of truth Ed cares about most; losing one
 * history row is recoverable, whereas failing a facility save because the
 * audit table hiccuped would be a worse outcome. (Judgment call per Phase 5a
 * of the admin-ui-part2 plan.)
 *
 * Still never throws or rolls back the facility mutation. Instead, returns
 * `true`/`false` so the caller can carry the outcome on `WriteResult.
 * historyRecorded` — a failure is logged here (as before) AND surfaced to
 * whoever triggered the write, instead of only living in the server log.
 */
async function recordFacilityHistory(
  facilityId: string,
  changeType: "create" | "update" | "delete",
  diff: DiffEntry[],
  source: string
): Promise<boolean> {
  try {
    const db = getDb();
    await db.insert(facilityHistoryTable).values({ facilityId, changeType, diff, source });
    return true;
  } catch (err) {
    console.error("facility_history insert failed for %s (%s):", facilityId, changeType, err);
    return false;
  }
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
  const db = getDb();
  const existingRows = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, id));
  const existingRow = existingRows[0];
  if (!existingRow) {
    return { ok: false, status: 404, error: "Facility not found" };
  }

  const merged = { ...existingRow.doc, ...(patch as object), id };
  const parsed = facilitySchema.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  await db
    .update(facilitiesTable)
    .set({ ...docToRow(doc), updatedAt: new Date() })
    .where(eq(facilitiesTable.id, id));
  const historyRecorded = await recordFacilityHistory(id, "update", computeDocDiff(existingRow.doc, doc), source);
  revalidateForFacility(doc, existingRow.doc);
  return { ok: true, facility: doc, historyRecorded };
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

  const db = getDb();
  const existingRows = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, id));
  const existingRow = existingRows[0];
  if (!existingRow) {
    return { ok: false, status: 404, error: "Facility not found" };
  }

  const applied = applyStatusUpdate(existingRow.doc, parsedIntent.data);
  const parsed = facilitySchema.safeParse(applied);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  await db
    .update(facilitiesTable)
    .set({ ...docToRow(doc), updatedAt: new Date() })
    .where(eq(facilitiesTable.id, id));
  const historyRecorded = await recordFacilityHistory(id, "update", computeDocDiff(existingRow.doc, doc), source);
  revalidateForFacility(doc, existingRow.doc);
  return { ok: true, facility: doc, historyRecorded };
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

  const db = getDb();
  const existingRows = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, id));
  const existingRow = existingRows[0];
  if (!existingRow) {
    return { ok: false, status: 404, error: "Facility not found" };
  }

  const applied = applyEnrichmentUpdate(existingRow.doc, parsedIntent.data);
  const parsed = facilitySchema.safeParse(applied);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
  }
  const doc = parsed.data;

  await db
    .update(facilitiesTable)
    .set({ ...docToRow(doc), updatedAt: new Date() })
    .where(eq(facilitiesTable.id, id));
  const historyRecorded = await recordFacilityHistory(id, "update", computeDocDiff(existingRow.doc, doc), source);
  revalidateForFacility(doc, existingRow.doc);
  return { ok: true, facility: doc, historyRecorded };
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
  const db = getDb();
  const existingRows = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, id));
  const existingRow = existingRows[0];
  if (!existingRow) {
    return { ok: false, status: 404, error: "Facility not found" };
  }

  await db.delete(facilitiesTable).where(eq(facilitiesTable.id, id));
  const historyRecorded = await recordFacilityHistory(id, "delete", computeDocDiff(existingRow.doc, null), source);
  // Only the deleted doc exists (no prevDoc) — still correctly busts
  // facility:${id}, state:${state}, and power-generation (if applicable).
  revalidateForFacility(existingRow.doc);
  return { ok: true, facility: existingRow.doc, historyRecorded };
}
