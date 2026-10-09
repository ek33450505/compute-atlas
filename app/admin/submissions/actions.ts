"use server";

import { cookies } from "next/headers";
import { revalidatePath, revalidateTag } from "next/cache";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import {
  approveSubmission,
  rejectSubmission,
  type SubmissionActionResult,
  type SubmissionRejectResult,
} from "@/lib/submissions";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so both actions re-verify the admin session cookie here
 * before touching the DB.
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

export async function approveSubmissionAction(
  id: string,
  reviewNote?: string
): Promise<SubmissionActionResult> {
  await assertAdminSession();

  const result = await approveSubmission(id, reviewNote);
  if (result.ok) {
    revalidatePath("/admin/submissions");
  }
  return result;
}

export async function rejectSubmissionAction(
  id: string,
  reason: string
): Promise<SubmissionRejectResult> {
  await assertAdminSession();

  const result = await rejectSubmission(id, reason);
  if (result.ok) {
    revalidatePath("/admin/submissions");
  }
  return result;
}

/**
 * Busts the global `"facilities"` tag so aggregate pages (home, map, table,
 * stats) re-read Neon. Approvals deliberately do NOT do this themselves
 * (`tagsForFacility` in lib/cache-tags.ts): aggregates ride a 1h timer to avoid
 * the ISR-write blowout, so an aggregate render DURING an approval batch can
 * freeze a partial count for up to an hour. One bust after the batch is the
 * approved trade-off — the maintainer presses this once, not per approval.
 *
 * It cannot refresh the 24h untagged search index (`loadFacilitiesForSearch`).
 * Measured on prod 2026-10-02 for the HOMEPAGE only: after a "facilities" bust
 * the first GET served the stale body and the second served fresh, with no
 * Cloudflare purge needed. Map, table and stats were not measured that way;
 * they ride the same 1h timer regardless.
 */
export async function refreshAggregatesAction(): Promise<{ ok: true }> {
  await assertAdminSession();

  // Literal tag: lib/cache-tags.ts exports no constant for it.
  revalidateTag("facilities", "max");
  return { ok: true };
}
