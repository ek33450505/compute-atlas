import { z } from "zod";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { subscriptionsTable } from "@/lib/db/schema";
import { generateToken, sendConfirmEmail } from "@/lib/email";
import { getFacilityById } from "@/lib/data";
import { stateNameFromCode } from "@/lib/us-states";

export const subscribeInputSchema = z
  .object({
    email: z.string().email().max(254),
    targetType: z.enum(["facility", "state", "all"]),
    targetId: z.string().max(120).optional(),
    website: z.string().optional(), // honeypot — real users never fill this
  })
  .refine((s) => s.targetType === "all" || Boolean(s.targetId), {
    message: "targetId is required for facility and state subscriptions",
    path: ["targetId"],
  });

export type SubscribeInput = z.infer<typeof subscribeInputSchema>;

export type SubscribeResult =
  | { ok: true }
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
 * already actively subscribed) so the response never leaks whether a given
 * email/target combination already exists — only genuine input-format or
 * unknown-target errors return a non-generic result.
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

  let targetId: string | null = null;
  let targetLabel: string;

  if (data.targetType === "facility") {
    const facility = await getFacilityById(data.targetId!);
    if (!facility) {
      return { ok: false, status: 400, error: "Unknown facility" };
    }
    targetId = data.targetId!;
    targetLabel = facility.name;
  } else if (data.targetType === "state") {
    const code = data.targetId!.toUpperCase();
    const stateName = stateNameFromCode(code);
    if (!stateName) {
      return { ok: false, status: 400, error: "Unknown state" };
    }
    targetId = code;
    targetLabel = stateName;
  } else {
    targetLabel = "all Compute Atlas updates";
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

    // KNOWN LIMITATION (MVP, reviewed s65): the send result is intentionally
    // not acted on. If this first confirm email fails (e.g. Resend down), the
    // pending row persists and a retry hits the active-subscription unique index
    // (23505) → generic success with no resend, so that (email,target) can't be
    // confirmed until the row clears. Accepted for MVP (rare + bounded). Future
    // fix: roll back the row on a genuine send error (distinguishing it from the
    // env-gated no-key no-op), or expire stale pending rows + allow resend.
    await sendConfirmEmail({ email, targetLabel, confirmToken: row.confirmToken });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    // subscriptions_active_target_idx (partial unique index, lib/db/schema.ts)
    // rejected the insert: an active (pending|confirmed) subscription already
    // exists for this email+target. Don't send another confirm email — fall
    // through to the same generic success response.
  }

  return { ok: true };
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
