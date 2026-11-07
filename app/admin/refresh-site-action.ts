"use server";

import { hasAdminSession } from "@/lib/admin-session";
import { bustCacheTags } from "@/lib/revalidate-tags";

export type RefreshSiteState =
  | { ok: true }
  | { ok: false; error: string }
  | null;

/**
 * Server Actions are independently callable, so this re-verifies the admin
 * session itself and fails closed.
 */
async function assertAdminSession(): Promise<void> {
  if (!(await hasAdminSession())) {
    throw new Error("Unauthorized");
  }
}

/**
 * Busts the `facilities` tag ONLY (aggregate and hub pages). It does not
 * regenerate the hero plate, hero points or as-of date; those regenerate at the
 * next build. The error text is fixed: never surface an error object.
 */
export async function refreshSiteAction(): Promise<RefreshSiteState> {
  try {
    await assertAdminSession();
    const result = bustCacheTags(["facilities"]);
    // Defensive: the tag is a constant in the vocabulary, so this cannot fail today.
    if (!result.ok) return { ok: false, error: "Refresh failed" };
    return { ok: true };
  } catch {
    return { ok: false, error: "Refresh failed" };
  }
}
