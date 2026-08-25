import { z } from "zod";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { subscriptionsTable } from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { getFacilityById } from "@/lib/data";
import { checkEmailSendCap } from "@/lib/rate-limit";

export const subscribeInputSchema = z
  .object({
    email: z.string().email().max(254),
    targetType: z.enum(["facility"]),
    targetId: z.string().max(120).optional(),
    website: z.string().optional(), // honeypot — real users never fill this
  })
  .refine((s) => Boolean(s.targetId), {
    message: "targetId is required",
    path: ["targetId"],
  });

export type SubscribeInput = z.infer<typeof subscribeInputSchema>;

export type SubscribeResult =
  | { ok: true; confirm?: { email: string; targetLabel: string; confirmToken: string } }
  | { ok: false; status: number; error: string; issues?: unknown };

function isHoneypotTripped(input: { website?: string }): boolean {
  return Boolean(input.website && input.website.trim());
}

const UNIQUE_VIOLATION_CODE = "23505";

/**
 * The neon-http and PGlite drivers both surface constraint violations with a
 * Postgres error `code`, but drizzle-orm wraps the driver error in a
 * `DrizzleQueryError` whose own `.message` is a generic "Failed query: ..."
 * string — the real `code`/message live one level down on `.cause`. Check
 * both layers, plus a message-regex fallback in case a driver loses `code`.
 */
function isUniqueViolation(err: unknown): boolean {
  const layers = [err, err instanceof Error ? err.cause : undefined];
  return layers.some((layer) => {
    if (!layer) return false;
    if ((layer as { code?: unknown }).code === UNIQUE_VIOLATION_CODE) return true;
    const message = layer instanceof Error ? layer.message : String(layer);
    return /duplicate key|unique/i.test(message);
  });
}

/**
 * Validates and stages a double-opt-in subscription. Always returns a
 * generic `{ok:true}` for every "no new confirm email sent" path (honeypot,
 * already actively subscribed, over the per-email send cap) so the response
 * never leaks whether a given email/target combination already exists — only
 * genuine input-format or unknown-target errors return a non-generic result.
 * On a genuine new subscription, returns `{ok:true, confirm}` instead of
 * sending the email itself — the caller (the route) schedules the actual
 * send AFTER the response goes out, so response latency can't distinguish
 * the new-subscription path from the generic-success paths (Fix 1, s65
 * security review).
 */
export async function subscribeToTarget(
  rawInput: unknown,
  ipHash: string
): Promise<SubscribeResult> {
  const parsed = subscribeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid subscription", issues: parsed.error.issues };
  }
  const data = parsed.data;

  if (isHoneypotTripped(data)) {
    return { ok: true };
  }

  const email = data.email.trim().toLowerCase();

  const facility = await getFacilityById(data.targetId!);
  if (!facility) {
    return { ok: false, status: 400, error: "Unknown facility" };
  }
  const targetId = data.targetId!;
  const targetLabel = facility.name;

  // Per-address send cap (Fix 2, s65 security review): the IP rate limit
  // alone doesn't stop a distributed attacker from email-bombing one victim
  // by varying targetId/IP. This check runs on BOTH the eventual-new and
  // eventual-duplicate paths below (both reach this point before the
  // insert), so it stays timing-symmetric with the rest of the function.
  if (!(await checkEmailSendCap(email)).ok) {
    return { ok: true }; // over the per-address send cap — generic success, no row, no email
  }

  const db = getDb();
  try {
    const [row] = await db
      .insert(subscriptionsTable)
      .values({
        email,
        targetType: data.targetType,
        targetId,
        status: "pending",
        confirmToken: generateToken(),
        unsubscribeToken: generateToken(),
        submitterIpHash: ipHash,
      })
      .returning({ confirmToken: subscriptionsTable.confirmToken });

    // The confirm email is NOT sent here. The route sends it AFTER this
    // function returns (via next/server's `after()`), so that response
    // latency is identical whether this is a new subscription or one of the
    // generic-success no-send paths above/below (Fix 1, s65 security
    // review) — awaiting the send inline made the duplicate path (immediate
    // return) measurably faster than the new-subscription path (waits on
    // the network), leaking whether the (email,target) pair already existed.
    //
    // KNOWN LIMITATION (MVP, reviewed s65): the send result is still not
    // acted on by anything here. If this first confirm email fails (e.g.
    // Resend down), the pending row persists and a retry hits the
    // active-subscription unique index (23505) → generic success with no
    // resend, so that (email,target) can't be confirmed until the row
    // clears. Accepted for MVP (rare + bounded). Future fix: roll back the
    // row on a genuine send error (distinguishing it from the env-gated
    // no-key no-op), or expire stale pending rows + allow resend.
    return { ok: true, confirm: { email, targetLabel, confirmToken: row.confirmToken } };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    // subscriptions_active_target_idx (partial unique index, lib/db/schema.ts)
    // rejected the insert: an active (pending|confirmed) subscription already
    // exists for this email+target. No confirm signal — the route won't
    // schedule a send — so this returns the same generic success as every
    // other "no send" path.
    return { ok: true };
  }
}

export async function confirmSubscription(
  token: string
): Promise<{ status: "confirmed" | "already" | "invalid" }> {
  if (!token) {
    return { status: "invalid" };
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.confirmToken, token));
  const row = rows[0];
  if (!row) {
    return { status: "invalid" };
  }
  if (row.status === "confirmed") {
    return { status: "already" };
  }
  if (row.status !== "pending") {
    // Stale confirm link for a since-unsubscribed row.
    return { status: "invalid" };
  }

  await db
    .update(subscriptionsTable)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(eq(subscriptionsTable.confirmToken, token));

  return { status: "confirmed" };
}

export async function unsubscribeByToken(
  token: string
): Promise<{ status: "unsubscribed" | "invalid" }> {
  if (!token) {
    return { status: "invalid" };
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.unsubscribeToken, token));
  if (!rows[0]) {
    return { status: "invalid" };
  }

  // Idempotent: re-applying to an already-unsubscribed row is a harmless no-op.
  await db
    .update(subscriptionsTable)
    .set({ status: "unsubscribed", unsubscribedAt: new Date() })
    .where(eq(subscriptionsTable.unsubscribeToken, token));

  return { status: "unsubscribed" };
}
