"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { updateLeadStatus, type LeadActionResult } from "@/lib/leads";

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
