import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { apiAccessGrantsTable } from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { checkAccessGrantEmailSendCap } from "@/lib/rate-limit";

export const accessGrantInputSchema = z.object({
  email: z.string().email().max(254),
  website: z.string().optional(), // honeypot — real users never fill this
});

export type AccessGrantInput = z.infer<typeof accessGrantInputSchema>;

export type AccessGrantResult =
  | { ok: true; confirm?: { email: string; confirmToken: string } }
  | { ok: false; status: number; error: string; issues?: unknown };

function isHoneypotTripped(input: { website?: string }): boolean {
  return Boolean(input.website && input.website.trim());
}

/** Statuses that represent an outstanding or live grant for an email — a new request is a no-op against either. */
const ACTIVE_GRANT_STATUSES = ["pending", "active"] as const;

/**
 * Validates and stages a double-opt-in bulk-API-access request. Mirrors
 * `subscribeToTarget` (lib/subscribe.ts) exactly for the enumeration-safety
 * reasoning: every "no new confirm email sent" path (honeypot, an existing
 * pending/active grant for this email, over the per-email send cap) returns
 * the same generic `{ok:true}` with no `confirm` payload, so the response
 * never leaks which case applied. Unlike `subscriptionsTable`, this table has
 * no partial-unique index for "one active grant per email" (only one grant
 * type exists here, not a per-target dedup problem), so duplicate detection
 * is a SELECT-before-INSERT rather than a caught 23505 — the small race
 * window this leaves (two concurrent requests for the same brand-new email)
 * is accepted for this low-volume, low-stakes flow.
 *
 * On a genuine new request, returns `{ok:true, confirm}` instead of sending
 * the email itself — the caller (the route) schedules the actual send AFTER
 * the response goes out via `after()`, so response latency can't distinguish
 * the new-request path from the generic-success paths (same timing-leak fix
 * as subscribeToTarget, from a prior security review).
 */
export async function requestAccessGrant(
  rawInput: unknown,
  ipHash: string
): Promise<AccessGrantResult> {
  const parsed = accessGrantInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid request", issues: parsed.error.issues };
  }
  const data = parsed.data;

  if (isHoneypotTripped(data)) {
    return { ok: true };
  }

  const email = data.email.trim().toLowerCase();

  // Per-address send cap (mirrors subscribeToTarget's per-address send cap): checked before
  // the duplicate-grant lookup so both the eventual-new and
  // eventual-duplicate paths reach it before any DB write, keeping the
  // function timing-symmetric.
  if (!(await checkAccessGrantEmailSendCap(email)).ok) {
    return { ok: true }; // over the per-address send cap — generic success, no row, no email
  }

  const db = getDb();

  const existing = await db
    .select({ id: apiAccessGrantsTable.id })
    .from(apiAccessGrantsTable)
    .where(
      and(eq(apiAccessGrantsTable.email, email), inArray(apiAccessGrantsTable.status, ACTIVE_GRANT_STATUSES))
    )
    .limit(1);
  if (existing.length > 0) {
    // A pending or active grant already exists for this email — generic
    // success, no second row, no second email (same enumeration-safety
    // reasoning as the subscribe flow's active-target dedup).
    return { ok: true };
  }

  const [row] = await db
    .insert(apiAccessGrantsTable)
    .values({
      email,
      status: "pending",
      confirmToken: generateToken(),
      submitterIpHash: ipHash,
    })
    .returning({ confirmToken: apiAccessGrantsTable.confirmToken });

  return { ok: true, confirm: { email, confirmToken: row.confirmToken } };
}

const GRANT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export type ConfirmAccessGrantResult =
  | { status: "active"; accessToken: string }
  | { status: "invalid" };

/**
 * Consumes a single-use confirm token: mints the long-lived `accessToken`,
 * flips the row to `status: "active"`, and stamps `confirmedAt`/`expiresAt`.
 * Unlike `confirmSubscription` (lib/subscribe.ts), there is no "already
 * confirmed" success path — a second confirm attempt on a token whose row is
 * no longer `pending` (already active, or revoked) is treated as `invalid`
 * and does NOT reissue a new `accessToken`, because the whole point of
 * "shown once" is defeated if a stale link can regenerate or re-reveal it.
 */
export async function confirmAccessGrant(token: string): Promise<ConfirmAccessGrantResult> {
  if (!token) {
    return { status: "invalid" };
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(apiAccessGrantsTable)
    .where(eq(apiAccessGrantsTable.confirmToken, token));
  const row = rows[0];
  if (!row || row.status !== "pending") {
    return { status: "invalid" };
  }

  const accessToken = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GRANT_EXPIRY_MS);

  // Re-check status=pending in the UPDATE's own WHERE, not just the read
  // above: two concurrent confirms of the same token can both pass the
  // read-then-check race, but only the first UPDATE can still match a
  // pending row — the loser's zero-row result falls through to `invalid`
  // below instead of silently minting (and immediately orphaning) a second
  // accessToken.
  const updated = await db
    .update(apiAccessGrantsTable)
    .set({ status: "active", accessToken, confirmedAt: now, expiresAt })
    .where(
      and(eq(apiAccessGrantsTable.confirmToken, token), eq(apiAccessGrantsTable.status, "pending"))
    )
    .returning({ id: apiAccessGrantsTable.id });

  if (updated.length === 0) {
    return { status: "invalid" };
  }

  return { status: "active", accessToken };
}
