import { and, desc, eq, gt, lt, lte, notInArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  datasetEditionsTable,
  facilityHistoryTable,
  type DatasetEditionFile,
  type FacilityHistoryRow,
} from "@/lib/db/schema";

/**
 * Lifecycle of a weekly dataset edition row (`dataset_editions`): claim, then
 * publish or fail. DB only: no Blob, no mail. The builder
 * (`lib/dataset-edition-builder.ts`) orchestrates; every state move here is one
 * atomic statement guarded on the row's current state, never a read-then-write.
 *
 * `builtAt` carries two meanings over a row's life. While `building` it is the
 * CLAIM instant (it is the build's lease: a build older than
 * `DATASET_EDITION_STALE_MS` is presumed dead and may be reclaimed). On publish
 * it becomes the snapshot's `readAt`, so the next edition's changelog window
 * starts exactly where this edition's data ends.
 */

/** Published editions whose blobs are kept; older ones are pruned. */
export const EDITIONS_KEPT = 8;

/**
 * A `building` row older than this is presumed dead. Zombie safety (a "dead" build
 * still uploading while a reclaim starts) relies on Vercel killing the function at
 * its maxDuration (300 s), far below this 30 minutes; the guards on `publishEdition`
 * and `failEdition` are a second line, not the first.
 */
export const DATASET_EDITION_STALE_MS = 30 * 60 * 1000;

/**
 * A `failed` row is reclaimable only this long after it failed (`failEdition`
 * stamps `built_at` with the failure instant). Each build re-reads all of Neon, the
 * project's cost driver, so a repeat "Build now" click must not re-run it at once.
 */
export const DATASET_EDITION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export type ClaimResult =
  | { kind: "claimed"; id: string; reclaimed: boolean }
  | { kind: "alreadyPublished"; id: string }
  | { kind: "inProgress"; id: string };

/**
 * Takes the build lease for `editionDate`. Race-safe: the insert is
 * `ON CONFLICT DO NOTHING` on the unique date, and a takeover of a failed or
 * stale row is one atomic UPDATE, so two concurrent claims yield exactly one
 * `claimed`. `inProgress` also covers "a failed build was retried within the last
 * `DATASET_EDITION_RETRY_COOLDOWN_MS`". The weekly cron passes `ignoreRetryCooldown`: the
 * cooldown only exists to stop repeat admin "Build now" clicks and must not make the
 * cron skip a week. The stale-`building` rule is unaffected by it.
 */
export async function claimEdition(
  editionDate: string,
  now: Date = new Date(),
  { ignoreRetryCooldown = false }: { ignoreRetryCooldown?: boolean } = {}
): Promise<ClaimResult> {
  const db = getDb();

  const inserted = await db
    .insert(datasetEditionsTable)
    .values({ editionDate, builtAt: now, status: "building" })
    .onConflictDoNothing({ target: datasetEditionsTable.editionDate })
    .returning({ id: datasetEditionsTable.id });
  if (inserted.length > 0) return { kind: "claimed", id: inserted[0].id, reclaimed: false };

  const [existing] = await db
    .select({ id: datasetEditionsTable.id, status: datasetEditionsTable.status, builtAt: datasetEditionsTable.builtAt })
    .from(datasetEditionsTable)
    .where(eq(datasetEditionsTable.editionDate, editionDate));
  // The row can only vanish if someone deleted it between the two statements; treat as busy.
  if (!existing) throw new Error("dataset edition row vanished during claim");

  if (existing.status === "published") return { kind: "alreadyPublished", id: existing.id };

  const staleBefore = new Date(now.getTime() - DATASET_EDITION_STALE_MS);
  const retryBefore = new Date(now.getTime() - (ignoreRetryCooldown ? 0 : DATASET_EDITION_RETRY_COOLDOWN_MS));
  if (existing.status === "building" && existing.builtAt.getTime() >= staleBefore.getTime()) {
    return { kind: "inProgress", id: existing.id };
  }
  if (existing.status === "failed" && existing.builtAt.getTime() >= retryBefore.getTime()) {
    return { kind: "inProgress", id: existing.id };
  }

  const reclaimed = await db
    .update(datasetEditionsTable)
    .set({ status: "building", builtAt: now, files: [], recordCount: null, changelogSummary: null })
    .where(
      and(
        eq(datasetEditionsTable.id, existing.id),
        sql`((${datasetEditionsTable.status} = 'failed' AND ${datasetEditionsTable.builtAt} < ${retryBefore}) OR (${datasetEditionsTable.status} = 'building' AND ${datasetEditionsTable.builtAt} < ${staleBefore}))`
      )
    )
    .returning({ id: datasetEditionsTable.id });
  if (reclaimed.length === 0) return { kind: "inProgress", id: existing.id };
  return { kind: "claimed", id: existing.id, reclaimed: true };
}

export interface PublishEditionInput {
  /** The instant the snapshot was read; becomes the row's `builtAt`. */
  readAt: Date;
  recordCount: number;
  files: DatasetEditionFile[];
  changelogSummary: unknown;
}

/**
 * Marks the edition `published`. Guarded on `status = 'building'` AND
 * `built_at = claimBuiltAt`: a build that was reclaimed by someone else (its
 * lease went stale) no longer matches and cannot publish over the new claim.
 * Returns false when the claim was lost. A zombie (a build presumed dead after
 * `DATASET_EDITION_STALE_MS` that is somehow still running) is stopped by Vercel
 * killing the function at maxDuration, long before the lease goes stale; this guard
 * is the backstop. A served file is also never trusted blindly: U7a verifies each
 * file's sha256 against this record before it is handed out.
 */
export async function publishEdition(id: string, claimBuiltAt: Date, input: PublishEditionInput): Promise<boolean> {
  const rows = await getDb()
    .update(datasetEditionsTable)
    .set({
      status: "published",
      builtAt: input.readAt,
      recordCount: input.recordCount,
      files: input.files,
      changelogSummary: input.changelogSummary,
    })
    .where(
      and(
        eq(datasetEditionsTable.id, id),
        eq(datasetEditionsTable.status, "building"),
        eq(datasetEditionsTable.builtAt, claimBuiltAt)
      )
    )
    .returning({ id: datasetEditionsTable.id });
  return rows.length > 0;
}

/**
 * Marks the claimed build `failed` (same guard as publish: a lost claim is left
 * alone). `uploaded` is what reached Blob before the failure; recording it in
 * `files` is what lets a later prune find and delete the partial upload.
 * `built_at` is stamped with the failure instant (`failedAt`) so the retry
 * cooldown in `claimEdition` measures from the failure, not from the claim.
 */
export async function failEdition(
  id: string,
  claimBuiltAt: Date,
  uploaded: DatasetEditionFile[] = [],
  failedAt: Date = new Date()
): Promise<void> {
  await getDb()
    .update(datasetEditionsTable)
    .set({ status: "failed", files: uploaded, builtAt: failedAt })
    .where(
      and(
        eq(datasetEditionsTable.id, id),
        eq(datasetEditionsTable.status, "building"),
        eq(datasetEditionsTable.builtAt, claimBuiltAt)
      )
    );
}

export interface PublishedEdition {
  id: string;
  editionDate: string;
  builtAt: Date;
  recordCount: number | null;
  files: DatasetEditionFile[];
  changelogSummary: unknown;
}

/** The newest published edition by edition date, or null before the first one. */
export async function latestPublishedEdition(): Promise<PublishedEdition | null> {
  const [row] = await getDb()
    .select({
      id: datasetEditionsTable.id,
      editionDate: datasetEditionsTable.editionDate,
      builtAt: datasetEditionsTable.builtAt,
      recordCount: datasetEditionsTable.recordCount,
      files: datasetEditionsTable.files,
      changelogSummary: datasetEditionsTable.changelogSummary,
    })
    .from(datasetEditionsTable)
    .where(eq(datasetEditionsTable.status, "published"))
    .orderBy(desc(datasetEditionsTable.editionDate))
    .limit(1);
  return row ?? null;
}

/**
 * History rows in `(prevBuiltAt, upTo]` for the changelog. Selects only the four
 * columns the changelog builder accepts, NEVER `source` (actor / submitter
 * provenance). The first edition has no window and needs no history, so a null
 * lower bound returns [] rather than reading the whole table.
 */
export async function loadHistorySince(
  prevBuiltAt: Date | null,
  upTo: Date
): Promise<Array<Pick<FacilityHistoryRow, "facilityId" | "changedAt" | "changeType" | "diff">>> {
  if (prevBuiltAt === null) return [];
  return getDb()
    .select({
      facilityId: facilityHistoryTable.facilityId,
      changedAt: facilityHistoryTable.changedAt,
      changeType: facilityHistoryTable.changeType,
      diff: facilityHistoryTable.diff,
    })
    .from(facilityHistoryTable)
    .where(and(gt(facilityHistoryTable.changedAt, prevBuiltAt), lte(facilityHistoryTable.changedAt, upTo)));
}

/**
 * Editions whose blobs may be deleted: `published` rows that still list files
 * outside the newest `keep` PUBLISHED editions (so the latest published edition,
 * the one the download route serves, is never returned however many newer
 * editions failed), plus `failed` rows that still list files and are dated
 * before today's UTC date (today's failed row may still be reclaimed, and a
 * reclaim deletes its own prefix). `building` rows are never returned. Rows are
 * never deleted (download-log FKs); after the prefix is deleted the caller runs
 * `clearEditionFiles`, which is what stops the next run from deleting it again.
 */
export async function editionsToPrune(
  keep = EDITIONS_KEPT,
  now: Date = new Date()
): Promise<Array<{ id: string; editionDate: string }>> {
  const t = datasetEditionsTable;
  const hasFiles = sql`jsonb_array_length(${t.files}) > 0`;
  const newestPublished = getDb()
    .select({ id: t.id })
    .from(t)
    .where(eq(t.status, "published"))
    .orderBy(desc(t.editionDate))
    .limit(keep);
  const todayUtc = now.toISOString().slice(0, 10);
  return getDb()
    .select({ id: t.id, editionDate: t.editionDate })
    .from(t)
    .where(
      and(
        hasFiles,
        sql`(${and(eq(t.status, "published"), notInArray(t.id, newestPublished))} OR ${and(eq(t.status, "failed"), lt(t.editionDate, todayUtc))})`
      )
    )
    .orderBy(t.editionDate);
}

/**
 * `building` rows from a build killed at maxDuration (300 s): dated BEFORE today's
 * UTC date (claim reclaims only ever happen on the same date, so nothing else will
 * ever clean these up) and whose lease is older than `DATASET_EDITION_STALE_MS`.
 * Today's `building` row is never returned, nor is a young one from yesterday (a
 * build straddling UTC midnight). `builtAt` is returned so the caller can pass it
 * back to `failSweptBuild` as its guard.
 */
export async function staleBuildsToSweep(
  now: Date = new Date()
): Promise<Array<{ id: string; editionDate: string; builtAt: Date }>> {
  const t = datasetEditionsTable;
  const todayUtc = now.toISOString().slice(0, 10);
  const staleBefore = new Date(now.getTime() - DATASET_EDITION_STALE_MS);
  return getDb()
    .select({ id: t.id, editionDate: t.editionDate, builtAt: t.builtAt })
    .from(t)
    .where(and(eq(t.status, "building"), lt(t.editionDate, todayUtc), lt(t.builtAt, staleBefore)))
    .orderBy(t.editionDate);
}

/**
 * Marks a swept build `failed` with no files (its prefix was just deleted
 * unconditionally). Guarded on `status = 'building'` AND `built_at = builtAt` as
 * read, so a row that moved since (reclaimed, published) is left alone. Returns
 * whether it flipped.
 */
export async function failSweptBuild(id: string, builtAt: Date): Promise<boolean> {
  const rows = await getDb()
    .update(datasetEditionsTable)
    .set({ status: "failed", files: [] })
    .where(
      and(
        eq(datasetEditionsTable.id, id),
        eq(datasetEditionsTable.status, "building"),
        eq(datasetEditionsTable.builtAt, builtAt)
      )
    )
    .returning({ id: datasetEditionsTable.id });
  return rows.length > 0;
}

/** Records that an edition's blobs are gone. */
export async function clearEditionFiles(id: string): Promise<void> {
  await getDb().update(datasetEditionsTable).set({ files: [] }).where(eq(datasetEditionsTable.id, id));
}
