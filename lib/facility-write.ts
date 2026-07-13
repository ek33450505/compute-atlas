import { eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";

import { facilitySchema, type Facility } from "@/lib/schema";
import { getDb } from "@/lib/db/client";
import { facilitiesTable } from "@/lib/db/schema";
import { docToRow } from "@/lib/db/serialize";

export type WriteResult =
  | { ok: true; facility: Facility }
  | { ok: false; status: number; error: string; issues?: unknown };

/**
 * Busts the `unstable_cache` tag `loadFacilities` reads under (primary
 * invalidation) and regenerates statically-rendered pages (/map, /table,
 * /facilities/[slug], ...) so a write is reflected with no redeploy.
 *
 * Next 16's `revalidateTag` takes a mandatory cache-life `profile` — "max"
 * fully expires the tag immediately (no stale window), which is what a write
 * needs (contrast with a timed profile like "hours" that permits staleness).
 */
function revalidateFacilities(): void {
  revalidateTag("facilities", "max");
  revalidatePath("/", "layout");
}

/**
 * Validates and inserts a new facility. Rejects with 400 on schema failure,
 * 409 if a row with the same id already exists (checked directly against the
 * DB, not the cached read path — the cache can be stale by definition).
 */
export async function createFacility(input: unknown): Promise<WriteResult> {
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
  revalidateFacilities();
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
 */
export async function updateFacility(id: string, patch: unknown): Promise<WriteResult> {
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
  revalidateFacilities();
  return { ok: true, facility: doc };
}

/** Deletes a facility by id. 404s (rather than no-op 200) if it doesn't exist. */
export async function deleteFacility(id: string): Promise<WriteResult> {
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
  revalidateFacilities();
  return { ok: true, facility: existingRow.doc };
}
