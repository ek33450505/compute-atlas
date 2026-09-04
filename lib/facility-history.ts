import { getDb } from "@/lib/db/client";
import { facilityHistoryTable } from "@/lib/db/schema";
import type { DiffEntry } from "@/lib/doc-diff";

/**
 * Leaf for the one `facility_history` audit-row insert, shared by every
 * place that writes one: `lib/facility-write.ts` (`recordFacilityHistory`,
 * the app's HTTP write path), `scripts/sync-to-neon.ts` (`recordHistory`,
 * the maintainer bulk-publish CLI), and `scripts/seed.ts` (the bootstrap
 * insert loop). All three used to carry their own copy of this exact body.
 *
 * The copies existed because `lib/facility-write.ts` also imports
 * `revalidateTag` from `next/cache` at module scope — that import only
 * resolves inside the Next.js runtime and throws when the module is loaded
 * from a bare Node/tsx process, so `sync-to-neon.ts` and `seed.ts` (both
 * plain `tsx` CLIs) couldn't import `recordFacilityHistory` from there
 * without dragging `next/cache` in along with it. This module has no such
 * import — only `lib/db/client`, `lib/db/schema`, and `lib/doc-diff`'s
 * type-only `DiffEntry` — so it's safe for every caller, Next runtime or
 * bare tsx alike. Mirrors the existing `lib/cache-tags.ts` /
 * `lib/operator-slug.ts` leaf precedent.
 *
 * Deliberately log-and-continue on failure rather than throwing or rolling
 * back the caller's facility mutation — losing one audit row is recoverable;
 * failing (or rolling back) a facility write because the audit table
 * hiccuped would be a worse outcome. (Judgment call per Phase 5a of the
 * admin-ui-part2 plan.) Returns `true`/`false` instead so each caller can
 * decide how loudly to surface a failure: `lib/facility-write.ts` carries it
 * on `WriteResult.historyRecorded`, `sync-to-neon.ts` collects the failing
 * ids and exits non-zero, and `seed.ts` relies on the `console.error` below
 * alone.
 */
export async function insertFacilityHistoryRow(
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
