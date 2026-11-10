import { escapeHtml } from "@/lib/html-escape";
import type { DatasetRequestEcho } from "@/lib/dataset-grants";
import { COMMERCIAL_PATH, COMMERCIAL_PLANS, formatPlanPrice } from "@/lib/commercial-plans";
import { DATASET_LICENSE_URL } from "@/lib/site";

/**
 * Pure builders for the dataset-sharing emails: each returns the complete `{ subject, text, html }` and reads
 * no environment (the sender in lib/email.ts resolves the site URL and recipient). Rules every builder keeps:
 * - Subjects are fixed strings: no requester-controlled text and no token ever reaches a subject.
 * - A raw token appears only inside its own link, URL-encoded; in HTML every interpolated value is escaped.
 * - Requester-supplied text (the echo, a rejection note) is escaped, and newlines become `<br>` only AFTER
 *   escaping. A requester-supplied URL is shown as escaped text, never as an `<a href>`.
 * - Residual, accepted (security review 2026-11-09): defanging is a heuristic for the echo, not a sanitizer. A link-like string it misses can still be auto-linked by a mail client, and `intendedUse` keeps its line breaks, so a requester can type lines that imitate echo rows. Both sit under the heading that says the text is unchecked and not endorsed, inside the 300-code-point cap.
 */

export type DatasetEmail = { subject: string; text: string; html: string };

const ECHO_HEADING =
  "Submitted with this request. This text was typed by whoever submitted it; Compute Atlas has not checked it and does not endorse any link in it:";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * Collapses C0 controls, DEL and Unicode line breaks to one space. `storableText` rejects only NUL and lone
 * surrogates, so a single-line field can carry CR/LF and would otherwise forge lines in the text body.
 */
const singleLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").trim();

/**
 * Makes every link-like token in requester-typed text inert: mail clients auto-link plain-text URLs, domains and
 * addresses, so left alone a stranger could make our mail carry a clickable link to any address. Works per
 * whitespace-delimited token (whitespace kept). A token is link-like if it holds `://`, `www.`, or a dot between
 * a label character and 2+ letters (`evil.example/login`, `a@b.example`; not "e.g.", "U.S." or "1.5").
 * `https://evil.example/a.b` becomes `hxxps://evil[.]example/a[.]b`.
 */
const LINKISH_BARE_DOMAIN = /[\p{L}\p{N}-]\.\p{L}{2,}/u;

const isLinkish = (token: string): boolean =>
  /:\/\//i.test(token) || /www\./i.test(token) || LINKISH_BARE_DOMAIN.test(token);

const defang = (value: string): string =>
  value
    .split(/(\s+)/)
    .map((token) => (isLinkish(token) ? token.replace(/http(s?):\/\//gi, "hxxp$1://").replace(/\./g, "[.]") : token))
    .join("");

const INTENDED_USE_MAX_CODE_POINTS = 300;

/** Cuts on code points, never inside a surrogate pair, and says so when it cut. */
function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max).join("")} (truncated)`;
}

/** A requester-supplied URL shown host-only and defanged, never as a link. */
function hostOnly(link: string): string {
  try {
    const host = new URL(link).hostname;
    return host === "" ? "(invalid link)" : host.replace(/\./g, "[.]");
  } catch {
    return "(invalid link)";
  }
}

const multiline = (value: string): string => escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");

const paragraphs = (...parts: string[]): string => parts.map((p) => `<p>${p}</p>`).join("");

const CATEGORY_LABEL: Record<DatasetRequestEcho["category"], string> = {
  journalist: "Journalist",
  academic: "Academic",
  nonprofit: "Nonprofit",
  government: "Government",
  commercial: "Commercial",
  other: "Other",
};

export function buildDatasetVerifyEmail(input: {
  siteUrl: string;
  verifyToken: string;
  echo: DatasetRequestEcho;
}): DatasetEmail {
  const { echo } = input;
  const url = `${input.siteUrl}/access/confirm?token=${encodeURIComponent(input.verifyToken)}`;
  const subject = "Confirm your Compute Atlas dataset access request";

  const rows: Array<[string, string]> = [
    ["Name", defang(singleLine(echo.name))],
    ["Organization", echo.organization === null ? "(none given)" : defang(singleLine(echo.organization))],
    ["Role", echo.role === null ? "(none given)" : defang(singleLine(echo.role))],
    ["Category", CATEGORY_LABEL[echo.category] ?? echo.category],
    ["Intended use", defang(truncateCodePoints(echo.intendedUse, INTENDED_USE_MAX_CODE_POINTS))],
    ["Links (host only)", echo.links.length > 0 ? echo.links.map(hostOnly).join("\n") : "(none given)"],
  ];

  const text = [
    "A request for access to the Compute Atlas dataset was submitted with this email address. Confirm that it was you to put it in the review queue.",
    "",
    "Check the details at the end of this email first. If they are not what you submitted, do not confirm: submit the request again.",
    "",
    url,
    "",
    "The link is valid for 7 days. If you did not make this request, ignore this email. Every request is reviewed by hand before any access is given.",
    "",
    ECHO_HEADING,
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");

  const htmlRows = rows
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${multiline(value)}</li>`)
    .join("");
  const html =
    paragraphs(
      "A request for access to the Compute Atlas dataset was submitted with this email address. Confirm that it was you to put it in the review queue.",
      "Check the details at the end of this email first. If they are not what you submitted, do not confirm: submit the request again.",
      `<a href="${escapeHtml(url)}">Confirm this request</a>`,
      "The link is valid for 7 days. If you did not make this request, ignore this email. Every request is reviewed by hand before any access is given.",
      `<strong>${escapeHtml(ECHO_HEADING)}</strong>`,
    ) + `<ul>${htmlRows}</ul>`;

  return { subject, text, html };
}

export function buildDatasetAlreadyActiveEmail(input: { siteUrl: string }): DatasetEmail {
  const contactUrl = `${input.siteUrl}/contact`;
  const subject = "Your Compute Atlas dataset access";
  const text = [
    "This address already holds access to the Compute Atlas dataset, so no new request was opened.",
    "",
    "A personal link was sent in your approval email, or in a later new-link email if one was issued (only the most recent link works). If you no longer have it, or it no longer works (access may be paused while a renewal is reviewed), use the contact page:",
    "",
    contactUrl,
  ].join("\n");
  const html = paragraphs(
    "This address already holds access to the Compute Atlas dataset, so no new request was opened.",
    "A personal link was sent in your approval email, or in a later new-link email if one was issued (only the most recent link works). If you no longer have it, or it no longer works (access may be paused while a renewal is reviewed), use the <a href=\"" +
      escapeHtml(contactUrl) +
      "\">contact page</a>.",
  );
  return { subject, text, html };
}

export function buildDatasetAdminNewRequestEmail(input: {
  siteUrl: string;
  name: string;
  organization: string | null;
}): DatasetEmail {
  const adminUrl = `${input.siteUrl}/admin/access`;
  const subject = "New dataset access request";
  const name = defang(singleLine(input.name));
  const org = input.organization === null ? "(none given)" : defang(singleLine(input.organization));
  const text = [
    "A dataset access request was verified and is waiting for review.",
    "",
    "As submitted, unverified (only the email address is verified):",
    `Name: ${name}`,
    `Organization: ${org}`,
    "",
    `Review it: ${adminUrl}`,
  ].join("\n");
  const html =
    paragraphs("A dataset access request was verified and is waiting for review.") +
    `<p>As submitted, unverified (only the email address is verified):</p><ul><li><strong>Name:</strong> ${escapeHtml(name)}</li><li><strong>Organization:</strong> ${escapeHtml(org)}</li></ul>` +
    paragraphs(`<a href="${escapeHtml(adminUrl)}">Review it</a>`);
  return { subject, text, html };
}

const ATTRIBUTION_TEXT = "When you publish work that uses the data, credit Compute Atlas under CC BY 4.0.";

export function buildDatasetApprovedEmail(input: { siteUrl: string; accessToken: string }): DatasetEmail {
  const url = `${input.siteUrl}/access/dataset?t=${encodeURIComponent(input.accessToken)}`;
  const dataUrl = `${input.siteUrl}/data`;
  const subject = "Your Compute Atlas dataset access is approved";
  const text = [
    "Your request for access to the Compute Atlas dataset was approved. Your personal link:",
    "",
    url,
    "",
    "The link is personal: do not share it. Access runs for 365 days from approval.",
    "",
    `${ATTRIBUTION_TEXT} How to cite: ${dataUrl}`,
  ].join("\n");
  const html = paragraphs(
    "Your request for access to the Compute Atlas dataset was approved.",
    `<a href="${escapeHtml(url)}">Open your personal link</a>`,
    "The link is personal: do not share it. Access runs for 365 days from approval.",
    `${escapeHtml(ATTRIBUTION_TEXT)} <a href="${escapeHtml(dataUrl)}">How to cite</a>.`,
  );
  return { subject, text, html };
}

export function buildDatasetRejectedEmail(input: {
  siteUrl: string;
  rejectionNote: string | null;
}): DatasetEmail {
  const contactUrl = `${input.siteUrl}/contact`;
  const subject = "Your Compute Atlas dataset access request";
  const note = input.rejectionNote;
  const text = [
    "Thank you for your interest in the Compute Atlas dataset. The request was not approved.",
    ...(note ? ["", "Note from the maintainer:", note] : []),
    "",
    `Questions can go through the contact page: ${contactUrl}`,
  ].join("\n");
  const html = paragraphs(
    "Thank you for your interest in the Compute Atlas dataset. The request was not approved.",
    ...(note ? [`<strong>Note from the maintainer:</strong><br>${multiline(note)}`] : []),
    `Questions can go through the <a href="${escapeHtml(contactUrl)}">contact page</a>.`,
  );
  return { subject, text, html };
}

export function buildDatasetCommercialRedirectEmail(input: { siteUrl: string }): DatasetEmail {
  const url = `${input.siteUrl}${COMMERCIAL_PATH}`;
  const subject = "Your Compute Atlas dataset access request";
  const free = "The full dataset is free for students, academics, journalists, nonprofits and government.";
  const paid = `For commercial use it is a subscription: ${formatPlanPrice("monthly")} or ${formatPlanPrice("annual")} (${COMMERCIAL_PLANS.annual.note}).`;
  const reply = "If this request was not for commercial use, reply to this email and say so.";
  const text = ["Thank you for your request for the Compute Atlas dataset.", free, "", paid, url, "", reply].join("\n");
  const html = paragraphs(
    "Thank you for your request for the Compute Atlas dataset.",
    escapeHtml(free),
    escapeHtml(paid),
    `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
    escapeHtml(reply),
  );
  return { subject, text, html };
}

export function buildDatasetLinkReissuedEmail(input: { siteUrl: string; accessToken: string }): DatasetEmail {
  const url = `${input.siteUrl}/access/dataset?t=${encodeURIComponent(input.accessToken)}`;
  const subject = "Your new Compute Atlas dataset link";
  const text = [
    "A new personal link for the Compute Atlas dataset was issued for this address:",
    "",
    url,
    "",
    "The previous link no longer works. The new link is personal: do not share it.",
  ].join("\n");
  const html = paragraphs(
    "A new personal link for the Compute Atlas dataset was issued for this address.",
    `<a href="${escapeHtml(url)}">Open your new link</a>`,
    "The previous link no longer works. The new link is personal: do not share it.",
  );
  return { subject, text, html };
}

export function buildDatasetRenewalReminderEmail(input: {
  siteUrl: string;
  renewToken: string;
  expiresAt: Date;
}): DatasetEmail {
  const url = `${input.siteUrl}/access/renew?token=${encodeURIComponent(input.renewToken)}`;
  const date = DATE_FORMAT.format(input.expiresAt);
  const subject = "Your Compute Atlas dataset access is expiring";
  const text = [
    `Your access to the Compute Atlas dataset expires on ${date} (UTC). To request a renewal, use this link before then:`,
    "",
    url,
    "",
    "Renewal requests are reviewed by hand. A renewal approved before that date continues without a break; if review is still pending when the date passes, downloads pause until it is approved. If you no longer need the data, ignore this email.",
  ].join("\n");
  const html = paragraphs(
    `Your access to the Compute Atlas dataset expires on ${escapeHtml(date)} (UTC). To request a renewal, use this link before then:`,
    `<a href="${escapeHtml(url)}">Request a renewal</a>`,
    "Renewal requests are reviewed by hand. A renewal approved before that date continues without a break; if review is still pending when the date passes, downloads pause until it is approved. If you no longer need the data, ignore this email.",
  );
  return { subject, text, html };
}

const EDITION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTICE_MAX_HEADLINES = 10;
const NOTICE_HEADLINE_MAX_CODE_POINTS = 200;

/**
 * Carries the unsubscribe URL it built, so the sender's `List-Unsubscribe` header is the same value as the body link.
 * `summary` is absent for the initial edition (there is nothing to compare against), which drops the counts line and
 * the list. Headlines are facility names and status values from the database: escaped in the html, and collapsed to
 * one line in the text so one cannot forge a line. The notice carries no personal link (the reader's existing link
 * already serves the new edition); a lost link is recovered through /contact.
 */
export function buildDatasetEditionNoticeEmail(input: {
  siteUrl: string;
  editionDate: string;
  unsubscribeToken: string;
  recordCount: number | null;
  summary?: { added: number; updated: number; removed: number; headlines: string[] };
}): DatasetEmail & { unsubscribeUrl: string } {
  if (!EDITION_DATE_RE.test(input.editionDate)) throw new Error("buildDatasetEditionNoticeEmail: bad edition date");
  const unsubUrl = `${input.siteUrl}/api/dataset/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`;
  const contactUrl = `${input.siteUrl}/contact`;
  const subject = "A new edition of the Compute Atlas dataset";
  const intro = `A new edition of the Compute Atlas dataset is available. Your current personal link (from your approval email, or from the most recent new-link email if one was issued) now serves the edition of ${input.editionDate}.`;
  const countLine = input.recordCount === null ? null : `This edition has ${input.recordCount.toLocaleString("en-US")} records.`;
  const changesLine = input.summary
    ? `Since the previous edition: +${input.summary.added} added, ${input.summary.updated} updated, ${input.summary.removed} removed.`
    : null;
  const headlines = (input.summary?.headlines ?? [])
    .slice(0, NOTICE_MAX_HEADLINES)
    .map((h) => truncateCodePoints(singleLine(h), NOTICE_HEADLINE_MAX_CODE_POINTS));
  const attribution = `Attribution is required. Data from Compute Atlas by Edward Kubiak (${input.siteUrl}), licensed under CC BY 4.0 (${DATASET_LICENSE_URL}).`;
  const lost = "Lost your link? Request a new one:";
  const footer = "You receive this notice because you hold dataset access.";

  const text = [
    intro,
    "",
    ...(countLine ? [countLine] : []),
    ...(changesLine ? [changesLine] : []),
    ...(headlines.length > 0 ? ["", ...headlines.map((h) => `- ${h}`)] : []),
    "",
    attribution,
    "",
    `${lost} ${contactUrl}`,
    "",
    `${footer} Unsubscribe from edition notices: ${unsubUrl}`,
  ].join("\n");
  const html = paragraphs(
    escapeHtml(intro),
    ...(countLine ? [escapeHtml(countLine)] : []),
    ...(changesLine ? [escapeHtml(changesLine)] : []),
  ) +
    (headlines.length > 0 ? `<ul>${headlines.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>` : "") +
    paragraphs(
      escapeHtml(attribution),
      `${lost} <a href="${escapeHtml(contactUrl)}">${escapeHtml(contactUrl)}</a>`,
      `<span style="color:#666;font-size:0.85em;">${footer} <a href="${escapeHtml(unsubUrl)}">Unsubscribe from edition notices</a></span>`,
    );
  return { subject, text, html, unsubscribeUrl: unsubUrl };
}
