import { z } from "zod";
import { and, asc, desc, eq, gte, or, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  datasetAccessGrantsTable,
  datasetDownloadsTable,
  datasetEditionsTable,
  emailSendsTable,
  type DatasetCategory,
  type DatasetDownloadOutcome,
  type DatasetEditionStatus,
  type DatasetGrantStatus,
  type DatasetTier,
} from "@/lib/db/schema";
import { liveGrant, renewalPendingGrant } from "@/lib/dataset-grants";

/** What the admin UI may see of a grant. Deliberately NO token hashes, unsubscribe token or IP hash. */
export type AdminDatasetGrant = {
  id: string;
  createdAt: Date;
  email: string;
  name: string;
  organization: string | null;
  role: string | null;
  category: DatasetCategory;
  intendedUse: string;
  links: string[];
  status: DatasetGrantStatus;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  rejectionNote: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  expiresAt: Date | null;
  renewalRequestedAt: Date | null;
  lastDownloadAt: Date | null;
  downloadCount: number;
  tier: DatasetTier;
  /** Commercial only: the end of the paid period; null for free grants and before the first payment. */
  paidThrough: Date | null;
  /** Whether a Stripe subscription is linked. The id itself never leaves the server. */
  subscriptionLinked: boolean;
  /** liveGrant(now): active and expiresAt in the future. */
  live: boolean;
  /** renewalPendingGrant(): active with a renewal request outstanding (may be PAST expiry). */
  renewalPending: boolean;
};

export type AdminDatasetDownload = {
  id: string;
  createdAt: Date;
  file: string;
  outcome: DatasetDownloadOutcome;
  editionId: string | null;
};

export type AdminDatasetDownloadLog = {
  grant: Pick<AdminDatasetGrant, "id" | "name" | "email" | "status" | "downloadCount" | "lastDownloadAt">;
  downloads: AdminDatasetDownload[]; // newest first, at most ADMIN_DOWNLOAD_LOG_LIMIT
};

export const ADMIN_DOWNLOAD_LOG_LIMIT = 50;
export const ADMIN_GRANTS_LIST_LIMIT = 200;

/**
 * Explicit column projection, never `select()`: the table also holds `verifyTokenHash`, `accessTokenHash`,
 * `renewTokenHash`, `unsubscribeToken` and `submitterIpHash`, none of which may reach an admin page's props.
 * `live` and `renewalPending` evaluate the shared lifecycle definitions (lib/dataset-grants.ts) in the same
 * query; `toAdminGrant` asserts they are real booleans because Drizzle does not map a computed `sql<boolean>`.
 */
const ADMIN_GRANT_COLUMNS = (now: Date) => ({
  id: datasetAccessGrantsTable.id,
  createdAt: datasetAccessGrantsTable.createdAt,
  email: datasetAccessGrantsTable.email,
  name: datasetAccessGrantsTable.name,
  organization: datasetAccessGrantsTable.organization,
  role: datasetAccessGrantsTable.role,
  category: datasetAccessGrantsTable.category,
  intendedUse: datasetAccessGrantsTable.intendedUse,
  links: datasetAccessGrantsTable.links,
  status: datasetAccessGrantsTable.status,
  verifiedAt: datasetAccessGrantsTable.verifiedAt,
  approvedAt: datasetAccessGrantsTable.approvedAt,
  reviewedAt: datasetAccessGrantsTable.reviewedAt,
  reviewNote: datasetAccessGrantsTable.reviewNote,
  rejectionNote: datasetAccessGrantsTable.rejectionNote,
  revokedAt: datasetAccessGrantsTable.revokedAt,
  revokeReason: datasetAccessGrantsTable.revokeReason,
  expiresAt: datasetAccessGrantsTable.expiresAt,
  renewalRequestedAt: datasetAccessGrantsTable.renewalRequestedAt,
  lastDownloadAt: datasetAccessGrantsTable.lastDownloadAt,
  downloadCount: datasetAccessGrantsTable.downloadCount,
  tier: datasetAccessGrantsTable.tier,
  paidThrough: datasetAccessGrantsTable.paidThrough,
  subscriptionLinked: sql<boolean>`${datasetAccessGrantsTable.stripeSubscriptionId} is not null`,
  live: sql<boolean>`${liveGrant(now)}`,
  renewalPending: sql<boolean>`${renewalPendingGrant()}`,
});

/** A non-boolean flag (e.g. a driver returning `'t'`) must fail loudly, not silently read as `false`. */
function assertBooleanFlag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("dataset-admin: expected a boolean lifecycle flag");
  return value;
}

/** Exported for its unit test only; callers go through the list functions. */
export function toAdminGrant(row: AdminDatasetGrant): AdminDatasetGrant {
  return {
    ...row,
    live: assertBooleanFlag(row.live),
    renewalPending: assertBooleanFlag(row.renewalPending),
    subscriptionLinked: assertBooleanFlag(row.subscriptionLinked),
  };
}

/**
 * The grants awaiting an admin decision: `pending_review` rows (oldest first) followed by renewal-pending
 * active rows (oldest renewal request first). A renewal-pending grant PAST its expiry is still listed:
 * it stays approvable at any expiry (Ed, 2026-11-09). Not capped: both sets are small, human-reviewed queues.
 */
export async function listDatasetReviewQueue(now: Date = new Date()): Promise<AdminDatasetGrant[]> {
  const db = getDb();
  const isPending = sql`${datasetAccessGrantsTable.status} = 'pending_review'`;
  const rows = await db
    .select(ADMIN_GRANT_COLUMNS(now))
    .from(datasetAccessGrantsTable)
    .where(or(eq(datasetAccessGrantsTable.status, "pending_review"), renewalPendingGrant()))
    .orderBy(
      sql`case when ${isPending} then 0 else 1 end`,
      asc(sql`case when ${isPending} then ${datasetAccessGrantsTable.createdAt} else ${datasetAccessGrantsTable.renewalRequestedAt} end`),
      asc(datasetAccessGrantsTable.id)
    );
  return rows.map(toAdminGrant);
}

/** One status, newest `createdAt` first, capped at `ADMIN_GRANTS_LIST_LIMIT`. */
export async function listDatasetGrantsForAdmin(
  status: DatasetGrantStatus,
  now: Date = new Date()
): Promise<AdminDatasetGrant[]> {
  const db = getDb();
  const rows = await db
    .select(ADMIN_GRANT_COLUMNS(now))
    .from(datasetAccessGrantsTable)
    .where(eq(datasetAccessGrantsTable.status, status))
    .orderBy(desc(datasetAccessGrantsTable.createdAt), desc(datasetAccessGrantsTable.id))
    .limit(ADMIN_GRANTS_LIST_LIMIT);
  return rows.map(toAdminGrant);
}

const grantIdSchema = z.string().uuid();

/**
 * The newest `ADMIN_DOWNLOAD_LOG_LIMIT` download attempts of one grant, plus the grant's own running totals.
 * Returns null for a malformed id (checked BEFORE any DB call: Postgres would raise 22P02) or an unknown
 * grant. `ipHash` is never selected.
 */
export async function getDatasetDownloadLog(grantId: string): Promise<AdminDatasetDownloadLog | null> {
  if (typeof grantId !== "string" || !grantIdSchema.safeParse(grantId).success) return null;

  const db = getDb();
  const [grant] = await db
    .select({
      id: datasetAccessGrantsTable.id,
      name: datasetAccessGrantsTable.name,
      email: datasetAccessGrantsTable.email,
      status: datasetAccessGrantsTable.status,
      downloadCount: datasetAccessGrantsTable.downloadCount,
      lastDownloadAt: datasetAccessGrantsTable.lastDownloadAt,
    })
    .from(datasetAccessGrantsTable)
    .where(eq(datasetAccessGrantsTable.id, grantId))
    .limit(1);
  if (!grant) return null;

  const downloads = await db
    .select({
      id: datasetDownloadsTable.id,
      createdAt: datasetDownloadsTable.createdAt,
      file: datasetDownloadsTable.file,
      outcome: datasetDownloadsTable.outcome,
      editionId: datasetDownloadsTable.editionId,
    })
    .from(datasetDownloadsTable)
    .where(eq(datasetDownloadsTable.grantId, grantId))
    .orderBy(desc(datasetDownloadsTable.createdAt), desc(datasetDownloadsTable.id))
    .limit(ADMIN_DOWNLOAD_LOG_LIMIT);

  return { grant, downloads };
}

/** Minimum gap between two emailed link reissues for one grant. */
export const DATASET_REISSUE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * True iff a `dataset_link_reissued` mail was SENT for this grant within the cooldown. Only `sent` rows count,
 * so a failed or skipped send (e.g. RESEND_API_KEY missing) can be retried at once. Call it BEFORE
 * `reissueDatasetLink`: that rotates the token and kills the old link immediately, so a cap applied after
 * rotation would strand the requester with no working link. Residual: check-then-act, so two concurrent
 * reissues can both pass (admin-only; the UI disables the button while pending); the bound is on mails
 * successfully sent. A malformed id returns false before any DB call (the lib mutator rejects it anyway).
 * DB errors throw.
 */
export async function hasRecentLinkReissue(grantId: string, now: Date = new Date()): Promise<boolean> {
  if (typeof grantId !== "string" || !grantIdSchema.safeParse(grantId).success) return false;

  const db = getDb();
  const rows = await db
    .select({ id: emailSendsTable.id })
    .from(emailSendsTable)
    .where(
      and(
        eq(emailSendsTable.kind, "dataset_link_reissued"),
        eq(emailSendsTable.targetType, "dataset"),
        eq(emailSendsTable.targetId, grantId),
        eq(emailSendsTable.outcome, "sent"),
        gte(emailSendsTable.createdAt, new Date(now.getTime() - DATASET_REISSUE_COOLDOWN_MS))
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** What the admin UI may see of an edition. Deliberately NO storage pathname, file hash or headlines. */
export type AdminDatasetEdition = {
  id: string;
  editionDate: string;
  builtAt: Date;
  status: DatasetEditionStatus;
  recordCount: number | null;
  /** Set only when the weekly notice loop finished for this edition; null while it is cut short or not yet run. */
  noticeSentAt: Date | null;
  files: { name: string; bytes: number }[];
  /** Null when the edition has no (or a malformed) changelog summary. */
  changes: { added: number; updated: number; removed: number } | null;
};

export const ADMIN_EDITIONS_LIMIT = 8;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** `changelogSummary` is opaque jsonb: take the three counts if all are present and sane, nothing else. */
function toChangeCounts(summary: unknown): AdminDatasetEdition["changes"] {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return null;
  const { added, updated, removed } = summary as Record<string, unknown>;
  if (!isCount(added) || !isCount(updated) || !isCount(removed)) return null;
  return { added, updated, removed };
}

/** `files` is jsonb typed by `$type` only: keep well-formed entries, and only their name and size. */
function toFileSizes(files: unknown): AdminDatasetEdition["files"] {
  if (!Array.isArray(files)) return [];
  const sizes: AdminDatasetEdition["files"] = [];
  for (const entry of files as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, bytes } = entry as Record<string, unknown>;
    if (typeof name === "string" && isCount(bytes)) sizes.push({ name, bytes });
  }
  return sizes;
}

/**
 * The newest editions by `editionDate`, for the admin "Editions" panel. Explicit projection: `files` carries
 * the private storage pathname and sha256 of each file, so it is mapped down to name and size here and the
 * raw jsonb never leaves this function. Every status is listed, so a failed or stuck build is visible.
 */
export async function listRecentEditions(limit: number = ADMIN_EDITIONS_LIMIT): Promise<AdminDatasetEdition[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: datasetEditionsTable.id,
      editionDate: datasetEditionsTable.editionDate,
      builtAt: datasetEditionsTable.builtAt,
      status: datasetEditionsTable.status,
      recordCount: datasetEditionsTable.recordCount,
      noticeSentAt: datasetEditionsTable.noticeSentAt,
      files: datasetEditionsTable.files,
      changelogSummary: datasetEditionsTable.changelogSummary,
    })
    .from(datasetEditionsTable)
    .orderBy(desc(datasetEditionsTable.editionDate))
    .limit(limit);
  return rows.map(({ files, changelogSummary, ...row }) => ({
    ...row,
    files: toFileSizes(files),
    changes: toChangeCounts(changelogSummary),
  }));
}
