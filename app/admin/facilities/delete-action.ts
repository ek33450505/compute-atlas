"use server";

import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { deleteFacility, type WriteResult } from "@/lib/facility-write";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so this action re-verifies the admin session cookie here
 * before touching the DB — same pattern as `app/admin/submissions/actions.ts`.
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

/**
 * Deletes a facility by id. `deleteFacility` itself 404s (via `WriteResult`)
 * if the facility doesn't exist, and revalidates the public-facing pages on
 * success. This is a destructive, irreversible operation — the caller (the
 * facility table's delete confirmation dialog) is responsible for requiring
 * explicit user confirmation before invoking this action.
 */
export async function deleteFacilityAction(id: string): Promise<WriteResult> {
  await assertAdminSession();

  return deleteFacility(id);
}
