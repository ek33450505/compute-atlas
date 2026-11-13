import { and, eq, gte, inArray, lt } from "drizzle-orm";

import { canonicalCountyName, countySlug } from "@/lib/counties";
import { formatCountyLabel, getMetroBySlug, metroCountyKey } from "@/lib/metros";

import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { emailSendsTable, facilitiesTable, facilityHistoryTable, subscriptionsTable } from "@/lib/db/schema";
import { sendAreaDigestEmail, sendChangeDigestEmail, sendChangeNotification, type AreaDigestType } from "@/lib/email";
import { sendGated, type GateResult, type GatedSend } from "@/lib/email-gate";
import type { SendOutcome } from "@/lib/email";
import { DATASET_NOTICE_PACE_MS, makePacer, realSleep } from "@/lib/send-pacer";
import { sendWithTimeout } from "@/lib/send-timeout";
import {
  claimDigestWindow,
  completeDigestWindow,
  STALE_DIGEST_RUN_MS,
  takeOverStaleDigestRun,
} from "@/lib/state-digest-ledger";
import { STATUS_META } from "@/lib/status";
import { subscriptionSuppressedSql } from "@/lib/suppressions";
import { stateNameFromCode } from "@/lib/us-states";
import { WATCH_TARGET, watchAreasEnabled } from "@/lib/watch-target-types";
import type { Facility } from "@/lib/schema";

/**
 * Drops recipient rows the suppression list blocks and logs how many, with no
 * address. The send gate (lib/email-gate.ts) re-checks every row at send time,
 * so this is the first of two checks, not the only one. A failed
 * suppression subquery fails the whole recipient query instead, so an error
 * means nobody is mailed.
 */
function dropOptedOut<T extends { optedOut: boolean }>(rows: T[]): Omit<T, "optedOut">[] {
  const kept = rows.filter((r) => !r.optedOut);
  if (kept.length < rows.length) {
    console.warn(`notify: skipped ${rows.length - kept.length} suppressed recipient row(s)`);
  }
  return kept.map((row) => {
    const { optedOut, ...rest } = row;
    void optedOut;
    return rest;
  });
}

/** Resend's error name for hitting its ~2 requests/second limit, as persisted by `safeErrorCode`. */
const RATE_LIMIT_CODE = "rate_limit_exceeded";

/**
 * A send that has not settled after this long is abandoned (counted not sent, `send_timeout`). Applies to every
 * path through `sendGatedPacedWithRetry`, the approve path included. A timeout is NOT retried: only a rate
 * limit is, and the abandoned call may still have reached the recipient.
 */
export const NOTIFY_SEND_TIMEOUT_MS = 20_000;

/**
 * `email_sends.error_code` values that prove the provider REJECTED the request before accepting a message, so a
 * resumed digest may safely send again. Only `rate_limit_exceeded`: Resend answers 429 without queuing the mail
 * (`sendGatedPacedWithRetry` below relies on the same fact to retry). Do not add a code unless it is a rejection
 * before acceptance: `send_timeout` and `send_threw` (lib/email-gate.ts) happen AFTER the request may have left.
 */
const PRE_ACCEPTANCE_ERROR_CODES: ReadonlySet<string> = new Set([RATE_LIMIT_CODE]);

/** Wait before the single retry of a rate-limited send. */
const RATE_LIMIT_RETRY_MS = 1000;

/**
 * Bound on how long ONE group started just before the deadline can run. The real worst paths are (a) pace +
 * the 20 s send timeout, or (b) a fast 429 + 1 s retry wait + pace + the 20 s timeout (a rate-limited first
 * attempt returns quickly, it does not burn a full timeout). Both are about 22 s plus DB time. The constant
 * below is deliberately CONSERVATIVE: it budgets two full timeouts (about 57 s with a 15 s DB allowance), which
 * still bounds the real paths. Derived, not measured.
 */
export const DIGEST_GROUP_WORST_CASE_MS =
  2 * (DATASET_NOTICE_PACE_MS + NOTIFY_SEND_TIMEOUT_MS) + RATE_LIMIT_RETRY_MS + 15_000;

/**
 * `sendGated` with pacing and one retry on a Resend rate limit. The pace runs inside the send callback, so a
 * send the gate skips costs no wait. A rate-limited attempt is retried exactly once by calling `sendGated`
 * again, so suppression and status are re-read before the second send; each attempt leaves its own
 * `email_sends` row (first `error`/`rate_limit_exceeded`, then the final outcome).
 */
async function sendGatedPacedWithRetry(
  db: ReturnType<typeof getDb>,
  gated: GatedSend,
  send: () => Promise<SendOutcome>,
  pace: () => Promise<void>,
  sleep: (ms: number) => Promise<void>
): Promise<GateResult> {
  let rateLimited = false;
  const attempt = async (): Promise<GateResult> => {
    rateLimited = false;
    const result = await sendGated(db, gated, async () => {
      await pace();
      const outcome = await sendWithTimeout(send, NOTIFY_SEND_TIMEOUT_MS);
      rateLimited = !outcome.sent && "errorCode" in outcome && outcome.errorCode === RATE_LIMIT_CODE;
      return outcome;
    });
    return result;
  };
  const first = await attempt();
  if (!rateLimited) return first;
  await sleep(RATE_LIMIT_RETRY_MS);
  return attempt();
}

/**
 * One subscriber's view of one facility's change — the unit `groupChangesByRecipient`
 * groups by `email`. Deliberately flat and gather-agnostic: nothing here assumes
 * "changes for one facility in one publish run." Theme D's monthly state digest
 * (`buildAreaDigestChanges` below) builds the same shape from a different
 * query (a state WHERE clause, a calendar trigger instead of a publish
 * trigger) and feeds it through this identical grouping + send path — but see
 * `origin` below: the SHAPE is shared, the COPY is not, because the two
 * origins carry different truths about why the recipient is being emailed.
 */
interface RecipientChangeBase {
  /** The subscription row this change was selected for; the send gate re-reads it by id. */
  subscriptionId: string;
  email: string;
  unsubscribeToken: string;
  facilityName: string;
  facilitySlug: string;
  changeLabel: string;
  status: string;
}

/**
 * A discriminated union on `origin`, REQUIRED — not inferred from an optional
 * field's presence. This used to be one flat interface with an optional
 * `stateName?: string`, whose mere presence was the only signal
 * `sendGroupedChangeNotifications` had for which copy template to send. That
 * shape could be built wrongly: a future caller could assemble a
 * state-digest batch and simply forget to set `stateName` — an internally
 * consistent group (single state, no mixing) that passes the runtime
 * mixed-state guard below and silently gets the WRONG copy, because omitting
 * an optional field is not an error. Making `origin` required turns that
 * mistake into a compile error instead: there is no way to construct a
 * `RecipientFacilityChange` without choosing a branch, and the
 * `"area-digest"` branch cannot be constructed without `areaType`, `areaId`
 * and `areaName` either (they replaced `stateName` when county and metro
 * digests were added, A-3 unit 8b).
 *
 * - `"facility-watch"`: the original per-facility-watch framing
 *   (byte-identical, unchanged) — the recipient explicitly watched this
 *   record. The area fields do not exist on this branch.
 * - `"area-digest"`: built ONLY by `buildAreaDigestChanges` (Theme D's
 *   monthly digest for a state, county or metro) — routes to
 *   `sendAreaDigestEmail`, which must name the area, state the monthly
 *   cadence, and — critically — render exactly ONE unsubscribe link per
 *   email even when several facilities in that area changed. That last
 *   point is not cosmetic: an area-digest recipient has exactly ONE
 *   subscription row (one email + one area), so
 *   every change in their group carries that SAME row's `unsubscribeToken`
 *   — unlike a facility-watch group, where each change is a DIFFERENT
 *   subscription row with its own token. Rendering N identical links each
 *   labelled "unsubscribe from this one" (correct for facility-watch, since
 *   its N changes really are N distinct subscriptions) would be false for a
 *   state digest: every one of those N links would silently unsubscribe the
 *   recipient from the WHOLE area, not "this one" facility. `areaType`,
 *   `areaId` and `areaName` are REQUIRED on this branch for the same reason
 *   `origin` itself is required — so the wrong copy (a county named as a
 *   state, a metro mislabelled) can never be built by omission. `areaId`
 *   exists for the mixed-group guard: two counties both produce
 *   `origin: "area-digest"` with `areaType: "county"`, and only the id tells
 *   them apart.
 */
export type RecipientFacilityChange =
  | ({ origin: "facility-watch" } & RecipientChangeBase)
  | ({
      origin: "area-digest";
      areaType: AreaDigestType;
      areaId: string;
      areaName: string;
    } & RecipientChangeBase);

/**
 * `Omit<UnionType, K>` does NOT distribute over a discriminated union's
 * branches — TypeScript's built-in `Omit` collapses to the union's COMMON
 * keys, which would silently drop `areaName` (present on only one branch)
 * from the result. This distributes the omission per-branch instead, so
 * `RecipientChangeGroup["changes"]` stays a proper discriminated union.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RecipientChangeGroup {
  email: string;
  changes: DistributiveOmit<RecipientFacilityChange, "email">[];
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
 * Theme D's monthly area digest overrides `keyFn` to `email + areaType + areaId` (see
 * `notifyStateSubscribersMonthly`), because a recipient can hold subscriptions
 * to MULTIPLE states — grouping those together under `email` alone would
 * merge two states' facilities into one email under a single, arbitrarily-
 * chosen state label and unsubscribe token (a real defect this caught during
 * Theme D review, round 2): the label would misname half the content, and
 * the one link rendered would silently kill whichever of the reader's several
 * subscriptions happened to sort first, not the one they think they're
 * leaving. Keying by `email + areaType + areaId` instead gives each subscription its own
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
 * 1. An area-digest group (`origin === "area-digest"` on its changes — see
 *    the `RecipientFacilityChange` union's doc comment) always goes to
 *    `sendAreaDigestEmail`, REGARDLESS of how many changes it has. A
 *    single-change state digest must still say "your monthly Virginia
 *    digest," never the facility-watch template's "the record you're
 *    watching changed" — that recipient never watched a record, they
 *    watched a state.
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
 *
 * Returns the number of groups whose send helper reported success, so a
 * caller that must report what actually happened can (see
 * `notifyStateSubscribersMonthly`). Deliberately counts SENDS, not groups:
 * a group skipped by the mixed-state guard below, or one whose send failed
 * (a Resend error, or no `RESEND_API_KEY`), must not be counted as mail that
 * went out. The two facility-watch callers ignore the value; their contract
 * is unchanged.
 *
 * EXPORTED FOR TESTS ONLY — no production caller outside this file, and none
 * should be added. Exported for the same reason `buildStakeholderIndex` in
 * lib/data.ts is: the mixed-state guard below is unreachable through every
 * current caller (the (email, state) grouping key makes a mixed group
 * impossible to construct), so the only way to prove the guard actually
 * fires — and keep a later refactor from deleting it as dead code — is to
 * call this directly with a synthetic mixed group. What that guard prevents
 * is not cosmetic: a mislabelled digest whose per-item "unsubscribe from this
 * one" link would silently unsubscribe the reader from a whole state.
 */
export async function sendGroupedChangeNotifications(
  groups: RecipientChangeGroup[],
  runId?: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  // Only `sleep` is forwarded: this is the approve path, which must never carry a deadline.
  return (await sendGroupedChangeNotificationsUntil(groups, runId, { sleep: opts.sleep })).sent;
}

export interface GroupedSendProgress {
  /** Emails the gate reported sent. */
  sent: number;
  /** Groups this run got to (sent, skipped or failed) before stopping. */
  handled: number;
  /** The deadline passed with groups still unstarted. */
  stoppedEarly: boolean;
}

/**
 * `sendGroupedChangeNotifications` with an optional deadline: once `opts.now() >= opts.deadline` (epoch ms) no
 * further group is STARTED (a send already in flight is bounded by `NOTIFY_SEND_TIMEOUT_MS`). The monthly digest
 * uses it so a platform kill becomes a recorded, incomplete run; the approve path calls the plain wrapper above.
 */
export async function sendGroupedChangeNotificationsUntil(
  groups: RecipientChangeGroup[],
  runId?: string,
  opts: { sleep?: (ms: number) => Promise<void>; deadline?: number; now?: () => number } = {}
): Promise<GroupedSendProgress> {
  const db = getDb();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  // One pacer per run: every send that reaches Resend waits out the gap since the previous one.
  const pace = makePacer(undefined, sleep);
  // Named `sendGated` with the gate's own signature so the call sites below, and
  // lib/email-send-gate-guard.test.ts, still see every sender inside a gate callback.
  const sendGated = (gateDb: typeof db, gated: GatedSend, send: () => Promise<SendOutcome>) =>
    sendGatedPacedWithRetry(gateDb, gated, send, pace, sleep);
  let sentCount = 0;
  let handled = 0;
  for (const group of groups) {
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      return { sent: sentCount, handled, stoppedEarly: true };
    }
    handled++;
    const first = group.changes[0];
    // `groupChangesByRecipient` never emits an empty group, but read the
    // discriminator off a value that is guaranteed to exist rather than
    // re-indexing `group.changes[0]` (possibly stale/undefined) below.
    if (!first) continue;

    if (first.origin === "area-digest") {
      const { areaType, areaId, areaName } = first;
      // Defense-in-depth, purely additive: `origin` guarantees every change
      // in this branch IS an area digest (the type system enforces that at
      // construction time) — what it can't guarantee is that they all name
      // the SAME area, since two different areas both produce
      // `origin: "area-digest"` values. The (email, areaType, areaId)
      // grouping key `notifyStateSubscribersMonthly` passes guarantees that
      // today (see groupChangesByRecipient's doc comment). If a future
      // caller ever groups area-digest changes by email alone again (the
      // exact regression this guard exists to catch), refuse to send rather
      // than silently mailing a merged, mislabelled digest — no email
      // address logged, per this file's existing convention.
      if (
        group.changes.some(
          (c) =>
            c.origin !== "area-digest" ||
            c.areaType !== areaType ||
            c.areaId !== areaId ||
            c.areaName !== areaName
        )
      ) {
        console.error(
          "sendGroupedChangeNotifications: a group mixed multiple areas — refusing to send a mislabelled digest"
        );
        continue;
      }
      // Every area-digest email is attributed to the run that claimed its
      // window; without one there is nothing to attribute it to.
      if (!runId) {
        console.error("sendGroupedChangeNotifications: an area digest needs a run id — refusing to send");
        continue;
      }
      // An area-digest group is exactly one subscription row (see above).
      // State keeps its original ledger kind; county and metro are
      // `area_digest`.
      const { sent } = await sendGated(
        db,
        {
          kind: areaType === "state" ? "state_digest" : "area_digest",
          subscriptionId: first.subscriptionId,
          email: group.email,
          runId,
        },
        () => sendAreaDigestEmail(group.email, { type: areaType, name: areaName }, group.changes)
      );
      if (sent) sentCount++;
    } else if (group.changes.length === 1) {
      const { sent } = await sendGated(
        db,
        { kind: "facility_change", subscriptionId: first.subscriptionId, email: group.email },
        () =>
          sendChangeNotification({
            email: group.email,
            facilityName: first.facilityName,
            facilitySlug: first.facilitySlug,
            changeLabel: first.changeLabel,
            status: first.status,
            unsubscribeToken: first.unsubscribeToken,
          })
      );
      if (sent) sentCount++;
    } else {
      // One email lists N distinct watch rows: the gate checks every one of
      // them. The ANCHOR is the row whose token the digest's stop-all link and
      // List-Unsubscribe header carry (sendChangeDigestEmail reads
      // `changes[0]`), so it is both the gate's `subscriptionId` and the
      // first element passed to the sender.
      const [anchor, ...rest] = group.changes;
      const ordered = [anchor, ...rest];
      const { sent } = await sendGated(
        db,
        {
          kind: "facility_digest",
          subscriptionId: anchor.subscriptionId,
          email: group.email,
          coveredSubscriptionIds: ordered.map((c) => c.subscriptionId),
        },
        () => sendChangeDigestEmail(group.email, ordered)
      );
      if (sent) sentCount++;
    }
  }
  return { sent: sentCount, handled, stoppedEarly: false };
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
        subscriptionId: subscriptionsTable.id,
        email: subscriptionsTable.email,
        unsubscribeToken: subscriptionsTable.unsubscribeToken,
        optedOut: subscriptionSuppressedSql(),
      })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.status, "confirmed"),
          eq(subscriptionsTable.targetType, WATCH_TARGET.facility),
          eq(subscriptionsTable.targetId, facility.id)
        )
      )
      .then(dropOptedOut);

    const statusLabel = STATUS_META[facility.status].label;

    const recipientChanges: RecipientFacilityChange[] = rows.map((row) => ({
      origin: "facility-watch",
      subscriptionId: row.subscriptionId,
      email: row.email,
      unsubscribeToken: row.unsubscribeToken,
      facilityName: facility.name,
      facilitySlug: facility.id,
      changeLabel,
      status: statusLabel,
    }));

    await sendGroupedChangeNotifications(groupChangesByRecipient(recipientChanges));
  } catch (err) {
    // Log the error's NAME and SQLSTATE only (redactedErrorCode) — never the
    // raw error object (a Drizzle/Neon query error embeds its bound params in
    // .message) and never email addresses or tokens.
    console.error(`notifySubscribersOfChange failed: ${err instanceof Error ? err.name : "unknown"} (sqlstate: ${redactedErrorCode(err)})`);
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
        subscriptionId: subscriptionsTable.id,
        email: subscriptionsTable.email,
        unsubscribeToken: subscriptionsTable.unsubscribeToken,
        targetId: subscriptionsTable.targetId,
        optedOut: subscriptionSuppressedSql(),
      })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.status, "confirmed"),
          eq(subscriptionsTable.targetType, WATCH_TARGET.facility),
          inArray(subscriptionsTable.targetId, [...facilityById.keys()])
        )
      )
      .then(dropOptedOut);

    const recipientChanges: RecipientFacilityChange[] = [];
    for (const row of rows) {
      if (row.targetId === null) continue;
      const facility = facilityById.get(row.targetId);
      const changeLabel = changeLabelById.get(row.targetId);
      if (!facility || changeLabel === undefined) continue;

      recipientChanges.push({
        origin: "facility-watch",
        subscriptionId: row.subscriptionId,
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
    // Log the error's NAME and SQLSTATE only (redactedErrorCode) — never the
    // raw error object (a Drizzle/Neon query error embeds its bound params in
    // .message) and never email addresses or tokens.
    console.error(`notifySubscribersOfChanges failed: ${err instanceof Error ? err.name : "unknown"} (sqlstate: ${redactedErrorCode(err)})`);
  }
}

/**
 * Builds the flat (recipient, change) pairs for the monthly area digest:
 * every CONFIRMED, non-suppressed area-target subscriber (state, county or
 * metro — the registry's "area" family), crossed with every facility in their
 * area that changed (created or updated) since `since`. Pure query + shape
 * assembly — no sending — so it's independently testable from
 * `notifyStateSubscribersMonthly` below.
 *
 * County and metro rows are read only while `watchAreasEnabled()` is true
 * (D9, Ed 2026-10-21); with the kill switch off, ONLY state rows are read and
 * county/metro rows are left untouched.
 *
 * ONE history query covers every area: the union of the states those
 * subscriptions need (the state itself, a county's state, a metro's
 * `states`). Each subscription then filters that result in JS:
 *   - state:  `facility.state === id`;
 *   - county: `countySlug(doc.location.county, facility.state) === id`; a
 *             record with no county never matches;
 *   - metro:  `metroCountyKey(state, county)` is in the metro's county set.
 * A metro subscription whose slug no longer resolves matches nothing and is
 * skipped.
 *
 * Joins facility_history to facilities on facilityId to recover each
 * change's current name/state/status, so a facility DELETED since `since`
 * is NOT represented here — its facilities row is gone, so there is nothing
 * to join against. Same loose-coupling tradeoff facilityHistoryTable's own
 * schema comment documents for facilityId (no FK). For the same reason,
 * changeType is restricted to create|update (which also keeps editorial
 * rows out): a delete's pre-deletion name/state can't be recovered without a
 * facilities row either. A facility that changed more than once in the
 * period is deduped to its single most recent change, so a recipient sees
 * one line per facility, not one per edit.
 *
 * The period is HALF-OPEN: `since` inclusive (`>=`), `until` exclusive (`<`).
 * `until` is optional and, when omitted, the query is unbounded above exactly
 * as before — so no existing caller shifts. Passing it is what makes
 * consecutive monthly runs tile the calendar without overlapping: a run on
 * the 1st at 09:00 UTC with only a `since` also sweeps in today's first nine
 * hours, and next month's run sweeps those same hours again, putting the same
 * facility in two consecutive digests.
 */
async function buildAreaDigestChanges(since: Date, until?: Date): Promise<RecipientFacilityChange[]> {
  const db = getDb();

  const areasEnabled = watchAreasEnabled();
  if (!areasEnabled) {
    console.info("area digest: WATCH_AREAS_ENABLED=false; county and metro subscriptions not read this run");
  }
  const targetTypes = areasEnabled
    ? [WATCH_TARGET.state, WATCH_TARGET.county, WATCH_TARGET.metro]
    : [WATCH_TARGET.state];

  const subs = await db
    .select({
      subscriptionId: subscriptionsTable.id,
      email: subscriptionsTable.email,
      unsubscribeToken: subscriptionsTable.unsubscribeToken,
      targetType: subscriptionsTable.targetType,
      targetId: subscriptionsTable.targetId,
      optedOut: subscriptionSuppressedSql(),
    })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.status, "confirmed"), inArray(subscriptionsTable.targetType, targetTypes)))
    .then(dropOptedOut);

  // Resolve each subscription to its area once: the label, the states it
  // needs from the history query, and its per-facility match.
  type FacilityLoc = { state: string; county: string | undefined };
  type ResolvedSub = {
    sub: (typeof subs)[number];
    areaType: AreaDigestType;
    areaId: string;
    /** null for a county: its label comes from the matching records, see below. */
    areaName: string | null;
    states: string[];
    matches: (loc: FacilityLoc) => boolean;
  };
  const resolved: ResolvedSub[] = [];
  // Registry ids only (never an email or subscription id), logged once per run.
  let skippedMetroCount = 0;
  const skippedMetroSlugs = new Set<string>();
  for (const sub of subs) {
    const id = sub.targetId;
    if (!id) continue;
    if (sub.targetType === WATCH_TARGET.state) {
      // The id is always a validated, uppercased code by construction
      // (subscribeToTarget normalizes it via stateNameFromCode before
      // storing) — the `?? id` fallback is defense-in-depth only, never
      // expected to trigger.
      resolved.push({
        sub,
        areaType: "state",
        areaId: id,
        areaName: stateNameFromCode(id) ?? id,
        states: [id],
        matches: (loc) => loc.state === id,
      });
    } else if (sub.targetType === WATCH_TARGET.county) {
      // Stored id is `countySlug(county, state)`, e.g. `loudoun-va`; the
      // state is its last segment.
      resolved.push({
        sub,
        areaType: "county",
        areaId: id,
        areaName: null,
        states: [id.slice(id.lastIndexOf("-") + 1).toUpperCase()],
        matches: (loc) => loc.county !== undefined && countySlug(loc.county, loc.state) === id,
      });
    } else if (sub.targetType === WATCH_TARGET.metro) {
      const metro = getMetroBySlug(id);
      if (!metro) {
        skippedMetroCount++;
        skippedMetroSlugs.add(id);
        continue;
      }
      const keys = new Set(metro.counties.map(([st, c]) => metroCountyKey(st, c)));
      resolved.push({
        sub,
        areaType: "metro",
        areaId: id,
        areaName: metro.name,
        states: metro.states,
        matches: (loc) => loc.county !== undefined && keys.has(metroCountyKey(loc.state, loc.county)),
      });
    }
  }

  if (skippedMetroCount > 0) {
    console.warn(
      `area digest: skipped ${skippedMetroCount} subscription(s) for unknown metro(s): ${[...skippedMetroSlugs].sort().join(", ")}`
    );
  }

  if (resolved.length === 0) return [];

  const states = [...new Set(resolved.flatMap((r) => r.states))];

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
        // Only when bounded — `and()` ignores undefined, so an omitted
        // `until` leaves the original unbounded-above behaviour intact.
        until ? lt(facilityHistoryTable.changedAt, until) : undefined,
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

  const recipientChanges: RecipientFacilityChange[] = [];
  for (const r of resolved) {
    const matched = [...latestByFacility.values()].filter((row) =>
      r.matches({ state: row.facilityState, county: row.facilityDoc.location.county?.trim() || undefined })
    );
    if (matched.length === 0) continue;
    // A county's stored id is a slug and cannot be un-slugged, so its label
    // comes from the matching records' own county spelling (deterministic
    // when they disagree, e.g. MO's "St. Louis city" / "St. Louis City").
    const areaName =
      r.areaName ??
      `${formatCountyLabel(
        canonicalCountyName(matched.map((row) => row.facilityDoc.location.county!.trim())),
        matched[0].facilityState
      )}, ${matched[0].facilityState.toUpperCase()}`;
    for (const row of matched) {
      recipientChanges.push({
        origin: "area-digest",
        subscriptionId: r.sub.subscriptionId,
        email: r.sub.email,
        unsubscribeToken: r.sub.unsubscribeToken,
        areaType: r.areaType,
        areaId: r.areaId,
        areaName,
        facilityName: row.facilityName,
        facilitySlug: row.facilityId,
        changeLabel: row.changeType === "create" ? "added to the atlas" : "record updated",
        status: STATUS_META[row.facilityDoc.status].label,
      });
    }
  }

  return recipientChanges;
}

/**
 * Monthly area-digest entry point (Theme D, D3a). Mails EVERY area
 * subscription: state, and — since D9 (Ed, 2026-10-21) — county and metro.
 * The name `notifyStateSubscribersMonthly` is kept to avoid churn in the cron
 * route and docs. ONE `claimDigestWindow` claim per window covers every area
 * type, and `changes`/`groups`/`recipients` below count all of them. Each
 * subscription gets its own labelled digest, with no dedupe across a person's
 * subscriptions (D5). `WATCH_AREAS_ENABLED=false` skips county and metro rows
 * (state is never gated by it).
 *
 * Builds the same `RecipientFacilityChange` shape the per-facility path above
 * builds, from an area-scoped `facility_history` query
 * (`buildAreaDigestChanges`), then
 * feeds it through the IDENTICAL `groupChangesByRecipient` +
 * `sendGroupedChangeNotifications` path — no second grouping or send
 * implementation, per this file's `RecipientFacilityChange` header comment,
 * which names this exact function in advance. The period is HALF-OPEN:
 * `since` inclusive (`>=`), optional `until` exclusive (`<`). The caller
 * decides what they mean; `app/api/cron/state-digest/route.ts` passes an
 * exact UTC calendar month so consecutive runs tile without overlap or gap.
 * Omitting `until` keeps the original unbounded-above behaviour.
 *
 * Only confirmed, non-suppressed `state` (and, unless killed, `county` and
 * `metro`) rows are ever read —
 * pending and unsubscribed rows are excluded identically to
 * `notifySubscribersOfChange(s)` above. Every recipient email still embeds
 * their OWN raw `unsubscribeToken` via the shared send path, so every digest
 * carries a working unsubscribe link.
 *
 * ✅ ITS ONE CALLER IS NOW LIVE (2026-09-14, Ed's decision).
 * `app/api/cron/state-digest/route.ts` calls this function and both switches
 * that used to hold it off are flipped: `vercel.json` carries a `crons` entry
 * on `0 9 1 * *`, and `STATE_DIGEST_ENABLED=true` is set in the Vercel
 * project env. This function therefore SENDS REAL MAIL on a schedule now —
 * treat any edit to it, to `buildAreaDigestChanges`, or to the shared
 * `groupChangesByRecipient`/`sendGroupedChangeNotifications` path below as
 * outward-facing rather than internal.
 *
 * The audience at flip time, recorded because it is what the decision was
 * made about: exactly TWO confirmed `state` subscribers, OR and VA, one each.
 * The three PENDING rows (MO, SD, TX) are never read — the query is
 * `status='confirmed'` only, so they are not a silent list waiting to be
 * woken. ⚠️ Do not widen that audience as a side effect of other work; a
 * backfill of pending rows, a new `targetType`, or a catch-up over months
 * that were never sent is a NEW reactivation decision, not this one. (D9, Ed
 * 2026-10-21, is that decision for `county` and `metro`, delivered by the area
 * digest of unit 8b and gated by `WATCH_AREAS_ENABLED`; it does not extend to
 * anything else.)
 *
 * Best-effort and never throws — same contract as `notifySubscribersOfChange`.
 * Returns counts rather than `void` so a caller can tell a FAILED run from a
 * quiet month: the two were previously indistinguishable, because the catch
 * below logged and returned the same `undefined` a successful empty run did.
 * Never logs an email address, and never logs the caught error object itself
 * (see the catch).
 */
export interface StateDigestResult {
  /** False ONLY when the run threw and was caught below. A quiet month is `ok: true`. */
  ok: boolean;
  /** `RecipientFacilityChange` rows built — (subscriber × facility) pairs, not emails. */
  changes: number;
  /**
   * Emails that WOULD be sent: one per (email, area) group. The denominator
   * for `recipients`.
   */
  groups: number;
  /**
   * Emails the send helper reported as actually sent. `recipients < groups` is
   * the send-failure signal — a Resend error or a missing `RESEND_API_KEY` is
   * swallowed by the send helpers by contract, so this difference is the only
   * place it surfaces. Do NOT compare `recipients` against `changes`: one
   * recipient with three changed facilities is a healthy `recipients: 1,
   * changes: 3`.
   */
  recipients: number;
  /**
   * Present ONLY when this call refused to run because `(since, until)` was
   * already claimed by a prior call — see `claimDigestWindow` in
   * `lib/state-digest-ledger.ts` and the `stateDigestRunsTable` doc comment
   * in `lib/db/schema.ts`. When present, `changes`/`groups`/`recipients` are
   * always `0` and `ok` is always `true`: a correctly-refused duplicate is a
   * SUCCESS, not an error — nothing was built or sent, which is the entire
   * point of the ledger.
   *
   * `completedAt: null` distinguishes a CRASHED prior run (claimed, never
   * finished — some recipients may or may not have been mailed, and this
   * call will not find out or retry) from a cleanly completed one. The cron
   * route surfaces this distinction in its response rather than collapsing
   * both into one message, because they demand different human responses.
   */
  alreadyRun?: { startedAt: Date; completedAt: Date | null; recipients: number | null };
  /**
   * Present (true) only when the deadline stopped the run before every group was started. The window is then
   * NOT completed (`completedAt` stays NULL), so the watchdog reports it; `recipients` counts what was sent.
   */
  incomplete?: true;
  /** True when this call took over an earlier incomplete run of the same window instead of starting one. */
  resumed?: true;
  /** Resumed runs only: groups left alone because the earlier attempt sent them or may have (`ambiguous`). */
  skipped?: number;
  /** Resumed runs only: the part of `skipped` whose delivery is unknown (not `sent`, not provably unsent). */
  ambiguous?: number;
}

export interface StateDigestOptions {
  /** Epoch ms after which no new group is started. Unset: no deadline. */
  deadline?: number;
  /** Test seams for the deadline clock and the pacing wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the clock for the stale-run check. */
  clock?: () => Date;
}

export async function notifyStateSubscribersMonthly(
  since: Date,
  until: Date,
  opts: StateDigestOptions = {}
): Promise<StateDigestResult> {
  try {
    // Claim the window FIRST, before building or sending anything — see the
    // stateDigestRunsTable doc comment (lib/db/schema.ts) for why the claim
    // must precede the send. A refused claim returns immediately: no changes
    // are built and no mail is sent, so a repeat call for a window that was
    // already sent (or is currently claimed by another invocation) can never
    // duplicate-mail anyone.
    const claim = await claimDigestWindow(since, until);
    let runId: string;
    let resumed = false;
    if (claim.claimed) {
      runId = claim.runId;
    } else {
      const { id, ...priorRun } = claim.priorRun;
      // An incomplete run older than the stale threshold is RESUMED, never restarted: same run id, and groups
      // the earlier attempt already sent (or may have sent) are skipped below. The takeover is one guarded
      // UPDATE, so of two concurrent callers only one proceeds; the other gets `alreadyRun` as before.
      const takenOver =
        priorRun.completedAt === null &&
        (await takeOverStaleDigestRun(id, STALE_DIGEST_RUN_MS, opts.clock?.() ?? new Date()));
      if (!takenOver) {
        return { ok: true, changes: 0, groups: 0, recipients: 0, alreadyRun: priorRun };
      }
      runId = id;
      resumed = true;
    }

    const changes = await buildAreaDigestChanges(since, until);
    // Grouped by (email, areaType, areaId), NOT email alone — a recipient can
    // hold subscriptions to several areas, and each must get its own,
    // self-consistent email (see groupChangesByRecipient's doc comment).
    // `buildAreaDigestChanges` only ever emits `origin: "area-digest"`
    // changes, but the key function is typed against the full union, so the
    // area fields are only readable once narrowed by `origin`.
    const groups = groupChangesByRecipient(changes, (c) =>
      c.origin === "area-digest" ? `${c.email}::${c.areaType}::${c.areaId}` : c.email
    );
    /**
     * RESUME IS AT-MOST-ONCE. A group is re-sent only when its FINAL `email_sends` row for this run proves no
     * mail left: no row at all, a `skipped_*` row (nothing was attempted), or `error` with a code in
     * `PRE_ACCEPTANCE_ERROR_CODES`. Everything else is skipped: `sent` (done), and as AMBIGUOUS (counted, not
     * re-sent) `attempted`, `error/send_timeout` (the abandoned call may still deliver), `send_threw`, and any
     * unknown code. "Final" is the latest row per subscription (ties to the greater id: a random uuid, so arbitrary rather than chronological; kept because a tie needs two
     * rows in the same millisecond and retries are at least 1 s apart), the rule
     * `scripts/discovery/check-digest-status.ts` `finalFailures` uses. A missed re-send is recoverable by hand;
     * a duplicate email to a subscriber is not.
     */
    let toSend = groups;
    let alreadySent = 0;
    let skipped = 0;
    let ambiguous = 0;
    if (resumed) {
      const rows = await getDb()
        .select({
          id: emailSendsTable.id,
          subscriptionId: emailSendsTable.subscriptionId,
          outcome: emailSendsTable.outcome,
          errorCode: emailSendsTable.errorCode,
          createdAt: emailSendsTable.createdAt,
        })
        .from(emailSendsTable)
        .where(eq(emailSendsTable.runId, runId));
      const finalRow = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        if (!r.subscriptionId) continue;
        const prev = finalRow.get(r.subscriptionId);
        const newer =
          !prev ||
          r.createdAt.getTime() > prev.createdAt.getTime() ||
          (r.createdAt.getTime() === prev.createdAt.getTime() && r.id > prev.id);
        if (newer) finalRow.set(r.subscriptionId, r);
      }
      toSend = groups.filter((g) => {
        const last = finalRow.get(g.changes[0]?.subscriptionId ?? "");
        if (!last) return true;
        if (last.outcome.startsWith("skipped_")) return true;
        if (last.outcome === "error" && last.errorCode !== null && PRE_ACCEPTANCE_ERROR_CODES.has(last.errorCode)) {
          return true;
        }
        skipped++;
        if (last.outcome === "sent") alreadySent++;
        else ambiguous++;
        return false;
      });
    }
    // `completeDigestWindow` below sits OUTSIDE `DIGEST_GROUP_WORST_CASE_MS`. A kill there leaves the window
    // incomplete after all mail went out, which is the safe direction: a resume skips everyone already sent.
    const progress = await sendGroupedChangeNotificationsUntil(toSend, runId, opts);
    const recipients = alreadySent + ambiguous + progress.sent;
    const extra = resumed ? { resumed: true as const, skipped, ambiguous } : {};
    if (progress.stoppedEarly) {
      // Deliberately not completed: the open claim is what the watchdog reads. Counts only, never an address.
      console.error(
        `notifyStateSubscribersMonthly: deadline reached, handled ${progress.handled} of ${toSend.length} groups, sent ${progress.sent}; window left incomplete`
      );
      return { ok: true, changes: changes.length, groups: groups.length, recipients, incomplete: true, ...extra };
    }
    await completeDigestWindow(since, until, {
      changes: changes.length,
      groups: groups.length,
      recipients,
    });
    return { ok: true, changes: changes.length, groups: groups.length, recipients, ...extra };
  } catch (err) {
    // Log the error's NAME only — never addresses, tokens, or the error object
    // itself. A Drizzle/Neon error can carry the failing SQL, and a connection
    // failure can carry a driver-constructed URL with credentials in it. This
    // matches `sendStateDigestEmail` above, and matters more here than it used
    // to: wiring app/api/cron/state-digest makes this catch reachable in
    // production for the first time.
    //
    // NOTE: a throw AFTER claimDigestWindow already succeeded — from the send
    // path, or from completeDigestWindow itself — leaves this window claimed
    // and marked incomplete by design. See the stateDigestRunsTable doc
    // comment (lib/db/schema.ts) for why that silent-under-delivery direction
    // is the accepted failure mode here. An incomplete window is recovered by
    // re-calling the route for the same window after STALE_DIGEST_RUN_MS, which
    // resumes it at-most-once; deleting the row is only for deliberately
    // re-sending a COMPLETED window, and it re-mails everyone.
    // Name and SQLSTATE only (redactedErrorCode), never the raw error object.
    console.error(
      `notifyStateSubscribersMonthly failed: ${err instanceof Error ? err.name : "unknown"} (sqlstate: ${redactedErrorCode(err)})`
    );
    return { ok: false, changes: 0, groups: 0, recipients: 0 };
  }
}
