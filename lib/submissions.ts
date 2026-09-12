import { z } from "zod";
import { eq, desc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { submissionsTable, type SubmissionRow } from "@/lib/db/schema";
import { sendSubmissionReviewedEmail } from "@/lib/email";
import {
  createFacility,
  updateFacility,
  writeStatusUpdate,
  writeEnrichmentUpdate,
  type WriteResult,
} from "@/lib/facility-write";
import { notifySubscribersOfChange } from "@/lib/notify";
import { checkSubmissionNotifySendCap, recordSubmissionNotifySend } from "@/lib/rate-limit";
import type { Facility } from "@/lib/schema";
import {
  deleteSubmissionNotifyRequest,
  getSubmissionNotifyRequest,
  submissionNotifyEnabled,
} from "@/lib/submission-notify";

const provenanceSchema = z.object({
  sources: z.array(z.string()).min(1), // ≥1 source — nothing stages uncited
  confidence: z.string().optional(),
  discoveredBy: z.string().min(1), // who/what proposed it (e.g. "data-wave:run-123" or "manual")
  runId: z.string().optional(),
  discoveredAt: z.string().optional(),
  note: z.string().optional(),
  submitterIpHash: z.string().optional(),
  // Enforce the display-handle charset at the persistence boundary too, not
  // just at the public sanitizeAttribution() call site — so the admin-token
  // POST /api/submissions path and the discovery pipeline can't write an
  // unsanitized handle. Mirrors the allowlist in lib/contribute.ts.
  attribution: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9 _.-]+$/, "attribution may contain only letters, numbers, spaces, and . _ -")
    .optional(),
});

/**
 * Envelope-only validation at submit time — this is a human-in-the-loop
 * queue, so the pipeline may stage imperfect candidates. Full `facilitySchema`
 * validation happens at approve time via the write primitives.
 */
export const submissionInputSchema = z
  .object({
    kind: z.enum(["create", "update", "status_update", "enrichment_update"]),
    targetFacilityId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()), // full doc for create, partial patch/intent for update/status_update/enrichment_update
    provenance: provenanceSchema,
  })
  .refine((s) => s.kind === "create" || !!s.targetFacilityId, {
    message: "targetFacilityId is required for update, status_update, and enrichment_update submissions",
    path: ["targetFacilityId"],
  });

export type SubmissionInput = z.infer<typeof submissionInputSchema>;

export type SubmissionResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string; issues?: unknown };

export type SubmissionActionResult =
  | { ok: true; submission: SubmissionRow; facility: Facility; historyRecorded?: boolean }
  | { ok: false; status: number; error: string; issues?: unknown };

export type SubmissionRejectResult =
  | { ok: true; submission: SubmissionRow }
  | { ok: false; status: number; error: string };

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;

/** Validates the envelope and inserts a new `pending` submission row. */
export async function createSubmission(input: unknown): Promise<SubmissionResult> {
  const parsed = submissionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid submission", issues: parsed.error.issues };
  }
  const { kind, targetFacilityId, payload, provenance } = parsed.data;

  const db = getDb();
  const [row] = await db
    .insert(submissionsTable)
    .values({ kind, targetFacilityId, payload, provenance })
    .returning({ id: submissionsTable.id });

  return { ok: true, id: row.id };
}

/** Lists submissions, optionally filtered by status, newest first. */
export async function listSubmissions(status?: string): Promise<SubmissionRow[]> {
  const db = getDb();
  const query = db.select().from(submissionsTable);

  if (status && (REVIEW_STATUSES as readonly string[]).includes(status)) {
    return query.where(eq(submissionsTable.status, status)).orderBy(desc(submissionsTable.createdAt));
  }
  return query.orderBy(desc(submissionsTable.createdAt));
}

/**
 * Promotes a pending submission to a live facility via the write
 * primitives, then marks the submission `approved`. If the primitive rejects
 * (e.g. schema-invalid payload), the submission is left `pending` so it can
 * be fixed and retried rather than silently lost.
 */
export async function approveSubmission(
  id: string,
  reviewNote?: string
): Promise<SubmissionActionResult> {
  const db = getDb();
  const rows = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Submission not found" };
  }
  if (row.status !== "pending") {
    return { ok: false, status: 409, error: `Submission already ${row.status}` };
  }

  // `source: id` attributes the resulting facility_history row to this
  // submission rather than the "admin-direct" default, so promoted-submission
  // history correctly shows where the change came from.
  const writeResult: WriteResult =
    row.kind === "create"
      ? await createFacility(row.payload, id)
      : row.kind === "status_update"
        ? await writeStatusUpdate(row.targetFacilityId!, row.payload, id)
        : row.kind === "enrichment_update"
          ? await writeEnrichmentUpdate(row.targetFacilityId!, row.payload, id)
          : await updateFacility(row.targetFacilityId!, row.payload, id);

  if (!writeResult.ok) {
    return writeResult;
  }

  const [updated] = await db
    .update(submissionsTable)
    .set({ status: "approved", reviewedAt: new Date(), reviewNote: reviewNote ?? null })
    .where(eq(submissionsTable.id, id))
    .returning();

  // Best-effort — neither notifySubscribersOfChange nor
  // notifySubmitterOfReview throws (each handles/logs its own errors
  // internally), but this extra try/catch is belt-and-suspenders: a
  // notification failure must never turn a successful approval into an
  // error response.
  try {
    const changeLabel =
      row.kind === "create"
        ? "added to the atlas"
        : row.kind === "status_update"
          ? "status updated"
          : row.kind === "enrichment_update"
            ? "details enriched"
            : "record updated";
    await notifySubscribersOfChange(writeResult.facility, changeLabel);
    await notifySubmitterOfReview(id, "approved", {
      name: writeResult.facility.name,
      id: writeResult.facility.id,
    });
  } catch (err) {
    console.error("subscriber notification failed", err);
  }

  return {
    ok: true,
    submission: updated,
    facility: writeResult.facility,
    historyRecorded: writeResult.historyRecorded,
  };
}

/** Rejects a pending submission with a required, non-empty reason. */
export async function rejectSubmission(
  id: string,
  reason: string
): Promise<SubmissionRejectResult> {
  if (!reason || !reason.trim()) {
    return { ok: false, status: 400, error: "reason is required" };
  }

  const db = getDb();
  const rows = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Submission not found" };
  }
  if (row.status !== "pending") {
    return { ok: false, status: 409, error: `Submission already ${row.status}` };
  }

  const [updated] = await db
    .update(submissionsTable)
    .set({ status: "rejected", reviewedAt: new Date(), reviewNote: reason })
    .where(eq(submissionsTable.id, id))
    .returning();

  // Best-effort — matches approveSubmission's identical discipline above:
  // notifySubmitterOfReview never throws (it handles/logs its own errors
  // internally), but this extra try/catch is belt-and-suspenders so a
  // notification failure never turns a successful rejection into an error
  // response.
  try {
    await notifySubmitterOfReview(id, "rejected", facilityLabelForRejection(row));
  } catch (err) {
    console.error("submitter notification failed", errorCode(err));
  }

  return { ok: true, submission: updated };
}

/**
 * Best-effort "email me when reviewed" send + cleanup, called from both
 * approveSubmission and rejectSubmission after the status update. This file
 * owns the send/delete DECISION; lib/submission-notify.ts stays deliberately
 * CRUD-only (see its module doc comment) and exposes just the flag check
 * plus get/delete primitives.
 *
 * If no notify request exists for this submission — the overwhelmingly
 * common case, since nobody asked — this is a silent no-op: no send, no
 * delete, no log noise.
 *
 * When a request DOES exist, the row is deleted unconditionally once this
 * function reaches that point: whether the flag is on or off, whether the
 * address is over its per-address send cap (`checkSubmissionNotifySendCap`,
 * lib/rate-limit.ts), and whether or not the send succeeded. A skipped or
 * failed send means the contributor is never told — that is the CHOSEN
 * tradeoff over retaining an address that has no further scheduled use (this
 * is a one-shot request by design; see lib/submission-notify.ts's module doc
 * comment). Deliberately NOT the intuitive pairing: "skip the send" does NOT
 * mean "keep the row for a later retry" — retaining it would defeat the
 * one-shot design and hand the address a scheduled future retry it never
 * asked for. `sendSubmissionReviewedEmail` itself never throws (it bottoms
 * out in lib/email.ts's `sendViaResend`, which returns `{sent:false}` rather
 * than throwing on a Resend error) — the try/catch around it here is
 * belt-and-suspenders, since "the send failed" is really signaled by a falsy
 * `sent`, not an exception; deletion does not depend on that value either
 * way.
 *
 * SEND-CAP GATING (closes a HIGH security finding — see
 * `submissionNotifySendsTable`'s doc comment in lib/db/schema.ts for the
 * attack this closes): the attempt is recorded via
 * `recordSubmissionNotifySend` BEFORE `sendSubmissionReviewedEmail` is even
 * attempted, and the record must itself succeed before the send is
 * attempted — a failing send, or a failing record, must still cost the
 * target address's budget rather than let it be retried for free (mirrors PR
 * #288's "attempts, not outcomes" fix for `subscribe_attempts`). Both the cap
 * check and the record step fail CLOSED (skip the send) on error rather than
 * open, because proceeding to send on either failure is exactly the
 * unrecorded-mail path this fix exists to close.
 *
 * Never lets anything throw out of the review path, and never logs a caught
 * error object: every statement below — the lookup, the send-cap check, the
 * send-record, the send, and the delete — has the submitter's email address
 * (or its salted hash) bound into it, and DrizzleQueryError.message embeds
 * bound params (see lib/submission-notify.ts's module doc comment for the
 * prior incident this mirrors with an IP hash — and note it was not only the
 * one statement expected to fail that leaked; every one is individually
 * guarded here for that reason). The over-cap path in particular logs
 * nothing at all — "over cap" is not an error, and it must not produce a log
 * line naming an address.
 */
async function notifySubmitterOfReview(
  submissionId: string,
  decision: "approved" | "rejected",
  facility?: { name: string; id?: string }
): Promise<void> {
  let notifyRequest: { email: string } | null;
  try {
    notifyRequest = await getSubmissionNotifyRequest(submissionId);
  } catch (err) {
    console.error("notifySubmitterOfReview: lookup failed", errorCode(err));
    return;
  }
  if (!notifyRequest) return;

  if (submissionNotifyEnabled()) {
    let underSendCap = false;
    try {
      underSendCap = (await checkSubmissionNotifySendCap(notifyRequest.email)).ok;
    } catch (err) {
      console.error("notifySubmitterOfReview: send-cap check failed", errorCode(err));
      // Fail closed — an unverifiable cap must not be treated as "under".
    }

    if (underSendCap) {
      let recorded = false;
      try {
        await recordSubmissionNotifySend(notifyRequest.email);
        recorded = true;
      } catch (err) {
        console.error("notifySubmitterOfReview: record send failed", errorCode(err));
        // Fail closed — an unrecorded attempt must not be allowed to send;
        // that is exactly the unrecorded-mail path this fix exists to close.
      }

      if (recorded) {
        try {
          await sendSubmissionReviewedEmail({
            email: notifyRequest.email,
            decision,
            facilityName: facility?.name ?? "your submission",
            // The rejection path structurally carries no `id` — see
            // facilityLabelForRejection — so this ternary can't be changed to
            // leak a bogus /facilities/<submission-uuid> link even if the
            // `decision === "approved"` guard were ever removed.
            facilitySlug: decision === "approved" ? facility?.id : undefined,
          });
        } catch (err) {
          console.error("notifySubmitterOfReview: send failed", errorCode(err));
        }
      }
    }
    // Over cap: no send is attempted, and deliberately no log line — see
    // this function's doc comment above.
  }

  // Unconditional — see "SEND-CAP GATING" above for why "skip the send" must
  // never imply "keep the row."
  try {
    await deleteSubmissionNotifyRequest(submissionId);
  } catch (err) {
    console.error("notifySubmitterOfReview: delete failed", errorCode(err));
  }
}

/**
 * rejectSubmission never runs a write primitive, so — unlike
 * approveSubmission's `writeResult.facility` — there is no live Facility to
 * read a name from. For a `create`-kind rejection, the submitter's own
 * proposed `payload.name` is an honest label: it's literally what they
 * typed, not something invented. For the update/status_update/
 * enrichment_update kinds there is only `targetFacilityId` (an id, not a
 * name) to go on, and stitching a display name out of an id would be a
 * fabricated label rather than a derived one — so those kinds return
 * undefined here, and notifySubmitterOfReview's `facilityName ?? "your
 * submission"` fallback supplies the neutral phrase instead.
 */
function facilityLabelForRejection(row: SubmissionRow): { name: string } | undefined {
  if (row.kind !== "create") return undefined;
  const payload = row.payload as Record<string, unknown> | null;
  const name = payload && typeof payload.name === "string" ? payload.name.trim() : "";
  return name ? { name } : undefined;
}

/**
 * Never logs the caught error object itself — see notifySubmitterOfReview's
 * doc comment above. DrizzleQueryError wraps the driver error and its own
 * `.message` is `Failed query: ${query}\nparams: ${params}`; the real `code`
 * lives one level down on `.cause` for some drivers, so both are checked.
 * Same reasoning as lib/submission-notify.ts's `isUniqueViolation`, but this
 * returns the code for logging rather than a boolean.
 */
function errorCode(err: unknown): unknown {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) return code;
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return (cause as { code?: unknown }).code;
    }
  }
  return "unknown";
}
