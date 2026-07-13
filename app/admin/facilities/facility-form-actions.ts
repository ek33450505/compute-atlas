"use server";

import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { createFacility, updateFacility, type WriteResult } from "@/lib/facility-write";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so both actions re-verify the admin session cookie here
 * before touching the DB — same pattern as `app/admin/submissions/actions.ts`
 * and `app/admin/facilities/delete-action.ts`.
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

/**
 * Creates a new facility. `createFacility` re-validates `input` against the
 * full `facilitySchema` server-side regardless of what the client already
 * checked — client-side validation is UX only, not the security boundary.
 * Redirect-on-success and the success toast are handled by the calling
 * client component (`facility-form.tsx`), not here, so this action's return
 * value can also surface field-level `issues` on a 400 without a redirect
 * short-circuiting that path.
 */
export async function createFacilityAction(input: unknown): Promise<WriteResult> {
  await assertAdminSession();

  return createFacility(input);
}

/**
 * Updates an existing facility by id. `updateFacility` does a SHALLOW
 * top-level merge onto the existing stored document — the caller must always
 * submit complete nested objects (`location`, `capacityMw`, `energy`,
 * `water`, `jobs`, `community`, etc.), never a partial patch, or sibling
 * fields inside that object are silently dropped by the merge.
 */
export async function updateFacilityAction(id: string, input: unknown): Promise<WriteResult> {
  await assertAdminSession();

  return updateFacility(id, input);
}
