import { randomBytes } from "node:crypto";
import { Resend } from "resend";

import { siteConfig } from "@/lib/site";

/**
 * 256-bit random token, base64url-encoded (~43 chars, URL-safe, no padding).
 * Used for both the single-use confirm token and the long-lived unsubscribe
 * token on `subscriptions` rows (`lib/db/schema.ts`) — see that file's
 * comment for the raw-storage (no hashing/signing) rationale.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "Compute Atlas <alerts@compute-atlas.com>";
}

function linkBase(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? siteConfig.url;
}

/**
 * Lazily constructs a Resend client, reading `RESEND_API_KEY` at call-time
 * (never module scope) so builds, tests, and CI run fine with no key set —
 * sends become a logged no-op instead of a hard failure.
 */
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendConfirmEmail(input: {
  email: string;
  targetLabel: string;
  confirmToken: string;
}): Promise<{ sent: boolean }> {
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping confirm email send");
    return { sent: false };
  }

  const confirmUrl = `${linkBase()}/api/subscribe/confirm?token=${encodeURIComponent(input.confirmToken)}`;
  const subject = "Confirm your Compute Atlas alerts";
  const text = `You asked to be notified when ${input.targetLabel} changes on Compute Atlas. Confirm to start receiving updates: ${confirmUrl}. If this wasn't you, ignore this email — nothing is sent unless you confirm.`;
  const html = `<p>You asked to be notified when <strong>${escapeHtml(input.targetLabel)}</strong> changes on Compute Atlas.</p><p><a href="${escapeHtml(confirmUrl)}">Confirm to start receiving updates</a></p><p>If this wasn't you, ignore this email — nothing is sent unless you confirm.</p>`;

  try {
    const result = await resend.emails.send({ from: fromAddress(), to: input.email, subject, text, html });
    if (result.error) {
      // Log only the error type, not the raw Resend error object — it can
      // echo the recipient address back on a validation failure (s65
      // security review, Fix 3).
      console.error("sendConfirmEmail failed:", result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("sendConfirmEmail failed:", error instanceof Error ? error.name : "unknown");
    return { sent: false };
  }
}

export async function sendBulkAccessEmail(input: {
  email: string;
  confirmToken: string;
}): Promise<{ sent: boolean }> {
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping bulk access email send");
    return { sent: false };
  }

  const confirmUrl = `${linkBase()}/api/access/confirm?token=${encodeURIComponent(input.confirmToken)}`;
  const subject = "Your Compute Atlas bulk API access link";
  const why =
    "This exists to stop automated scraping and hammering of the API, not to gatekeep the data. " +
    "The full dataset is still available with zero login at /data for anyone who just wants it once. " +
    "This flow is only for people building a recurring or automated integration who want a higher, non-anonymous request ceiling.";
  const text = `Confirm your Compute Atlas bulk API access: ${confirmUrl}\n\n${why}\n\nIf this wasn't you, ignore this email — nothing is granted unless you confirm.`;
  const html = `<p><a href="${escapeHtml(confirmUrl)}">Confirm your Compute Atlas bulk API access</a></p><p>${escapeHtml(why)}</p><p>If this wasn't you, ignore this email — nothing is granted unless you confirm.</p>`;

  try {
    const result = await resend.emails.send({ from: fromAddress(), to: input.email, subject, text, html });
    if (result.error) {
      // Log only the error type, not the raw Resend error object — it can
      // echo the recipient address back on a validation failure (s65
      // security review, Fix 3).
      console.error("sendBulkAccessEmail failed:", result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("sendBulkAccessEmail failed:", error instanceof Error ? error.name : "unknown");
    return { sent: false };
  }
}

export async function sendContactEmail(input: {
  name: string;
  email: string;
  topic: string;
  message: string;
}): Promise<{ sent: boolean }> {
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping contact email send");
    return { sent: false };
  }

  const to = process.env.CONTACT_TO_EMAIL;
  if (!to) {
    // The message is already durably stored (the route inserts the row
    // before calling this), so nothing is lost — just log so the gap is
    // visible in server logs rather than silently swallowed.
    console.warn("CONTACT_TO_EMAIL not set — skipping contact email send");
    return { sent: false };
  }

  const subject = `Compute Atlas contact — ${input.topic}`;
  const text = `New contact form submission.\n\nName: ${input.name}\nEmail: ${input.email}\nTopic: ${input.topic}\n\n${input.message}`;
  const html = `<p><strong>New contact form submission</strong></p><p>Name: ${escapeHtml(input.name)}<br>Email: ${escapeHtml(input.email)}<br>Topic: ${escapeHtml(input.topic)}</p><p>${escapeHtml(input.message).replace(/\n/g, "<br>")}</p>`;

  try {
    const result = await resend.emails.send({
      from: fromAddress(),
      to,
      replyTo: input.email,
      subject,
      text,
      html,
    });
    if (result.error) {
      // Log only the error type, not the raw Resend error object — it can
      // echo the recipient address back on a validation failure (s65
      // security review, Fix 3).
      console.error("sendContactEmail failed:", result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("sendContactEmail failed:", error instanceof Error ? error.name : "unknown");
    return { sent: false };
  }
}

export async function sendChangeNotification(input: {
  email: string;
  facilityName: string;
  facilitySlug: string;
  changeLabel: string;
  status: string;
  unsubscribeToken: string;
}): Promise<{ sent: boolean }> {
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping change notification send");
    return { sent: false };
  }

  const facilityUrl = `${linkBase()}/facilities/${input.facilitySlug}`;
  const unsubUrl = `${linkBase()}/api/subscribe/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`;
  const subject = `${input.facilityName} — record updated on Compute Atlas`;
  const text = `The record you're watching changed: ${input.facilityName} — ${input.changeLabel} (now ${input.status}). View it: ${facilityUrl}.\n\nYou're receiving this because you asked to be notified when this record changes on Compute Atlas. Unsubscribe: ${unsubUrl}`;
  const html = `<p>The record you're watching changed: <strong>${escapeHtml(input.facilityName)}</strong> — ${escapeHtml(input.changeLabel)} (now ${escapeHtml(input.status)}).</p><p><a href="${escapeHtml(facilityUrl)}">View it</a></p><p style="color:#666;font-size:0.85em;">You're receiving this because you asked to be notified when this record changes on Compute Atlas. <a href="${escapeHtml(unsubUrl)}">Unsubscribe</a></p>`;

  try {
    const result = await resend.emails.send({
      from: fromAddress(),
      to: input.email,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (result.error) {
      // Log only the error type, not the raw Resend error object — it can
      // echo the recipient address back on a validation failure (s65
      // security review, Fix 3).
      console.error("sendChangeNotification failed:", result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("sendChangeNotification failed:", error instanceof Error ? error.name : "unknown");
    return { sent: false };
  }
}
