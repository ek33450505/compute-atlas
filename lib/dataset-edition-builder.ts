import { buildChangelog } from "@/lib/dataset-changelog";
import { coverageMap, computeCoverage, withDeltas } from "@/lib/dataset-coverage";
import { facilitiesToCsv } from "@/lib/dataset-csv";
import { DatasetBlobError, DATASET_EDITION_FILES, deleteEditionPrefix, putEditionFile } from "@/lib/dataset-blob";
import {
  claimEdition,
  clearEditionFiles,
  editionNeedsNotices,
  EDITIONS_KEPT,
  editionsToPrune,
  failEdition,
  latestPublishedEdition,
  failSweptBuild,
  loadHistorySince,
  publishEdition,
  staleBuildsToSweep,
} from "@/lib/dataset-editions";
import { expireDueGrants } from "@/lib/dataset-grants";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { DATASET_NOTICE_DEADLINE_MS, makePacer, sendEditionNotices, sendRenewalReminders } from "@/lib/dataset-notices";
import { buildReadme } from "@/lib/dataset-readme";
import { buildSnapshotBodies, DEFAULT_FLOORS, neonSource, type SnapshotFloors, type SnapshotSource } from "@/lib/dataset-snapshot";
import type { DatasetEditionFile } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";

/**
 * Orchestrates one weekly dataset edition: claim the date, snapshot Neon, build
 * the five files, upload them, and only then publish the row. Called by the
 * weekly cron and by the admin "Build now"; neither owns any of this logic.
 *
 * Never throws: every failure becomes `{ outcome: "failed", code }` with one log
 * line `dataset edition: <step> failed (code: …)`. The code is a fixed token
 * (`DatasetBlobError.code`, `below_floor`, `claim_lost`, a SQLSTATE or
 * "unknown"); no body, email, token or error text is ever logged. A failed or
 * abandoned build never un-publishes anything: the previous edition keeps
 * serving because only `publishEdition` flips a row to `published`.
 */

export { EDITIONS_KEPT };

/**
 * How the weekly notice pass ended, so a cut-short pass is visible to the cron log and the admin panel. Absent
 * when no pass ran (sharing disabled, or an `inProgress` claim). `complete: false` also covers a budget spent
 * before the pass began and a pass that threw; a same-day "Build now" resumes it.
 */
export interface NoticesStatus {
  complete: boolean;
  sent: number;
}

export type EditionBuildResult =
  | { outcome: "published"; editionId: string; editionDate: string; recordCount: number; notices?: NoticesStatus }
  // "inProgress" also covers "a failed build was retried within the last 5 minutes" (retry cooldown).
  | { outcome: "alreadyPublished" | "inProgress"; editionId: string; editionDate: string; notices?: NoticesStatus }
  | { outcome: "failed"; editionId?: string; editionDate: string; code: string };

export interface BuildEditionOptions {
  now?: Date;
  source?: SnapshotSource;
  floors?: SnapshotFloors;
  /** Cron only: a recently failed build is retried at once instead of waiting out the admin-click cooldown. */
  ignoreRetryCooldown?: boolean;
}

/** The fixed code for a caught error. Never the message: it can embed bound params or store URLs. */
function failureCode(err: unknown): string {
  if (err instanceof DatasetBlobError) return err.code;
  // buildSnapshotBodies' floor refusals are plain Errors with this fixed prefix.
  if (err instanceof Error && err.message.startsWith("export refused:")) return "below_floor";
  return redactedErrorCode(err);
}

function logFailure(step: string, code: string): void {
  console.error(`dataset edition: ${step} failed (code: ${code})`);
}

/**
 * True when the Blob SDK has a credential source. Resolution order in @vercel/blob 2.8.2
 * (node_modules/@vercel/blob/dist/chunk-XKVPKJPO.js:160-206): an explicit `token` option (never
 * passed by lib/dataset-blob.ts), then an OIDC token (`VERCEL_OIDC_TOKEN` or the request-context
 * header) paired with env `BLOB_STORE_ID`, then env `BLOB_READ_WRITE_TOKEN`. The OIDC token itself
 * is deliberately NOT inspected: on Vercel it can come from the request context, so an env check
 * could false-fail a working deployment. `BLOB_STORE_ID` is the env half the SDK needs for OIDC.
 * Values are only tested for presence, never logged.
 */
function blobConfigured(): boolean {
  return (
    (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim() !== "" || (process.env.BLOB_STORE_ID ?? "").trim() !== ""
  );
}

export async function buildEdition(opts: BuildEditionOptions = {}): Promise<EditionBuildResult> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const editionDate = now.toISOString().slice(0, 10);
  let step = "claim";
  let claimed: { id: string; builtAt: Date } | null = null;
  // Declared out here so a failure mid-upload can record what already reached Blob.
  const files: DatasetEditionFile[] = [];

  // Before the claim and the Neon read (the main cost driver): a deployment with no Blob
  // credentials would otherwise burn a full snapshot and report a vague blob_put_failed.
  if (!blobConfigured()) {
    console.error("dataset edition: blob store not configured (code: blob_not_configured)");
    return { outcome: "failed", editionDate, code: "blob_not_configured" };
  }

  try {
    const claim = await claimEdition(editionDate, now, { ignoreRetryCooldown: opts.ignoreRetryCooldown });
    if (claim.kind === "alreadyPublished") {
      // A same-day rerun (cron or admin "Build now") finishes a send pass the deadline cut short.
      const notices = await resumeNotices(claim.id, startedAt);
      return { outcome: claim.kind, editionId: claim.id, editionDate, ...(notices && { notices }) };
    }
    if (claim.kind !== "claimed") return { outcome: claim.kind, editionId: claim.id, editionDate };
    claimed = { id: claim.id, builtAt: now };

    if (claim.reclaimed) {
      // A dead build may have left partial uploads under this date.
      step = "reclaim_cleanup";
      await deleteEditionPrefix(editionDate);
    }

    step = "snapshot";
    const prev = await latestPublishedEdition();
    // Taken BEFORE the reads: history written after this instant belongs to the next edition's window.
    const readAt = new Date();
    const snapshot = await buildSnapshotBodies(opts.source ?? neonSource(), {
      floors: opts.floors ?? DEFAULT_FLOORS,
      readAt,
    });
    const bodyOf = (name: string): string => {
      const found = snapshot.bodies.find(([n]) => n === name);
      if (!found) throw new Error("snapshot body missing");
      return found[1];
    };

    step = "changelog";
    const prevBuiltAt = prev?.builtAt ?? null;
    const history = await loadHistorySince(prevBuiltAt, readAt);
    const { changelog, summary } = buildChangelog({
      history,
      facilities: snapshot.facilities,
      prevBuiltAt,
      builtAt: readAt,
    });
    const recordCount = snapshot.facilities.length;
    let siting: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(bodyOf("siting-context.json"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) siting = parsed as Record<string, unknown>;
    } catch (err) {
      console.error(`dataset edition: siting parse failed (code: ${redactedErrorCode(err)})`);
    }
    const coverageRows = computeCoverage(snapshot.facilities, siting);
    const prevSummary: unknown = prev?.changelogSummary;
    const prevCoverage =
      typeof prevSummary === "object" && prevSummary !== null ? (prevSummary as Record<string, unknown>).coverage : undefined;
    const fileBodies: Record<(typeof DATASET_EDITION_FILES)[number], string> = {
      "facilities.json": bodyOf("facilities.json"),
      "facilities.csv": facilitiesToCsv(snapshot.facilities),
      "siting-context.json": bodyOf("siting-context.json"),
      "changelog.json": JSON.stringify(changelog, null, 2) + "\n",
      "README.txt": buildReadme({
        editionDate,
        editionId: claim.id,
        recordCount,
        initial: changelog.initial,
        summary,
        coverage: withDeltas(coverageRows, prevCoverage),
      }),
    };

    step = "upload";
    for (const name of DATASET_EDITION_FILES) {
      const { pathname, bytes, sha256 } = await putEditionFile(editionDate, name, fileBodies[name]);
      files.push({ name, pathname, bytes, sha256 });
    }

    // Only after every upload succeeded: a partial set must never become a published edition.
    step = "publish";
    const published = await publishEdition(claim.id, claimed.builtAt, {
      readAt,
      recordCount,
      files,
      changelogSummary: { ...summary, coverage: coverageMap(coverageRows) },
    });
    if (!published) {
      logFailure("publish", "claim_lost");
      return { outcome: "failed", editionId: claim.id, editionDate, code: "claim_lost" };
    }

    const notices = await afterPublish(now, claim.id, startedAt);
    return { outcome: "published", editionId: claim.id, editionDate, recordCount, ...(notices && { notices }) };
  } catch (err) {
    const code = failureCode(err);
    logFailure(step, code);
    if (claimed) {
      try {
        await failEdition(claimed.id, claimed.builtAt, files);
      } catch (failErr) {
        logFailure("mark_failed", failureCode(failErr));
      }
    }
    return { outcome: "failed", editionId: claimed?.id, editionDate, code };
  }
}

/** Notices and reminders share this much of the function's 300 s, counted from the start of the build. */
const NOTICE_BUDGET_MS = DATASET_NOTICE_DEADLINE_MS;

/**
 * The renewal reminders (a small set, so they cannot starve), then the weekly notice, each given what is left of
 * the budget. A spent budget skips the step; a cut-short notice pass is finished by a same-day rerun, see
 * `resumeNotices`. One pacer serves both passes so the API rate limit holds across the seam between them.
 * Contained: neither can change the build outcome, so a throw (they are built not to) is one
 * `reminders failed` / `notices failed` line.
 *
 * Admin "Build now" runs whether or not DATASET_SHARING_ENABLED is set (to pre-build an edition), but mail must
 * not go out while the flag is off: both passes are skipped then. Returns how the notice pass ended, or
 * undefined when it was not attempted for that reason.
 */
async function sendScheduledMail(editionId: string, startedAt: number): Promise<NoticesStatus | undefined> {
  if (!isDatasetSharingEnabled()) {
    console.info("dataset edition: mail skipped, sharing is disabled");
    return undefined;
  }
  const remaining = () => NOTICE_BUDGET_MS - (Date.now() - startedAt);
  const pacer = makePacer();

  try {
    if (remaining() > 0) await sendRenewalReminders({ deadlineMs: remaining(), pacer });
  } catch (err) {
    logFailure("reminders", failureCode(err));
  }

  const notices: NoticesStatus = { complete: false, sent: 0 };
  try {
    if (remaining() > 0) {
      const res = await sendEditionNotices(editionId, { deadlineMs: remaining(), pacer });
      notices.complete = res.complete;
      notices.sent = res.sent;
    }
  } catch (err) {
    logFailure("notices", failureCode(err));
  }
  return notices;
}

/** On `alreadyPublished`: only the newest published edition with `notice_sent_at` still null is worth a pass. */
async function resumeNotices(editionId: string, startedAt: number): Promise<NoticesStatus | undefined> {
  try {
    if (!(await editionNeedsNotices(editionId))) return undefined;
  } catch (err) {
    logFailure("notices", failureCode(err));
    return undefined;
  }
  return sendScheduledMail(editionId, startedAt);
}

/**
 * Post-publish work, in order: housekeeping, then the renewal reminders and weekly notice. Housekeeping is fast DB
 * work plus a few Blob prefix deletes, so it goes first: the mail passes can run to their 240 s budget (about 262 s
 * with the in-flight overrun, against a 300 s maxDuration) and must not starve it. Nothing here can un-publish
 * the edition, so every step is contained.
 * It runs only after a SUCCESSFUL publish: a build killed at maxDuration leaves a `building` row
 * (shown as "building" in /admin/access) and orphan blobs until the next successful publish,
 * whose sweep below cleans them up.
 */
async function afterPublish(now: Date, editionId: string, startedAt: number): Promise<NoticesStatus | undefined> {
  try {
    await expireDueGrants(now);
  } catch (err) {
    logFailure("expire_grants", failureCode(err));
  }

  try {
    const stale = await editionsToPrune(EDITIONS_KEPT, now);
    for (const { id, editionDate } of stale) {
      try {
        await deleteEditionPrefix(editionDate);
        await clearEditionFiles(id);
      } catch (err) {
        logFailure("prune", failureCode(err));
      }
    }
  } catch (err) {
    logFailure("prune", failureCode(err));
  }

  // Builds killed at maxDuration leave a `building` row plus blobs that no same-date reclaim will ever see.
  try {
    const dead = await staleBuildsToSweep(now);
    for (const { id, editionDate, builtAt } of dead) {
      try {
        // These rows list no files (files is [] while building), so the prefix is deleted unconditionally.
        await deleteEditionPrefix(editionDate);
        await failSweptBuild(id, builtAt);
      } catch (err) {
        logFailure("sweep", failureCode(err));
      }
    }
  } catch (err) {
    logFailure("sweep", failureCode(err));
  }

  return sendScheduledMail(editionId, startedAt);
}
