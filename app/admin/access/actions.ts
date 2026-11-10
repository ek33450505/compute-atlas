"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import {
  approveDatasetGrant,
  extendDatasetGrant,
  redirectDatasetGrantToPaid,
  reissueDatasetLink,
  rejectDatasetGrant,
  revokeDatasetGrant,
} from "@/lib/dataset-grants";
import { cancelSubscriptionForRevokedGrant } from "@/lib/commercial-revoke";
import { hasRecentLinkReissue } from "@/lib/dataset-admin";
import { buildEdition, type EditionBuildResult } from "@/lib/dataset-edition-builder";
import { deliverDatasetReviewMail } from "@/lib/dataset-mail";
import { redactedErrorCode } from "@/lib/db-error";
import type { GateDisposition } from "@/lib/email-gate";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so every action here re-verifies the admin session cookie
 * before doing anything. Mirrors app/admin/contact/actions.ts.
 *
 * These are the maintainer's review controls for dataset-access grants
 * (`/admin/access`). Each is a thin wrapper: it coerces untrusted client input,
 * calls the matching `lib/dataset-grants.ts` function (which validates the id
 * and does an atomic, status-guarded UPDATE), then delivers any review mail.
 *
 * Two things the wrappers guarantee:
 * - The raw access token exists only inside the mail intent handed to
 *   `deliverDatasetReviewMail`. Every returned object is built from scratch,
 *   never spread from the lib result, so the token cannot reach the client or a
 *   log. Errors log a SQLSTATE only (Drizzle messages embed bound params).
 * - Mail is delivered synchronously so the admin sees the outcome. An approval
 *   whose mail is not `sent` leaves an ACTIVE grant whose requester has no link;
 *   that is why the disposition is returned, so the admin can reissue the link.
 *
 * Revoke, extend and a renewal approval send no mail (Ed, 2026-11-09: there is no
 * revoke notice).
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

export type DatasetAdminActionError = { ok: false; error: string };

const NOT_ELIGIBLE_ERROR =
  "This grant is no longer in a state this action applies to. The list has been refreshed; check it before retrying.";
const REISSUE_COOLDOWN_ERROR =
  "A new link was emailed to this requester less than 10 minutes ago. Wait before sending another.";
const UPDATE_FAILED_ERROR = "Could not update the grant. Try again.";
const BUILD_FAILED_ERROR = "The edition build failed.";

const notEligible = (): DatasetAdminActionError => ({ ok: false, error: NOT_ELIGIBLE_ERROR });
const updateFailed = (): DatasetAdminActionError => ({ ok: false, error: UPDATE_FAILED_ERROR });

/** A server action receives arbitrary client values: anything that is not a string is dropped. */
const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Code only: a Drizzle error message embeds bound params (an email, a token hash). */
const logFailure = (action: string, err: unknown): void => {
  console.error(`${action} failed (sqlstate: ${redactedErrorCode(err)})`);
};

/** Approves a pending request (mails the access link) or an outstanding renewal request (no mail). */
export async function approveDatasetGrantAction(
  id: string,
  reviewNote?: string
): Promise<
  | { ok: true; kind: "approved"; mail: GateDisposition }
  | { ok: true; kind: "renewed" }
  | DatasetAdminActionError
> {
  await assertAdminSession();
  if (typeof id !== "string") return notEligible();

  let result;
  try {
    result = await approveDatasetGrant(id, { reviewNote: optionalString(reviewNote) });
  } catch (err) {
    logFailure("approveDatasetGrantAction", err);
    return updateFailed();
  }
  if (!result.ok) return notEligible();

  if (result.kind === "renewed") {
    revalidatePath("/admin/access");
    return { ok: true, kind: "renewed" };
  }
  const gate = await deliverDatasetReviewMail(result.mail);
  revalidatePath("/admin/access");
  return { ok: true, kind: "approved", mail: gate.disposition };
}

/** Rejects a pending request and mails the requester the (optional) public rejection note. */
export async function rejectDatasetGrantAction(
  id: string,
  notes?: { reviewNote?: string; rejectionNote?: string }
): Promise<{ ok: true; mail: GateDisposition } | DatasetAdminActionError> {
  await assertAdminSession();
  if (typeof id !== "string") return notEligible();
  const given = typeof notes === "object" && notes !== null ? notes : {};

  let result;
  try {
    result = await rejectDatasetGrant(id, {
      reviewNote: optionalString(given.reviewNote),
      rejectionNote: optionalString(given.rejectionNote),
    });
  } catch (err) {
    logFailure("rejectDatasetGrantAction", err);
    return updateFailed();
  }
  if (!result.ok) return notEligible();

  const gate = await deliverDatasetReviewMail(result.mail);
  revalidatePath("/admin/access");
  return { ok: true, mail: gate.disposition };
}

/** Rejects a pending commercial request and mails the requester the link to the paid subscription. */
export async function redirectDatasetGrantToPaidAction(
  id: string
): Promise<{ ok: true; mail: GateDisposition } | DatasetAdminActionError> {
  await assertAdminSession();
  if (typeof id !== "string") return notEligible();

  let result;
  try {
    result = await redirectDatasetGrantToPaid(id);
  } catch (err) {
    logFailure("redirectDatasetGrantToPaidAction", err);
    return updateFailed();
  }
  if (!result.ok) return notEligible();

  const gate = await deliverDatasetReviewMail(result.mail);
  revalidatePath("/admin/access");
  return { ok: true, mail: gate.disposition };
}

/**
 * Revokes an active grant. Sends no mail. For a commercial grant the DB revoke comes FIRST, then the Stripe
 * subscription is cancelled (never refunded), so a failed cancel is still covered by the webhook backstop.
 * `subscription` is present only when a Stripe cancel was attempted (or, "unknown", when the grant could not be
 * read back to decide): a free grant returns plain `{ ok: true }`.
 */
export async function revokeDatasetGrantAction(
  id: string,
  reason?: string
): Promise<{ ok: true; subscription?: "cancelled" | "failed" | "unknown" } | DatasetAdminActionError> {
  await assertAdminSession();
  if (typeof id !== "string") return notEligible();

  let result;
  try {
    result = await revokeDatasetGrant(id, { reason: optionalString(reason) });
  } catch (err) {
    logFailure("revokeDatasetGrantAction", err);
    return updateFailed();
  }
  if (!result.ok) return notEligible();

  const cancel = await cancelSubscriptionForRevokedGrant(id);
  revalidatePath("/admin/access");
  if (cancel.cancelled) return { ok: true, subscription: "cancelled" };
  if (cancel.reason === "stripe_error") return { ok: true, subscription: "failed" };
  if (cancel.reason === "lookup_failed") return { ok: true, subscription: "unknown" };
  return { ok: true };
}

/**
 * Rotates the token of an active grant and mails the new link. Refused for 10 minutes after a reissue mail
 * was SENT for the grant. The check runs BEFORE rotation: capping afterwards would kill the old link and
 * send no new one. Residual: check-then-act, so two concurrent reissues can both pass (admin-only; the UI
 * disables the button while pending); the bound is on mails successfully sent.
 */
export async function reissueDatasetLinkAction(
  id: string
): Promise<{ ok: true; mail: GateDisposition } | DatasetAdminActionError> {
  await assertAdminSession();
  if (typeof id !== "string") return notEligible();

  let result;
  try {
    if (await hasRecentLinkReissue(id)) return { ok: false, error: REISSUE_COOLDOWN_ERROR };
    result = await reissueDatasetLink(id);
  } catch (err) {
    logFailure("reissueDatasetLinkAction", err);
    return updateFailed();
  }
  if (!result.ok) return notEligible();

  const gate = await deliverDatasetReviewMail(result.mail);
  revalidatePath("/admin/access");
  return { ok: true, mail: gate.disposition };
}

/** Starts a fresh term for an active grant. Sends no mail. */
export async function extendDatasetGrantAction(
  id: string
): Promise<{ ok: true } | DatasetAdminActionError> {
  await assertAdminSession();
  if (typeof id !== "string") return notEligible();

  let result;
  try {
    result = await extendDatasetGrant(id);
  } catch (err) {
    logFailure("extendDatasetGrantAction", err);
    return updateFailed();
  }
  if (!result.ok) return notEligible();

  revalidatePath("/admin/access");
  return { ok: true };
}

/**
 * Builds today's dataset edition now ("Build now" on the Editions panel). Runs whether or not
 * DATASET_SHARING_ENABLED is on: Ed pre-builds before flipping the flag, and the files are private until a
 * grant downloads them. The builder is idempotent per UTC day and never throws; the return is built from
 * scratch so no edition id or storage path reaches the client, only the outcome, date, count and failure code.
 */
export async function buildEditionNowAction(): Promise<
  | { ok: true; outcome: EditionBuildResult["outcome"]; editionDate: string; recordCount?: number }
  | { ok: false; error: string; code?: string }
> {
  await assertAdminSession();

  let result: EditionBuildResult;
  try {
    result = await buildEdition();
  } catch (err) {
    // Contract says never; a thrown error would still carry bound params, so log the code only.
    logFailure("buildEditionNowAction", err);
    revalidatePath("/admin/access");
    return { ok: false, error: BUILD_FAILED_ERROR, code: redactedErrorCode(err) };
  }
  revalidatePath("/admin/access");

  if (result.outcome === "failed") return { ok: false, error: BUILD_FAILED_ERROR, code: result.code };
  if (result.outcome === "published") {
    return { ok: true, outcome: "published", editionDate: result.editionDate, recordCount: result.recordCount };
  }
  return { ok: true, outcome: result.outcome, editionDate: result.editionDate };
}
