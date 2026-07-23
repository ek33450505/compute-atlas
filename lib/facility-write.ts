import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";

import { facilitySchema, type Facility } from "@/lib/schema";
import { getDb } from "@/lib/db/client";
import { facilitiesTable, facilityHistoryTable } from "@/lib/db/schema";
import { docToRow } from "@/lib/db/serialize";
import { computeDocDiff, type DiffEntry } from "@/lib/doc-diff";
import { statusUpdateIntentSchema, applyStatusUpdate } from "@/lib/status-update";

export type WriteResult =
  | { ok: true; facility: Facility }
  | { ok: false; status: number; error: string; issues?: unknown };

/**
 * Busts only the scoped `unstable_cache` tags that could have changed for
 * this write, instead of the old global `"facilities"` nuke — shrinking a
 * write's blast radius from the whole ~700-page surface to ~2-3 scoped
 * pages. The global `"facilities"` tag is deliberately NOT busted here
 * anymore: aggregate pages (home, map, table, stats, ...) now refresh on
 * their own cheap `revalidate: 3600` timer (see `loadFacilities` in
 * `lib/data.ts`) — approved ~1h freshness tolerance (Ed, 2026-07-22
 * ISR-write-blowout fix). `revalidatePath("/", "layout")` is also dropped:
 * it was redundant with (and broader than) the tag nuke it accompanied.
 *
 * - Always busts `facility:${doc.id}` (the detail page) and
 *   `state:${doc.location.state}` (the new/current state's landing page).
 * - If `prevDoc` is given and its state differs from `doc`'s, also busts
 *   the *old* state's tag — otherwise a facility that moved states would
 *   leave a stale entry on its old state's landing page.
 * - If either `doc` or `prevDoc` is a `power_generation` facility, also
 *   busts `power-generation` — the shared tag backing the facility detail
 *   page's "Powered by"/"Powers" cross-reference (`loadPowerGenerationCached`
 *   in `lib/data.ts`), on either side of a `poweredFacilityIds` link.
 *
 * Next 16's `revalidateTag` takes a mandatory cache-life `profile` — "max"
 * fully expires the tag immediately (no stale window), which is what a write
 * needs (contrast with a timed profile like "hours" that permits staleness).
 */
function revalidateForFacility(doc: Facility, prevDoc?: Facility): void {
  revalidateTag(`facility:${doc.id}`, "max");
  revalidateTag(`state:${doc.location.state.toUpperCase()}`, "max");

  if (prevDoc && prevDoc.location.state !== doc.location.state) {
    revalidateTag(`state:${prevDoc.location.state.toUpperCase()}`, "max");
  }

  if (doc.facilityType === "power_generation" || prevDoc?.facilityType === "power_generation") {
    revalidateTag("power-generation", "max");
  }
}

/**
 * Inserts one `facility_history` audit row. Deliberately log-and-continue on
 * failure rather than propagating/rolling back the facility mutation — the
 * facility write is the source of truth Ed cares about most; losing one
 * history row is recoverable, whereas failing a facility save because the
 * audit table hiccuped would be a worse outcome. (Judgment call per Phase 5a
 * of the admin-ui-part2 plan.)
 */
async function recordFacilityHistory(
  facilityId: string,
  changeType: "create" | "update" | "delete",
  diff: DiffEntry[],
  source: string
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(facilityHistoryTable).values({ facilityId, changeType, diff, source });
  } catch (err) {
    console.error(`facility_history insert failed for ${facilityId} (${changeType}):`, err);
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
  await recordFacilityHistory(doc.id, "create", computeDocDiff(null, doc), source);
  revalidateForFacility(doc);
  return { ok: true, facility: doc };
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
  await recordFacilityHistory(id, "update", computeDocDiff(existingRow.doc, doc), source);
  revalidateForFacility(doc, existingRow.doc);
  return { ok: true, facility: doc };
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
  await recordFacilityHistory(id, "update", computeDocDiff(existingRow.doc, doc), source);
  revalidateForFacility(doc, existingRow.doc);
  return { ok: true, facility: doc };
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
  await recordFacilityHistory(id, "delete", computeDocDiff(existingRow.doc, null), source);
  // Only the deleted doc exists (no prevDoc) — still correctly busts
  // facility:${id}, state:${state}, and power-generation (if applicable).
  revalidateForFacility(existingRow.doc);
  return { ok: true, facility: existingRow.doc };
}
