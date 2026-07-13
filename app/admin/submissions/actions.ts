"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

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
