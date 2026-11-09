import { buildChangelog } from "@/lib/dataset-changelog";
import { facilitiesToCsv } from "@/lib/dataset-csv";
import { DatasetBlobError, DATASET_EDITION_FILES, deleteEditionPrefix, putEditionFile } from "@/lib/dataset-blob";
import {
  claimEdition,
  clearEditionFiles,
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

export type EditionBuildResult =
  | { outcome: "published"; editionId: string; editionDate: string; recordCount: number }
  // "inProgress" also covers "a failed build was retried within the last 5 minutes" (retry cooldown).
  | { outcome: "alreadyPublished" | "inProgress"; editionId: string; editionDate: string }
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

export async function buildEdition(opts: BuildEditionOptions = {}): Promise<EditionBuildResult> {
  const now = opts.now ?? new Date();
  const editionDate = now.toISOString().slice(0, 10);
  let step = "claim";
  let claimed: { id: string; builtAt: Date } | null = null;
  // Declared out here so a failure mid-upload can record what already reached Blob.
  const files: DatasetEditionFile[] = [];

  try {
    const claim = await claimEdition(editionDate, now, { ignoreRetryCooldown: opts.ignoreRetryCooldown });
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
      changelogSummary: summary,
    });
    if (!published) {
      logFailure("publish", "claim_lost");
      return { outcome: "failed", editionId: claim.id, editionDate, code: "claim_lost" };
    }

    // U8: weekly notices and renewal reminders go here, after publish.
    await afterPublish(now);
    return { outcome: "published", editionId: claim.id, editionDate, recordCount };
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

/**
 * Post-publish housekeeping. Nothing here can un-publish the edition, so every step is contained.
 * It runs only after a SUCCESSFUL publish: a build killed at maxDuration leaves a `building` row
 * (shown as "building" in /admin/access) and orphan blobs until the next successful publish,
 * whose sweep below cleans them up.
 */
async function afterPublish(now: Date): Promise<void> {
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
}
