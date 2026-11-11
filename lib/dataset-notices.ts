import { and, asc, eq, isNull, lt, lte, sql } from "drizzle-orm";

import { issueRenewalToken, liveGrant } from "@/lib/dataset-grants";
import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { datasetAccessGrantsTable, datasetEditionsTable } from "@/lib/db/schema";
import { sendDatasetEditionNoticeEmail, sendDatasetRenewalReminderEmail, type SendOutcome } from "@/lib/email";
import { sendGrantGated } from "@/lib/email-gate";

/**
 * The weekly edition notice and the renewal reminder: the two scheduled mails to dataset grantees. Both run
 * after a successful publish (lib/dataset-edition-builder.ts), sequentially, paced, under a soft deadline, and
 * neither ever throws: a caught error is logged as a fixed code and the result says `complete: false`.
 *
 * Logs carry counts and codes only, never an address, token or error text.
 *
 * RESEND FREE-PLAN CEILING (Ed's plan, 2026-11-09): 100 mails a day across ALL mail (verify, admin, approval,
 * reminders and these notices share it) and about 2 API requests a second. Pacing keeps the request rate under
 * the second limit (`DATASET_NOTICE_PACE_MS`). The daily ceiling cannot be paced around: with more than ~80 live
 * grantees some notices fail with `send_failed` once the day's quota is spent. By the at-most-once design
 * (claim first, below) a failed notice is NOT retried, so that grantee misses that week's notice. Upgrading the
 * Resend plan lifts the ceiling; nothing here needs to change.
 *
 * RECOVERY OF A CUT-SHORT NOTICE PASS: when the 240 s budget (or a database error) ends a pass early,
 * `dataset_editions.notice_sent_at` stays null and the builder reports `notices: { complete: false }`; the cron
 * route logs "notices incomplete". Recovery is a manual "Build now" in /admin/access the SAME DAY (while this is
 * still the newest published edition): the builder resumes the pass, and the per-grant claim means only the
 * grantees not yet claimed are mailed. Nothing retries it automatically.
 *
 * Both passes are given ONE pacer per build (`makePacer`, passed as `NoticeOptions.pacer`), so the first
 * reminder does not fire right after the last notice, and every send is bounded by `DATASET_SEND_TIMEOUT_MS`.
 */

/** Reminders go out once a live grant is within this long of its expiry. */
export const DATASET_RENEWAL_REMINDER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Gap between two sends that reached Resend: 600 ms keeps the API under 2 requests a second. */
export const DATASET_NOTICE_PACE_MS = 600;

/** A send that has not settled after this long is abandoned (counted failed, `send_timeout`). */
export const DATASET_SEND_TIMEOUT_MS = 20_000;

/** Default soft deadline; the builder passes what is left of its own 240 s budget instead. */
export const DATASET_NOTICE_DEADLINE_MS = 240_000;

const EDITION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface NoticeOptions {
  now?: Date;
  /** Stop starting new sends once this many ms have elapsed since the call began. */
  deadlineMs?: number;
  paceMs?: number;
  /** Test seam for the pacing wait. */
  sleep?: (ms: number) => Promise<void>;
  /** One pacer shared by several passes (the builder makes one per build); wins over `paceMs` / `sleep`. */
  pacer?: Pacer;
}

/** The wait to run at the top of each send callback. */
export type Pacer = () => Promise<void>;

export interface NoticeResult {
  /** Grants whose notice this run attempted: claimed for the edition, or (reminders) a token issued. */
  claimed: number;
  sent: number;
  /** Not mailed and not a send failure: lost the claim, no longer eligible, or suppressed. */
  skipped: number;
  /** The gate reached Resend (or tried to) and it did not send. */
  failed: number;
  /** Every candidate was handled before the deadline and no error cut the run short. */
  complete: boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the wait to run at the top of each send callback. The gate invokes the callback only when it has
 * decided to mail, so a suppressed or ineligible grant costs no wait; the first send waits for nothing.
 */
export function makePacer(paceMs: number = DATASET_NOTICE_PACE_MS, sleep: (ms: number) => Promise<void> = realSleep): Pacer {
  let sentOne = false;
  return async () => {
    if (sentOne && paceMs > 0) await sleep(paceMs);
    sentOne = true;
  };
}

/**
 * Races a sender against `DATASET_SEND_TIMEOUT_MS`: lib/email.ts `sendViaResend` has no timeout of its own, so a
 * hung Resend call would otherwise hold the whole pass until the function is killed. The timer is cleared on
 * settle. The abandoned call may still complete in the background (its late result is ignored), so a timeout
 * does not prove nothing was mailed.
 */
async function sendWithTimeout(send: () => Promise<SendOutcome>): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, errorCode: "send_timeout" }), DATASET_SEND_TIMEOUT_MS);
  });
  const sending = send();
  sending.catch(() => {});
  try {
    return await Promise.race([sending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface DatasetSummary {
  added: number;
  updated: number;
  removed: number;
  headlines: string[];
}

/** `changelog_summary` is opaque jsonb: accept only the exact shape the builder writes. */
function parseSummary(value: unknown): DatasetSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!isCount(v.added) || !isCount(v.updated) || !isCount(v.removed)) return undefined;
  if (!Array.isArray(v.headlines) || !v.headlines.every((h) => typeof h === "string")) return undefined;
  return { added: v.added, updated: v.updated, removed: v.removed, headlines: v.headlines as string[] };
}

/**
 * Mails the weekly "new edition" notice to every live grantee, at most once per (edition, grant).
 *
 * Each grant is CLAIMED before its mail is sent, with the contract on `datasetAccessGrantsTable`
 * (lib/db/schema.ts): the UPDATE returns a row only while the grant is live, has not been claimed for this
 * edition, and this edition is still the newest published one. The newest-edition predicate is load-bearing: the
 * marker remembers only the last edition, so claiming an older edition after a newer one would re-mail it. No
 * row means skip. A send that fails after its claim is not retried for that week.
 *
 * `dataset_editions.notice_sent_at` is set only once every candidate was handled (not cut off by the deadline
 * or an error) AND the edition is still the newest published one; a partial run leaves it null so a rerun
 * (the builder's resume path) can finish while the edition is the newest.
 */
export async function sendEditionNotices(editionId: string, opts: NoticeOptions = {}): Promise<NoticeResult> {
  const result: NoticeResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, complete: false };
  const start = Date.now();
  const now = opts.now ?? new Date();
  const deadlineMs = opts.deadlineMs ?? DATASET_NOTICE_DEADLINE_MS;
  const pace = opts.pacer ?? makePacer(opts.paceMs ?? DATASET_NOTICE_PACE_MS, opts.sleep ?? realSleep);

  try {
    const db = getDb();
    const [edition] = await db
      .select({
        id: datasetEditionsTable.id,
        editionDate: datasetEditionsTable.editionDate,
        recordCount: datasetEditionsTable.recordCount,
        changelogSummary: datasetEditionsTable.changelogSummary,
      })
      .from(datasetEditionsTable)
      .where(and(eq(datasetEditionsTable.id, editionId), eq(datasetEditionsTable.status, "published")));
    if (!edition) {
      console.error("dataset notices: edition not published, nothing sent");
      return result;
    }
    // The date goes into the mail body: constrain it here as well as in the template.
    if (!EDITION_DATE_RE.test(edition.editionDate)) {
      console.error("dataset notices: edition date malformed, nothing sent");
      return result;
    }
    // The first edition has nothing to compare against, so its notice carries no change counts. Rows are never
    // deleted, so "no earlier published edition" is a stable test.
    const [earlier] = await db
      .select({ id: datasetEditionsTable.id })
      .from(datasetEditionsTable)
      .where(and(eq(datasetEditionsTable.status, "published"), lt(datasetEditionsTable.editionDate, edition.editionDate)))
      .limit(1);
    const summary = earlier ? parseSummary(edition.changelogSummary) : undefined;
    // The counts line is dropped, not guessed: say so once (a fixed code, never the stored value).
    if (earlier && !summary) {
      console.warn("dataset notices: changelog summary malformed, counts line omitted (code: summary_malformed)");
    }

    const candidates = await db
      .select({ id: datasetAccessGrantsTable.id, email: datasetAccessGrantsTable.email, unsubscribeToken: datasetAccessGrantsTable.unsubscribeToken })
      .from(datasetAccessGrantsTable)
      .where(
        and(
          liveGrant(now),
          sql`${datasetAccessGrantsTable.lastNoticeEditionId} IS DISTINCT FROM ${editionId}`
        )
      )
      .orderBy(asc(datasetAccessGrantsTable.id));

    for (const grant of candidates) {
      if (Date.now() - start > deadlineMs) {
        console.warn(
          `dataset notices: deadline reached (claimed=${result.claimed} sent=${result.sent} skipped=${result.skipped} failed=${result.failed})`
        );
        return result;
      }
      // Minted on approval, so a live grant has one; without it the notice would carry no unsubscribe link.
      if (!grant.unsubscribeToken) {
        result.skipped++;
        continue;
      }

      // CLAIM FIRST (at-most-once). The contract in lib/db/schema.ts, verbatim.
      const claimed = await db
        .update(datasetAccessGrantsTable)
        .set({ lastNoticeEditionId: editionId })
        .where(
          and(
            eq(datasetAccessGrantsTable.id, grant.id),
            liveGrant(new Date()), // the clock at claim time (the old `now()`), not the candidate read's `now`: re-checks the payment gate too
            sql`${datasetAccessGrantsTable.lastNoticeEditionId} IS DISTINCT FROM ${editionId}`,
            sql`${editionId} = (SELECT id FROM dataset_editions WHERE status = 'published' ORDER BY edition_date DESC LIMIT 1)`
          )
        )
        .returning({ id: datasetAccessGrantsTable.id });
      if (claimed.length === 0) {
        result.skipped++;
        continue;
      }
      result.claimed++;

      const unsubscribeToken = grant.unsubscribeToken;
      const res = await sendGrantGated(
        db,
        { kind: "dataset_edition_notice", grantId: grant.id, email: grant.email, editionId },
        async () => {
          await pace();
          return sendWithTimeout(() =>
            sendDatasetEditionNoticeEmail({
              email: grant.email,
              editionDate: edition.editionDate,
              unsubscribeToken,
              recordCount: edition.recordCount,
              summary,
            })
          );
        }
      );
      if (res.sent) result.sent++;
      else if (res.disposition === "send_failed") result.failed++;
      else result.skipped++;
    }

    result.complete = true;
    // Only the newest published edition may be marked: a superseded one can no longer be completed by a rerun.
    await db
      .update(datasetEditionsTable)
      .set({ noticeSentAt: new Date() })
      .where(
        and(
          eq(datasetEditionsTable.id, editionId),
          isNull(datasetEditionsTable.noticeSentAt),
          sql`${datasetEditionsTable.id} = (SELECT id FROM dataset_editions WHERE status = 'published' ORDER BY edition_date DESC LIMIT 1)`
        )
      );
    console.info(
      `dataset notices: done (claimed=${result.claimed} sent=${result.sent} skipped=${result.skipped} failed=${result.failed})`
    );
    return result;
  } catch (err) {
    console.error(`dataset notices: edition notices failed (code: ${redactedErrorCode(err)})`);
    result.complete = false;
    return result;
  }
}

/**
 * Mails the renewal reminder to each live grant within `DATASET_RENEWAL_REMINDER_WINDOW_MS` of expiry that has
 * neither been reminded nor asked for a renewal.
 *
 * Each grant is CLAIMED first, like the edition notice: a conditional UPDATE stamps `renewalRemindedAt` and
 * returns a row only for the pass that won, so two overlapping runs (the cron and a same-day resume) cannot
 * both mail it, and a second run cannot rotate the renew token under a mail already sent. Unlike the notice, a
 * reminder is retried: when the gate does not report `sent` (suppressed, capped, failed, timed out, or the grant
 * stopped being live) the claim is released (`renewalRemindedAt` back to null, only if it still holds our
 * value), so the next run tries again. The renew token is minted INSIDE the gate callback, i.e. only once the
 * gate has decided to mail: a suppressed or capped grant never has its token rotated, however often it is
 * re-checked. Shares the Resend free-plan ceiling described at the top of this file.
 *
 * Two consequences of release-on-failure are accepted, neither attacker-controlled:
 * (a) a send that times out (`send_timeout`) may still be delivered by Resend. The claim is released anyway, so
 *     the next run mails a second reminder with a NEW renew token, and the first mail's link stops working (the
 *     grantee can recover through /access).
 * (b) if the release UPDATE fails, or the function is killed between the claim and the release, the claim is
 *     stranded (`renewalRemindedAt` stays set) and that grant gets no reminder. The failed release is logged.
 */
export async function sendRenewalReminders(opts: NoticeOptions = {}): Promise<NoticeResult> {
  const result: NoticeResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, complete: false };
  const start = Date.now();
  const now = opts.now ?? new Date();
  const deadlineMs = opts.deadlineMs ?? DATASET_NOTICE_DEADLINE_MS;
  const pace = opts.pacer ?? makePacer(opts.paceMs ?? DATASET_NOTICE_PACE_MS, opts.sleep ?? realSleep);

  try {
    const db = getDb();
    const candidates = await db
      .select({ id: datasetAccessGrantsTable.id })
      .from(datasetAccessGrantsTable)
      .where(
        and(
          // Free lane only: a commercial grant's expiry is its paid-through date, renewed by PayPal, so the
          // "request renewal" reminder (and its renew token) would misfire on it.
          eq(datasetAccessGrantsTable.tier, "free"),
          liveGrant(now),
          lte(datasetAccessGrantsTable.expiresAt, new Date(now.getTime() + DATASET_RENEWAL_REMINDER_WINDOW_MS)),
          isNull(datasetAccessGrantsTable.renewalRemindedAt),
          isNull(datasetAccessGrantsTable.renewalRequestedAt)
        )
      )
      .orderBy(asc(datasetAccessGrantsTable.id));

    for (const candidate of candidates) {
      if (Date.now() - start > deadlineMs) {
        console.warn(
          `dataset reminders: deadline reached (sent=${result.sent} skipped=${result.skipped} failed=${result.failed})`
        );
        return result;
      }

      // CLAIM FIRST. No row means another pass has it, or it is no longer eligible.
      const claimedAt = new Date();
      const [grant] = await db
        .update(datasetAccessGrantsTable)
        .set({ renewalRemindedAt: claimedAt })
        .where(
          and(
            eq(datasetAccessGrantsTable.id, candidate.id),
            eq(datasetAccessGrantsTable.tier, "free"),
            isNull(datasetAccessGrantsTable.renewalRemindedAt),
            isNull(datasetAccessGrantsTable.renewalRequestedAt),
            liveGrant(new Date())
          )
        )
        .returning({
          id: datasetAccessGrantsTable.id,
          email: datasetAccessGrantsTable.email,
          expiresAt: datasetAccessGrantsTable.expiresAt,
        });
      if (!grant) {
        result.skipped++;
        continue;
      }
      result.claimed++;

      const expiresAt = grant.expiresAt;
      let sent = false;
      if (expiresAt) {
        const res = await sendGrantGated(
          db,
          { kind: "dataset_renewal_reminder", grantId: grant.id, email: grant.email },
          async () => {
            await pace();
            const issued = await issueRenewalToken(grant.id);
            if (!issued.ok) return { sent: false, errorCode: "not_eligible" };
            const { mail } = issued;
            return sendWithTimeout(() =>
              sendDatasetRenewalReminderEmail({ email: mail.email, renewToken: mail.renewToken, expiresAt })
            );
          }
        );
        sent = res.sent;
        if (res.sent) result.sent++;
        else if (res.disposition === "send_failed") result.failed++;
        else result.skipped++;
      } else {
        result.skipped++;
      }

      if (!sent) {
        // Release only our own claim; a failed release is contained so the rest of the pass still runs. A failure
        // here strands the claim: that grant gets no reminder (see the accepted consequences in the doc above).
        try {
          await db
            .update(datasetAccessGrantsTable)
            .set({ renewalRemindedAt: null })
            .where(and(eq(datasetAccessGrantsTable.id, grant.id), eq(datasetAccessGrantsTable.renewalRemindedAt, claimedAt)));
        } catch (err) {
          console.error(`dataset reminders: claim release failed (code: ${redactedErrorCode(err)})`);
        }
      }
    }

    result.complete = true;
    console.info(
      `dataset reminders: done (sent=${result.sent} skipped=${result.skipped} failed=${result.failed})`
    );
    return result;
  } catch (err) {
    console.error(`dataset reminders: renewal reminders failed (code: ${redactedErrorCode(err)})`);
    result.complete = false;
    return result;
  }
}
