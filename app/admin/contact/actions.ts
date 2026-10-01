"use server";

import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { getContactMessageForReply } from "@/lib/contact";
import { redactedErrorCode } from "@/lib/db-error";
import { sendContactReply } from "@/lib/email";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so every action here re-verifies the admin session cookie
 * before doing anything. Mirrors app/admin/leads/actions.ts.
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

const MAX_REPLY_LENGTH = 10_000;

/**
 * Replies to a contact message as Compute Atlas. The recipient is looked up
 * server-side from the message id — the client never supplies an address, so a
 * stolen admin cookie cannot turn this into an open relay.
 */
export async function replyToContactMessageAction(
  id: string,
  replyBody: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  await assertAdminSession();

  const body = typeof replyBody === "string" ? replyBody.trim() : "";
  if (!body) return { ok: false, error: "Reply cannot be empty" };
  if (body.length > MAX_REPLY_LENGTH) {
    return { ok: false, error: `Reply is too long (max ${MAX_REPLY_LENGTH} characters)` };
  }

  let original;
  try {
    original = await getContactMessageForReply(id);
  } catch (err) {
    // Code only: Drizzle errors embed bound params, including the visitor email.
    console.error(`replyToContactMessageAction lookup failed (sqlstate: ${redactedErrorCode(err)})`);
    return { ok: false, error: "Could not load the message" };
  }
  if (!original) return { ok: false, error: "Message not found" };

  const { sent } = await sendContactReply({
    to: original.email,
    originalMessage: original.message,
    replyBody: body,
  });
  if (!sent) {
    return { ok: false, error: "Reply was not sent — check RESEND_API_KEY / Resend logs." };
  }
  return { ok: true };
}
