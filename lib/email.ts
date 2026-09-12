import { randomBytes } from "node:crypto";
import { Resend } from "resend";

import { siteConfig } from "@/lib/site";

/**
 * 256-bit random token, base64url-encoded (~43 chars, URL-safe, no padding).
 * The raw value returned here goes to the recipient once (embedded in a
 * confirm/access/unsubscribe email) and is never itself the value compared on
 * lookup — confirm and access tokens are stored as a sha256 hash (see
 * `lib/token-hash.ts` and the per-column comments in `lib/db/schema.ts`); the
 * unsubscribe token is the one deliberate exception and stays raw in storage.
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Shared send path for every outbound email below: resolves the Resend
 * client (skipping with `skipLogMessage` if `RESEND_API_KEY` is unset), sends
 * `payload`, and logs any failure under `logLabel`. Each public sender still
 * composes its own subject/text/html (and any sender-specific guard, e.g.
 * sendContactEmail's CONTACT_TO_EMAIL check) before calling this.
 */
async function sendViaResend(
  logLabel: string,
  skipLogMessage: string,
  payload: Parameters<Resend["emails"]["send"]>[0],
): Promise<{ sent: boolean }> {
  const resend = getResend();
  if (!resend) {
    console.warn(skipLogMessage);
    return { sent: false };
  }

  try {
    const result = await resend.emails.send(payload);
    if (result.error) {
      // Log only the error type, not the raw Resend error object — it can
      // echo the recipient address back on a validation failure (caught in
      // a prior security review).
      console.error(`${logLabel} failed:`, result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error(`${logLabel} failed:`, error instanceof Error ? error.name : "unknown");
    return { sent: false };
  }
}

export async function sendConfirmEmail(input: {
  email: string;
  targetLabel: string;
  confirmToken: string;
}): Promise<{ sent: boolean }> {
  const confirmUrl = `${linkBase()}/api/subscribe/confirm?token=${encodeURIComponent(input.confirmToken)}`;
  const subject = "Confirm your Compute Atlas alerts";
  const text = `You asked to be notified when ${input.targetLabel} changes on Compute Atlas. Confirm to start receiving updates: ${confirmUrl}. If this wasn't you, ignore this email — nothing is sent unless you confirm.`;
  const html = `<p>You asked to be notified when <strong>${escapeHtml(input.targetLabel)}</strong> changes on Compute Atlas.</p><p><a href="${escapeHtml(confirmUrl)}">Confirm to start receiving updates</a></p><p>If this wasn't you, ignore this email — nothing is sent unless you confirm.</p>`;

  return sendViaResend(
    "sendConfirmEmail",
    "RESEND_API_KEY not set — skipping confirm email send",
    { from: fromAddress(), to: input.email, subject, text, html },
  );
}

export async function sendBulkAccessEmail(input: {
  email: string;
  confirmToken: string;
}): Promise<{ sent: boolean }> {
  const confirmUrl = `${linkBase()}/api/access/confirm?token=${encodeURIComponent(input.confirmToken)}`;
  const subject = "Your Compute Atlas bulk API access link";
  const why =
    "This exists to stop automated scraping and hammering of the API, not to gatekeep the data. " +
    "The full dataset is still available with zero login at /data for anyone who just wants it once. " +
    "This flow is only for people building a recurring or automated integration who want a higher, non-anonymous request ceiling.";
  const text = `Confirm your Compute Atlas bulk API access: ${confirmUrl}\n\n${why}\n\nIf this wasn't you, ignore this email — nothing is granted unless you confirm.`;
  const html = `<p><a href="${escapeHtml(confirmUrl)}">Confirm your Compute Atlas bulk API access</a></p><p>${escapeHtml(why)}</p><p>If this wasn't you, ignore this email — nothing is granted unless you confirm.</p>`;

  return sendViaResend(
    "sendBulkAccessEmail",
    "RESEND_API_KEY not set — skipping bulk access email send",
    { from: fromAddress(), to: input.email, subject, text, html },
  );
}

export async function sendContactEmail(input: {
  name: string;
  email: string;
  topic: string;
  message: string;
}): Promise<{ sent: boolean }> {
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

  return sendViaResend(
    "sendContactEmail",
    "RESEND_API_KEY not set — skipping contact email send",
    { from: fromAddress(), to, replyTo: input.email, subject, text, html },
  );
}

export async function sendChangeNotification(input: {
  email: string;
  facilityName: string;
  facilitySlug: string;
  changeLabel: string;
  status: string;
  unsubscribeToken: string;
}): Promise<{ sent: boolean }> {
  const facilityUrl = `${linkBase()}/facilities/${input.facilitySlug}`;
  const unsubUrl = `${linkBase()}/api/subscribe/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`;
  const subject = `${input.facilityName} — record updated on Compute Atlas`;
  const text = `The record you're watching changed: ${input.facilityName} — ${input.changeLabel} (now ${input.status}). View it: ${facilityUrl}.\n\nYou're receiving this because you asked to be notified when this record changes on Compute Atlas. Unsubscribe: ${unsubUrl}`;
  const html = `<p>The record you're watching changed: <strong>${escapeHtml(input.facilityName)}</strong> — ${escapeHtml(input.changeLabel)} (now ${escapeHtml(input.status)}).</p><p><a href="${escapeHtml(facilityUrl)}">View it</a></p><p style="color:#666;font-size:0.85em;">You're receiving this because you asked to be notified when this record changes on Compute Atlas. <a href="${escapeHtml(unsubUrl)}">Unsubscribe</a></p>`;

  return sendViaResend(
    "sendChangeNotification",
    "RESEND_API_KEY not set — skipping change notification send",
    {
      from: fromAddress(),
      to: input.email,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    },
  );
}

/**
 * "Email me when this is reviewed" — the one-shot send for the
 * `submission_notify_requests` flow (see lib/submission-notify.ts and the
 * review-time hook in lib/submissions.ts). Deliberately NOT a copy-paste of
 * `sendChangeNotification` above, even though both are "a facility changed"
 * emails: this recipient never subscribed to anything, so every one of that
 * template's phrases — "the record you're watching", "you asked to be
 * notified", an unsubscribe link, a List-Unsubscribe header — would be false
 * here. (This repo shipped exactly that mistake once already: a state digest
 * inherited a facility-watch template's copy and an unsubscribe link that
 * lied to its recipients.) Instead this says plainly what happened and that
 * the address is now deleted — there is nothing to unsubscribe FROM.
 *
 * Deliberately no `note`/`reason` parameter, and none should be added:
 * `rejectSubmission`'s `reason` is maintainer-authored commentary for the
 * internal review queue (rendered in the admin UI), never contributor-facing
 * copy — mailing it to an anonymous third party would forward internal notes
 * ("obvious spam", "IP looks like a bot farm") to whoever the submitter
 * named as their contact.
 */
export async function sendSubmissionReviewedEmail(input: {
  email: string;
  decision: "approved" | "rejected";
  facilityName: string;
  facilitySlug?: string; // present on approval — links to the live /facilities/<slug> page
}): Promise<{ sent: boolean }> {
  if (input.decision === "approved") {
    const facilityUrl = `${linkBase()}/facilities/${input.facilitySlug}`;
    const subject = `${input.facilityName} is now live on Compute Atlas`;
    const text = `Compute Atlas has reviewed and published ${input.facilityName}: ${facilityUrl}\n\nThis is the only email you will receive about this submission — your address has now been deleted from our records.`;
    const html = `<p>Compute Atlas has reviewed and published <strong>${escapeHtml(input.facilityName)}</strong>.</p><p><a href="${escapeHtml(facilityUrl)}">View it</a></p><p style="color:#666;font-size:0.85em;">This is the only email you will receive about this submission — your address has now been deleted from our records.</p>`;

    return sendViaResend(
      "sendSubmissionReviewedEmail",
      "RESEND_API_KEY not set — skipping submission-reviewed email send",
      { from: fromAddress(), to: input.email, subject, text, html },
    );
  }

  // Rejected: non-accusatory by design. Most rejections are "couldn't verify
  // from the cited source," not "you did something wrong" — the copy speaks
  // in those general terms about the CLASS of rejection rather than
  // asserting a specific cause for this one (there is no `reason` param to
  // draw from — see the doc comment above), never implies wrongdoing, and
  // never promises a human reply.
  const contributeUrl = `${linkBase()}/contribute`;
  const subject = "Update on your Compute Atlas submission";
  const text = `Compute Atlas has finished reviewing ${input.facilityName}, and it was not published. The verification bar for this source-cited dataset is strict — most submissions that don't go through simply couldn't be confirmed from the source provided, not a reflection on you. If you have a stronger or more specific source, you're welcome to submit again: ${contributeUrl}\n\nThis is the only email you will receive about this submission — your address has now been deleted from our records.`;
  const html = `<p>Compute Atlas has finished reviewing <strong>${escapeHtml(input.facilityName)}</strong>, and it was not published.</p><p>The verification bar for this source-cited dataset is strict — most submissions that don't go through simply couldn't be confirmed from the source provided, not a reflection on you. If you have a stronger or more specific source, you're welcome to submit again: <a href="${escapeHtml(contributeUrl)}">${escapeHtml(contributeUrl)}</a></p><p style="color:#666;font-size:0.85em;">This is the only email you will receive about this submission — your address has now been deleted from our records.</p>`;

  return sendViaResend(
    "sendSubmissionReviewedEmail",
    "RESEND_API_KEY not set — skipping submission-reviewed email send",
    { from: fromAddress(), to: input.email, subject, text, html },
  );
}
