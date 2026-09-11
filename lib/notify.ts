import { and, eq, gte, inArray } from "drizzle-orm";
import { Resend } from "resend";

import { getDb } from "@/lib/db/client";
import { facilitiesTable, facilityHistoryTable, subscriptionsTable } from "@/lib/db/schema";
import { escapeHtml, sendChangeNotification } from "@/lib/email";
import { siteConfig } from "@/lib/site";
import { STATUS_META } from "@/lib/status";
import { stateNameFromCode } from "@/lib/us-states";
import type { Facility } from "@/lib/schema";

/**
 * One subscriber's view of one facility's change — the unit `groupChangesByRecipient`
 * groups by `email`. Deliberately flat and gather-agnostic: nothing here assumes
 * "changes for one facility in one publish run." Theme D's monthly state digest
 * (`buildStateDigestChanges` below) builds the same shape from a different
 * query (a state WHERE clause, a calendar trigger instead of a publish
 * trigger) and feeds it through this identical grouping + send path — but see
 * `stateName` below: the SHAPE is shared, the COPY is not, because the two
 * origins carry different truths about why the recipient is being emailed.
 */
export interface RecipientFacilityChange {
  email: string;
  unsubscribeToken: string;
  facilityName: string;
  facilitySlug: string;
  changeLabel: string;
  status: string;
  /**
   * Set ONLY by `buildStateDigestChanges` (Theme D's monthly state digest) —
   * the full name of the state this change belongs to (e.g. "Virginia").
   * `sendGroupedChangeNotifications` uses its presence as the discriminator
   * for which copy template to use: absent means the original
   * per-facility-watch framing (byte-identical, unchanged); present means
   * the state-digest framing (`sendStateDigestEmail`), which must name the
   * state, state the monthly cadence, and — critically — render exactly ONE
   * unsubscribe link per email even when several facilities in that state
   * changed. That last point is not cosmetic: a state-digest recipient has
   * exactly ONE subscription row (one email + one state), so every change in
   * their group carries that SAME row's `unsubscribeToken` — unlike a
   * facility-watch group, where each change is a DIFFERENT subscription row
   * with its own token. Rendering N identical links each labelled
   * "unsubscribe from this one" (correct for facility-watch, since its N
   * changes really are N distinct subscriptions) would be false for a state
   * digest: every one of those N links would silently unsubscribe the
   * recipient from the WHOLE state, not "this one" facility.
   */
  stateName?: string;
}

export interface RecipientChangeGroup {
  email: string;
  changes: Omit<RecipientFacilityChange, "email">[];
}

/**
 * Groups a flat list of (recipient, change) pairs into one send-unit per
 * DISTINCT `keyFn(change)`, so a caller can send ONE email per group instead
 * of one per change. Pure — no I/O, no facility-fetching assumptions — so
 * it is reusable wherever the (recipient, change) pairs come from.
 *
 * Defaults to grouping by `email` alone — the facility-watch path
 * (`notifySubscribersOfChange(s)`) relies on this default unchanged: a
 * subscriber watching several facilities still gets ONE combined email
 * (Theme A's original point), regardless of which distinct facilities
 * changed.
 *
 * Theme D's monthly state digest overrides `keyFn` to `email + state` (see
 * `notifyStateSubscribersMonthly`), because a recipient can hold subscriptions
 * to MULTIPLE states — grouping those together under `email` alone would
 * merge two states' facilities into one email under a single, arbitrarily-
 * chosen state label and unsubscribe token (a real defect this caught during
 * Theme D review, round 2): the label would misname half the content, and
 * the one link rendered would silently kill whichever of the reader's several
 * subscriptions happened to sort first, not the one they think they're
 * leaving. Keying by `email + state` instead gives each subscription its own
 * group, so each email is self-consistent — one state, one label, one token.
 */
export function groupChangesByRecipient(
  changes: RecipientFacilityChange[],
  keyFn: (change: RecipientFacilityChange) => string = (change) => change.email
): RecipientChangeGroup[] {
  const groups = new Map<string, RecipientChangeGroup>();
  for (const change of changes) {
    const key = keyFn(change);
    const { email, ...rest } = change;
    const existing = groups.get(key);
    if (existing) {
      existing.changes.push(rest);
    } else {
      groups.set(key, { email, changes: [rest] });
    }
  }
  return [...groups.values()];
}

/**
 * Sends one email per recipient group, selecting the template by ORIGIN
 * first, then by count:
 *
 * 1. A state-digest group (any change carries `stateName` — see that field's
 *    doc comment) always goes to `sendStateDigestEmail`, REGARDLESS of how
 *    many changes it has. A single-change state digest must still say "your
 *    monthly Virginia digest," never the facility-watch template's "the
 *    record you're watching changed" — that recipient never watched a
 *    record, they watched a state.
 * 2. Otherwise (a facility-watch group), the original logic: the
 *    single-facility template (`sendChangeNotification`, unchanged
 *    content/copy) for exactly one change, or the multi-facility digest
 *    below for more than one.
 *
 * All three send helpers are already non-throwing internally.
 *
 * NOTE (MVP scale, security-reviewed, carried over from the original
 * per-subscriber loop): sends run sequentially and inline within the caller
 * (`approveSubmission` or `db:sync`'s apply path), so a large confirmed-
 * subscriber set slows the caller's response. Fine at current volumes; move
 * to a queue / background send if subscriber counts grow.
 */
async function sendGroupedChangeNotifications(groups: RecipientChangeGroup[]): Promise<void> {
  for (const group of groups) {
    const stateName = group.changes[0]?.stateName;
    // Defense-in-depth, purely additive: every change in a state-digest
    // group must share the SAME state — the (email, state) grouping key
    // `notifyStateSubscribersMonthly` passes guarantees this today (see
    // groupChangesByRecipient's doc comment). If a future caller ever
    // groups state-digest changes by email alone again (the exact regression
    // this guard exists to catch), refuse to send rather than silently
    // mailing a merged, mislabelled digest — no email address logged, per
    // this file's existing convention.
    if (stateName && group.changes.some((c) => c.stateName !== stateName)) {
      console.error(
        "sendGroupedChangeNotifications: a group mixed multiple states — refusing to send a mislabelled digest"
      );
      continue;
    }
    if (stateName) {
      await sendStateDigestEmail(group.email, stateName, group.changes);
    } else if (group.changes.length === 1) {
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

  // Each change here is a DISTINCT facility-watch subscription row, so each
  // carries its OWN unsubscribeToken — every list item gets its own
  // unsubscribe link, and unsubscribing from one watch never silently
  // touches the recipient's other watches. This invariant holds because a
  // facility-watch group is N rows (one per facility). Contrast
  // `sendStateDigestEmail` below: a state-digest group is exactly ONE row
  // (one email + one state) shared across every change, which is why it
  // renders a single unsubscribe link instead of one per item.
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
 * Composes and sends the monthly state-digest email (Theme D, D3a) — the
 * state-digest counterpart to `sendChangeDigestEmail` above, deliberately NOT
 * a copy-paste of it. The two are the same SHAPE (a recipient, a list of
 * facility changes) but different TRUTHS: a facility-watch recipient asked to
 * be told about specific records; a state-digest recipient asked to be told
 * about a state. This copy:
 *   - names the state and states the monthly cadence, instead of implying a
 *     per-facility watch the recipient never set up;
 *   - renders exactly ONE unsubscribe link, not one per change — a
 *     state-digest recipient has exactly ONE subscription row (one email +
 *     one state), so every `changes` entry here carries that SAME row's
 *     `unsubscribeToken`. Taking it once (from the first change) and never
 *     labelling it "unsubscribe from this one" avoids the false claim that
 *     clicking it only mutes one facility, when it actually unsubscribes the
 *     recipient from the whole state.
 *
 * Never throws — same contract as `sendChangeDigestEmail`.
 */
async function sendStateDigestEmail(
  email: string,
  stateName: string,
  changes: RecipientChangeGroup["changes"]
): Promise<{ sent: boolean }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("RESEND_API_KEY not set — skipping state digest email send");
    return { sent: false };
  }

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? siteConfig.url;
  const from = process.env.EMAIL_FROM ?? "Compute Atlas <alerts@compute-atlas.com>";
  const facilityWord = changes.length === 1 ? "facility" : "facilities";
  const subject = `${changes.length} ${facilityWord} changed in ${stateName} — Compute Atlas monthly digest`;

  // Every change in a state-digest group shares ONE subscription row (one
  // email + one state), so its unsubscribeToken is identical across all of
  // them — take it once rather than repeating an identical link per item.
  const unsubscribeToken = changes[0].unsubscribeToken;
  const unsubUrl = `${base}/api/subscribe/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;

  const textItems = changes.map((c) => {
    const url = `${base}/facilities/${c.facilitySlug}`;
    return `- ${c.facilityName} — ${c.changeLabel} (now ${c.status}): ${url}`;
  });
  const text = `Your monthly Compute Atlas digest for ${stateName}: ${changes.length} tracked ${facilityWord} changed this period.\n\n${textItems.join("\n")}\n\nYou're receiving this because you subscribed to a monthly digest for ${stateName} on Compute Atlas. Unsubscribe from this state's digest: ${unsubUrl}`;

  const htmlItems = changes
    .map((c) => {
      const url = `${base}/facilities/${c.facilitySlug}`;
      return `<li><strong>${escapeHtml(c.facilityName)}</strong> — ${escapeHtml(c.changeLabel)} (now ${escapeHtml(c.status)}). <a href="${escapeHtml(url)}">View it</a></li>`;
    })
    .join("");
  const html = `<p>Your monthly Compute Atlas digest for <strong>${escapeHtml(stateName)}</strong>: ${changes.length} tracked ${facilityWord} changed this period.</p><ul>${htmlItems}</ul><p style="color:#666;font-size:0.85em;">You're receiving this because you subscribed to a monthly digest for ${escapeHtml(stateName)} on Compute Atlas. <a href="${escapeHtml(unsubUrl)}">Unsubscribe from this state's digest</a></p>`;

  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      from,
      to: email,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (result.error) {
      console.error("sendStateDigestEmail failed:", result.error?.name ?? "unknown");
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("sendStateDigestEmail failed:", error instanceof Error ? error.name : "unknown");
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

/**
 * Builds the flat (recipient, change) pairs for the monthly state digest:
 * every CONFIRMED state-target subscriber, crossed with every facility in
 * their state that changed (created or updated) since `since`. Pure query +
 * shape assembly — no sending — so it's independently testable from
 * `notifyStateSubscribersMonthly` below.
 *
 * Joins facility_history to facilities on facilityId to recover each
 * change's current name/state/status, so a facility DELETED since `since`
 * is NOT represented here — its facilities row is gone, so there is nothing
 * to join against. Same loose-coupling tradeoff facilityHistoryTable's own
 * schema comment documents for facilityId (no FK). For the same reason,
 * changeType is restricted to create|update: a delete's pre-deletion
 * name/state can't be recovered without a facilities row either. A facility
 * that changed more than once in the period is deduped to its single most
 * recent change, so a recipient sees one line per facility, not one per edit.
 */
async function buildStateDigestChanges(since: Date): Promise<RecipientFacilityChange[]> {
  const db = getDb();

  const subs = await db
    .select({
      email: subscriptionsTable.email,
      unsubscribeToken: subscriptionsTable.unsubscribeToken,
      state: subscriptionsTable.targetId,
    })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.status, "confirmed"), eq(subscriptionsTable.targetType, "state")));

  if (subs.length === 0) return [];

  const states = [...new Set(subs.map((s) => s.state).filter((s): s is string => s !== null))];
  if (states.length === 0) return [];

  const historyRows = await db
    .select({
      facilityId: facilityHistoryTable.facilityId,
      changeType: facilityHistoryTable.changeType,
      changedAt: facilityHistoryTable.changedAt,
      facilityName: facilitiesTable.name,
      facilityState: facilitiesTable.state,
      facilityDoc: facilitiesTable.doc,
    })
    .from(facilityHistoryTable)
    .innerJoin(facilitiesTable, eq(facilityHistoryTable.facilityId, facilitiesTable.id))
    .where(
      and(
        gte(facilityHistoryTable.changedAt, since),
        inArray(facilityHistoryTable.changeType, ["create", "update"]),
        inArray(facilitiesTable.state, states)
      )
    );

  const latestByFacility = new Map<string, (typeof historyRows)[number]>();
  for (const row of historyRows) {
    const existing = latestByFacility.get(row.facilityId);
    if (!existing || row.changedAt > existing.changedAt) {
      latestByFacility.set(row.facilityId, row);
    }
  }

  const changesByState = new Map<string, Array<Omit<RecipientFacilityChange, "email" | "unsubscribeToken">>>();
  for (const row of latestByFacility.values()) {
    const list = changesByState.get(row.facilityState) ?? [];
    list.push({
      facilityName: row.facilityName,
      facilitySlug: row.facilityId,
      changeLabel: row.changeType === "create" ? "added to the atlas" : "record updated",
      status: STATUS_META[row.facilityDoc.status].label,
    });
    changesByState.set(row.facilityState, list);
  }

  const recipientChanges: RecipientFacilityChange[] = [];
  for (const sub of subs) {
    if (!sub.state) continue;
    const changes = changesByState.get(sub.state);
    if (!changes) continue;
    // sub.state is always a validated, uppercased code by construction
    // (subscribeToTarget normalizes it via stateNameFromCode before
    // storing) — the `?? sub.state` fallback is defense-in-depth only, never
    // expected to trigger.
    const stateName = stateNameFromCode(sub.state) ?? sub.state;
    for (const change of changes) {
      recipientChanges.push({
        email: sub.email,
        unsubscribeToken: sub.unsubscribeToken,
        stateName,
        ...change,
      });
    }
  }

  return recipientChanges;
}

/**
 * Monthly state-digest entry point (Theme D, D3a). Builds the same
 * `RecipientFacilityChange` shape the per-facility path above builds, from a
 * state-scoped `facility_history` query (`buildStateDigestChanges`), then
 * feeds it through the IDENTICAL `groupChangesByRecipient` +
 * `sendGroupedChangeNotifications` path — no second grouping or send
 * implementation, per this file's `RecipientFacilityChange` header comment,
 * which names this exact function in advance. `since` is the digest period's
 * start (inclusive, via `>=`) — the caller decides what that means (e.g. "30
 * days ago" or "since the last digest run").
 *
 * Only `status='confirmed' AND targetType='state'` rows are ever read —
 * pending and unsubscribed rows are excluded identically to
 * `notifySubscribersOfChange(s)` above. Every recipient email still embeds
 * their OWN raw `unsubscribeToken` via the shared send path, so every digest
 * carries a working unsubscribe link.
 *
 * ⚠️ NOT CALLED FROM ANY SCHEDULED TRIGGER (D3b is deliberately out of scope
 * for this unit — see the plan). One confirmed state-target subscriber
 * predates this feature and has never received mail from Compute Atlas;
 * their state's `facility_history` since `since` will match if this function
 * is ever invoked. Whoever wires a scheduled caller to this function is
 * choosing to resume mail to that subscriber after a long silence — that is
 * a call for Ed to make at trigger time, not one this function makes.
 *
 * Best-effort and never throws — same contract as `notifySubscribersOfChange`.
 */
export async function notifyStateSubscribersMonthly(since: Date): Promise<void> {
  try {
    const changes = await buildStateDigestChanges(since);
    // Grouped by (email, state), NOT email alone — a recipient can hold
    // subscriptions to multiple states, and each must get its own,
    // self-consistent email (see groupChangesByRecipient's doc comment).
    await sendGroupedChangeNotifications(
      groupChangesByRecipient(changes, (c) => `${c.email}::${c.stateName ?? ""}`)
    );
  } catch (err) {
    // Never log email addresses or tokens here — only the error.
    console.error("notifyStateSubscribersMonthly failed", err);
  }
}
