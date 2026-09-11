import { and, eq, inArray } from "drizzle-orm";
import { Resend } from "resend";

import { getDb } from "@/lib/db/client";
import { subscriptionsTable } from "@/lib/db/schema";
import { escapeHtml, sendChangeNotification } from "@/lib/email";
import { siteConfig } from "@/lib/site";
import { STATUS_META } from "@/lib/status";
import type { Facility } from "@/lib/schema";

/**
 * One subscriber's view of one facility's change — the unit `groupChangesByRecipient`
 * groups by `email`. Deliberately flat and gather-agnostic: nothing here assumes
 * "changes for one facility in one publish run." A later theme's monthly
 * state/metro digest builds the same shape from a different query (a
 * state/metro WHERE clause, a calendar trigger instead of a publish trigger)
 * and feeds it through this identical grouping + send path.
 */
export interface RecipientFacilityChange {
  email: string;
  unsubscribeToken: string;
  facilityName: string;
  facilitySlug: string;
  changeLabel: string;
  status: string;
}

export interface RecipientChangeGroup {
  email: string;
  changes: Omit<RecipientFacilityChange, "email">[];
}

/**
 * Groups a flat list of (recipient, change) pairs by recipient email so a
 * caller can send ONE email per recipient instead of one per change. Pure —
 * no I/O, no facility-fetching assumptions — so it is reusable wherever the
 * (recipient, change) pairs come from.
 */
export function groupChangesByRecipient(
  changes: RecipientFacilityChange[]
): RecipientChangeGroup[] {
  const groups = new Map<string, RecipientChangeGroup["changes"]>();
  for (const { email, ...change } of changes) {
    const existing = groups.get(email);
    if (existing) {
      existing.push(change);
    } else {
      groups.set(email, [change]);
    }
  }
  return [...groups.entries()].map(([email, groupChanges]) => ({ email, changes: groupChanges }));
}

/**
 * Sends one email per recipient group: the existing single-facility template
 * (`sendChangeNotification`, unchanged content/copy) when a recipient has
 * exactly one change, or the multi-facility digest below when they have more
 * than one. Both are already non-throwing internally.
 *
 * NOTE (MVP scale, security-reviewed, carried over from the original
 * per-subscriber loop): sends run sequentially and inline within the caller
 * (`approveSubmission` or `db:sync`'s apply path), so a large confirmed-
 * subscriber set slows the caller's response. Fine at current volumes; move
 * to a queue / background send if subscriber counts grow.
 */
async function sendGroupedChangeNotifications(groups: RecipientChangeGroup[]): Promise<void> {
  for (const group of groups) {
    if (group.changes.length === 1) {
      const change = group.changes[0];
      await sendChangeNotification({
        email: group.email,
        facilityName: change.facilityName,
        facilitySlug: change.facilitySlug,
        changeLabel: change.changeLabel,
        status: change.status,
        unsubscribeToken: change.unsubscribeToken,
      });
    } else {
      await sendChangeDigestEmail(group.email, group.changes);
    }
  }
}

/**
 * Composes and sends the multi-facility digest email for a recipient with
 * more than one change in a single run. Kept local to this file rather than
 * added to `lib/email.ts`. `escapeHtml` IS shared — it is exported from
 * lib/email.ts and imported above, so the XSS defense has exactly one
 * definition. The remaining send plumbing below (address resolution, Resend
 * client construction) is still a deliberate, minimal duplication of
 * lib/email.ts's private `fromAddress` / `getResend`. Theme D's monthly
 * digest needs the same sender, and hoisting a shared send primitive is
 * tracked as a fast-follow for that theme.
 *
 * Never throws — same contract as `sendChangeNotification` — so a failed
 * digest send can never turn a successful publish into an error.
 */
async function sendChangeDigestEmail(
  email: string,
  changes: RecipientChangeGroup["changes"]
): Promise<{ sent: boolean }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("RESEND_API_KEY not set — skipping change digest email send");
    return { sent: false };
  }

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? siteConfig.url;
  const from = process.env.EMAIL_FROM ?? "Compute Atlas <alerts@compute-atlas.com>";
  const subject = `${changes.length} updates on facilities you're watching — Compute Atlas`;

  // Each change carries its OWN unsubscribeToken (one per subscription row),
  // so every list item gets its own unsubscribe link — unsubscribing from one
  // watch never silently touches the recipient's other watches.
  const textItems = changes.map((c) => {
    const url = `${base}/facilities/${c.facilitySlug}`;
    const unsubUrl = `${base}/api/subscribe/unsubscribe?token=${encodeURIComponent(c.unsubscribeToken)}`;
    return `- ${c.facilityName} — ${c.changeLabel} (now ${c.status}): ${url} (unsubscribe from this one: ${unsubUrl})`;
  });
  const text = `${changes.length} records you're watching changed on Compute Atlas:\n\n${textItems.join("\n")}`;

  const htmlItems = changes
    .map((c) => {
      const url = `${base}/facilities/${c.facilitySlug}`;
      const unsubUrl = `${base}/api/subscribe/unsubscribe?token=${encodeURIComponent(c.unsubscribeToken)}`;
      return `<li><strong>${escapeHtml(c.facilityName)}</strong> — ${escapeHtml(c.changeLabel)} (now ${escapeHtml(c.status)}). <a href="${escapeHtml(url)}">View it</a> · <a href="${escapeHtml(unsubUrl)}">Unsubscribe from this one</a></li>`;
    })
    .join("");
  const html = `<p>${changes.length} records you're watching changed on Compute Atlas:</p><ul>${htmlItems}</ul>`;

  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({ from, to: email, subject, text, html });
    if (result.error) {
      console.error("sendChangeDigestEmail failed:", result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("sendChangeDigestEmail failed:", error instanceof Error ? error.name : "unknown");
    return { sent: false };
  }
}

/**
 * Notifies every subscriber watching this facility that it changed. This is
 * the double-opt-in enforcement boundary: only `status='confirmed'` rows are
 * ever selected, so pending (unconfirmed) and unsubscribed rows never
 * receive mail (see lib/db/schema.ts subscriptionsTable comment and
 * lib/notify.integration.test.ts).
 *
 * Single-facility entry point — unchanged signature/behavior, still the one
 * `lib/submissions.ts:150`'s approve path calls. An approval is always
 * exactly one facility, so there is never more than one change per recipient
 * within a single call here; grouping is still run for consistency with
 * `notifySubscribersOfChanges` below, but it is always a no-op batching-wise
 * and every recipient still gets `sendChangeNotification`'s original
 * single-facility email, unchanged.
 *
 * Best-effort and never throws — a notification failure must not turn a
 * successful approval into an error. The try/catch here is belt-and-suspenders
 * around the query itself (e.g. a transient DB error) on top of the
 * already-non-throwing send helpers.
 */
export async function notifySubscribersOfChange(
  facility: Facility,
  changeLabel: string
): Promise<void> {
  try {
    const db = getDb();

    const rows = await db
      .select({
        email: subscriptionsTable.email,
        unsubscribeToken: subscriptionsTable.unsubscribeToken,
      })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.status, "confirmed"),
          eq(subscriptionsTable.targetType, "facility"),
          eq(subscriptionsTable.targetId, facility.id)
        )
      );

    const statusLabel = STATUS_META[facility.status].label;

    const recipientChanges: RecipientFacilityChange[] = rows.map((row) => ({
      email: row.email,
      unsubscribeToken: row.unsubscribeToken,
      facilityName: facility.name,
      facilitySlug: facility.id,
      changeLabel,
      status: statusLabel,
    }));

    await sendGroupedChangeNotifications(groupChangesByRecipient(recipientChanges));
  } catch (err) {
    // Never log email addresses or tokens here — only the error.
    console.error("notifySubscribersOfChange failed", err);
  }
}

/** One facility's change, as fed into `notifySubscribersOfChanges`. */
export interface FacilityChange {
  facility: Facility;
  changeLabel: string;
}

/**
 * Batched sibling of `notifySubscribersOfChange`, for callers that publish
 * MANY facilities in a single run — today, `scripts/sync-to-neon.ts`'s apply
 * path. Queries every relevant facility's subscribers in one round trip, then
 * groups by recipient with `groupChangesByRecipient` so a subscriber watching
 * several of this run's changed facilities gets ONE email, not one per
 * facility. `notifySubscribersOfChange` above stays the single-facility entry
 * point `lib/submissions.ts:150` already calls — unchanged, since an approval
 * is always exactly one facility, so there is nothing to batch there.
 *
 * Best-effort and never throws — same contract as `notifySubscribersOfChange`.
 */
export async function notifySubscribersOfChanges(changes: FacilityChange[]): Promise<void> {
  if (changes.length === 0) return;

  try {
    const db = getDb();
    const facilityById = new Map(changes.map((c) => [c.facility.id, c.facility]));
    const changeLabelById = new Map(changes.map((c) => [c.facility.id, c.changeLabel]));

    const rows = await db
      .select({
        email: subscriptionsTable.email,
        unsubscribeToken: subscriptionsTable.unsubscribeToken,
        targetId: subscriptionsTable.targetId,
      })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.status, "confirmed"),
          eq(subscriptionsTable.targetType, "facility"),
          inArray(subscriptionsTable.targetId, [...facilityById.keys()])
        )
      );

    const recipientChanges: RecipientFacilityChange[] = [];
    for (const row of rows) {
      if (row.targetId === null) continue;
      const facility = facilityById.get(row.targetId);
      const changeLabel = changeLabelById.get(row.targetId);
      if (!facility || changeLabel === undefined) continue;

      recipientChanges.push({
        email: row.email,
        unsubscribeToken: row.unsubscribeToken,
        facilityName: facility.name,
        facilitySlug: facility.id,
        changeLabel,
        status: STATUS_META[facility.status].label,
      });
    }

    await sendGroupedChangeNotifications(groupChangesByRecipient(recipientChanges));
  } catch (err) {
    console.error("notifySubscribersOfChanges failed", err);
  }
}
