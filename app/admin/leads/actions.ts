"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { updateLeadStatus, resetLeadToNew, type LeadActionResult } from "@/lib/leads";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so every action here re-verifies the admin session cookie
 * before touching the DB. Mirrors app/admin/submissions/actions.ts.
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

/**
 * The ONLY writer of `researching`, which means "a human is actively working
 * this lead" and nothing else. `scripts/discovery/leads-lane.ts` writes
 * `deferred` on its own give-up paths — do not let the lane reach this status
 * again, or the two meanings become indistinguishable. See LEAD_STATUSES in
 * lib/lead-fields.ts.
 */
export async function markLeadResearchingAction(
  id: string,
  reviewNote?: string
): Promise<LeadActionResult> {
  await assertAdminSession();

  const result = await updateLeadStatus(id, "researching", reviewNote);
  if (result.ok) {
    revalidatePath("/admin/leads");
  }
  return result;
}

/**
 * Returns a lead to `new` — the only way back into the discovery lane's queue.
 *
 * `scripts/discovery/leads-lane.ts` queues `listLeadsForAdmin("new")` and
 * nothing else, so every other status is a one-way door out of the lane:
 * `researching`/`deferred` offer only forward moves, and a `promoted`/`dismissed`
 * lead renders no actions at all. Without this, recovering a mis-triaged lead
 * required a hand-written Neon UPDATE.
 *
 * Delegates to `resetLeadToNew`, NOT the generic `updateLeadStatus`: re-queueing
 * needs `promotedSubmissionId` cleared (else the lane can stage a second
 * submission for the same site) and the prior `reviewNote` preserved (else a
 * dismissal's recorded reason is silently destroyed). See that function's doc.
 */
export async function resetLeadToNewAction(
  id: string,
  reviewNote?: string
): Promise<LeadActionResult> {
  await assertAdminSession();

  const result = await resetLeadToNew(id, reviewNote);
  if (result.ok) {
    revalidatePath("/admin/leads");
  }
  return result;
}

export async function markLeadPromotedAction(
  id: string,
  reviewNote?: string
): Promise<LeadActionResult> {
  await assertAdminSession();

  const result = await updateLeadStatus(id, "promoted", reviewNote);
  if (result.ok) {
    revalidatePath("/admin/leads");
  }
  return result;
}

/** Requires a non-empty reason, mirroring rejectSubmission's required-reason guard. */
export async function dismissLeadAction(id: string, reason: string): Promise<LeadActionResult> {
  await assertAdminSession();

  if (!reason || !reason.trim()) {
    return { ok: false, status: 400, error: "reason is required" };
  }

  const result = await updateLeadStatus(id, "dismissed", reason);
  if (result.ok) {
    revalidatePath("/admin/leads");
  }
  return result;
}
