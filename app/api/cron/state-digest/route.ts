import { createHash, timingSafeEqual } from "node:crypto";

import { requireAdmin } from "@/lib/api-auth";
import { jsonResponse } from "@/lib/api-response";
import { notifyStateSubscribersMonthly } from "@/lib/notify";

/**
 * Monthly state-digest trigger — the one caller of `notifyStateSubscribersMonthly`.
 *
 * ⛔ DISABLED ON MERGE, BY TWO INDEPENDENT SWITCHES.
 *
 *   1. There is NO `crons` entry in `vercel.json`, so nothing ever invokes this route.
 *   2. `STATE_DIGEST_ENABLED` is unset, so even a correctly authenticated call returns 503
 *      and sends nothing.
 *
 * Why both: the `state` subscription rows predate the digest feature and have never received
 * any mail from Compute Atlas. Turning this on resumes mail to a list that has been silent
 * since it was collected — a reactivation decision that is Ed's to make and has NOT been made.
 * Merging this code is not making it. Do not flip either switch as a side effect of other work.
 *
 * To enable (maintainer, deliberately, all four steps IN ORDER):
 *   1. ✅ THE IDEMPOTENCY GAP IS CLOSED (D3). Every call now claims its `(since, until)`
 *      window in `state_digest_runs` (`lib/state-digest-ledger.ts`) BEFORE building or
 *      sending anything, so a repeat call for the same window is refused as a no-op —
 *      `notifyStateSubscribersMonthly` returns `alreadyRun`, and this route surfaces it as
 *      `alreadyRun: true` with a `message`, still a 200. Two things to know before relying on
 *      this:
 *        - `completedAt IS NULL` on a `state_digest_runs` row means a PRIOR run claimed that
 *          window and never finished — crashed or timed out partway through sending. Do not
 *          assume a month's mail went out just because its window shows as claimed; check
 *          `completedAt` first (this route's response does, via `priorRunCompleted`).
 *        - There is intentionally NO `?force=` parameter to bypass the guard. A deliberate
 *          resend requires manually deleting the `state_digest_runs` row for that window in
 *          Neon — the same raw-delete-only convention this repo already uses for retiring a
 *          facility (see docs/maintainers.md). A one-parameter bypass of an idempotency guard
 *          gets used reflexively eventually; requiring a slower, deliberate manual step is the
 *          point, not an oversight.
 *   2. Add to `vercel.json`:
 *        "crons": [{ "path": "/api/cron/state-digest", "schedule": "0 9 1 * *" }]
 *   3. Set `CRON_SECRET` and `STATE_DIGEST_ENABLED=true` in the Vercel project env.
 *      ⚠️ `CRON_SECRET` MUST NOT equal `API_ADMIN_TOKEN`. `hasValidCronSecret` is checked
 *      first and short-circuits, so if they are equal the admin bearer is always consumed as
 *      the cron identity, `isAdminCaller` never becomes true, and the `?since=&until=`
 *      recovery path is permanently unreachable with the maintainer's own token. The failure
 *      direction is safe (a 400, never an unauthorized send), but it is a trap worth one
 *      line here: generate `CRON_SECRET` independently.
 *   4. Redeploy — a new env var is invisible to already-built deployments, so a deploy that
 *      predates the variable keeps reading `undefined` and keeps returning 503.
 *
 * Why Vercel Cron and not local launchd: launchd does not catch up a missed
 * `StartCalendarInterval` run. Observed here 2026-09-05 — the Mac booted 32 minutes after a
 * 13:00 schedule and launchd simply waited for the next occurrence (`runs = 0`, no error, no
 * log line, no notification). For a MONTHLY job that failure mode costs a whole month and
 * produces no signal at all, and a laptop asleep on the 1st is the normal case. Vercel Cron
 * runs against the deployed function and needs no machine awake; `lib/notify.ts` already
 * executes in the Next runtime there for the approve path, so this adds a trigger, not a new
 * execution environment.
 */

// MANDATORY, not stylistic: this route reads the DB and takes no `searchParams` at the
// segment level, so without it Next prerenders it at build time, `getDb()` runs with no
// DATABASE_URL, and the build aborts with "DATABASE_URL is not set". `/admin/contact` hit
// exactly this. Do not rely on accepting searchParams as the fix.
export const dynamic = "force-dynamic";

/**
 * Sends are sequential and inline (see `sendGroupedChangeNotifications`'s MVP-scale note), so
 * this function's runtime scales with the confirmed-subscriber count. Declared rather than
 * left to the platform default because a function killed mid-loop leaves SOME recipients
 * mailed with nothing recording which — and a re-run mails them again (see the idempotency
 * prerequisite above). Raise this only alongside that ledger, never instead of it.
 */
export const maxDuration = 60;

/** Strict `YYYY-MM-DD`. Anything else (including `YYYY-MM-DDTHH:MM:SSZ`) is rejected. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Upper bound on an explicit `?since=&until=` window, in days. 366 covers a leap year, so
 * any legitimate recovery — including "re-run the whole of last year, month by month" done
 * one month at a time — fits. This is not an attack control (the path is admin-only); it
 * stops a fat-fingered `?since=0001-01-01` from mailing a real person a digest spanning
 * centuries of history.
 */
const MAX_WINDOW_DAYS = 366;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Parses a strict `YYYY-MM-DD` into the UTC instant of its first millisecond, or `null`.
 *
 * The round-trip check is load-bearing: `Date.parse("2026-02-31T00:00:00Z")` does NOT return
 * NaN — it silently rolls over to March 3rd. Comparing the parsed date's own ISO date part
 * back against the input is what turns a nonexistent calendar date into a 400 instead of a
 * digest window quietly shifted by three days.
 */
function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  const parsed = new Date(ms);
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

/**
 * Vercel Cron's convention: when `CRON_SECRET` is set, Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation.
 *
 * Both sides are SHA-256'd to a fixed 32-byte digest before `timingSafeEqual`, matching
 * `requireAdmin` in lib/api-auth.ts (read its doc comment): hashing first keeps the
 * comparison constant-time, avoids `timingSafeEqual` throwing on a length mismatch, and
 * avoids leaking the expected secret's length through a bare `a.length !== b.length` early
 * return. Never `===`.
 *
 * Fails CLOSED: an unset/empty `CRON_SECRET` rejects every caller. There is no
 * "auth disabled" mode.
 */
function hasValidCronSecret(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length).trim();
  if (!presented) return false;

  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * The digest period: the whole PREVIOUS UTC calendar month, half-open — `since` inclusive,
 * `until` exclusive. Both are derived from a single `now` read so a month boundary crossed
 * mid-request cannot produce a mismatched pair.
 *
 * This is the point of the `until` bound. A run on the 1st at 09:00 UTC with only a `since`
 * would also sweep in today's first nine hours, and the next month's run would sweep those
 * same hours again — the same facility line in two consecutive digests. Exact calendar months
 * tile with no overlap and no gap, and match what the copy promises ("your monthly Virginia
 * digest").
 */
function previousCalendarMonth(now: Date): { since: Date; until: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based; Date.UTC handles month -1 as last December
  return {
    since: new Date(Date.UTC(year, month - 1, 1)),
    until: new Date(Date.UTC(year, month, 1)),
  };
}

export async function GET(request: Request): Promise<Response> {
  // 1. AUTH FIRST, fail closed. Either Vercel Cron's bearer or the maintainer's admin bearer
  //    (so a missed month can be re-run by hand). If NEITHER `CRON_SECRET` nor
  //    `API_ADMIN_TOKEN` is configured, both checks reject and this is a 401 — the route never
  //    runs unauthenticated.
  let isAdminCaller = false;
  if (!hasValidCronSecret(request)) {
    const denied = requireAdmin(request);
    if (denied) return denied;
    isAdminCaller = true;
  }

  // 2. KILL SWITCH, strictly AFTER auth — otherwise an unauthenticated caller could probe
  //    whether the feature is enabled by telling 503 apart from 401.
  if (process.env.STATE_DIGEST_ENABLED !== "true") {
    return jsonResponse({ error: "State digest is disabled" }, { status: 503 });
  }

  // 3. Window: the previous calendar month by default; explicit overrides on the admin bearer
  //    only, for recovering a month the cron missed.
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const untilParam = url.searchParams.get("until");

  let since: Date;
  let until: Date;
  if (sinceParam !== null || untilParam !== null) {
    if (!isAdminCaller) {
      return jsonResponse(
        { error: "since/until overrides require the admin bearer" },
        { status: 400 }
      );
    }
    if (sinceParam === null || untilParam === null) {
      return jsonResponse({ error: "since and until must be given together" }, { status: 400 });
    }
    const parsedSince = parseDateOnly(sinceParam);
    const parsedUntil = parseDateOnly(untilParam);
    if (!parsedSince || !parsedUntil) {
      return jsonResponse({ error: "since and until must be YYYY-MM-DD" }, { status: 400 });
    }
    if (parsedUntil.getTime() <= parsedSince.getTime()) {
      return jsonResponse({ error: "until must be after since" }, { status: 400 });
    }
    if (parsedUntil.getTime() - parsedSince.getTime() > MAX_WINDOW_MS) {
      return jsonResponse(
        { error: `Window must be at most ${MAX_WINDOW_DAYS} days` },
        { status: 400 }
      );
    }
    since = parsedSince;
    until = parsedUntil;
  } else {
    ({ since, until } = previousCalendarMonth(new Date()));
  }

  // 4. Run it. `notifyStateSubscribersMonthly` never throws; `ok: false` means it caught one,
  //    which is deliberately distinguishable from a quiet month (`ok: true, changes: 0`) and
  //    from an already-run window (`ok: true, alreadyRun: {...}`, handled below).
  const result = await notifyStateSubscribersMonthly(since, until);

  if (result.alreadyRun) {
    // This window was already claimed by a prior call — see claimDigestWindow /
    // stateDigestRunsTable's doc comment (lib/db/schema.ts). `completedAt` tells apart the
    // two cases a repeat call can find, and they demand different human responses: a
    // completed prior run means this window was already sent in full, nothing to do; a null
    // `completedAt` means a prior call claimed this window and never finished — it may have
    // crashed or timed out partway through sending, some recipients may be mailed and some
    // not, and this call will NOT retry (see the ledger's doc comment for why that
    // silent-under-delivery direction is deliberate). Collapsing the two into one message
    // would hide exactly the case that needs a human to look.
    const priorRunCompleted = result.alreadyRun.completedAt !== null;
    const message = priorRunCompleted
      ? "This window was already sent — no-op."
      : "A prior run claimed this window but never completed (crashed or timed out). Some " +
        "recipients may be unmailed, and this call will not retry. A deliberate resend " +
        "requires manually deleting the state_digest_runs row for this window — there is no " +
        "?force= override.";
    return jsonResponse(
      {
        ok: true,
        since: since.toISOString(),
        until: until.toISOString(),
        changes: 0,
        groups: 0,
        recipients: 0,
        alreadyRun: true,
        priorRunCompleted,
        message,
      },
      { status: 200 }
    );
  }

  // COUNTS ONLY — never an email address, per lib/notify.ts's "never log addresses or tokens"
  // convention. This body is readable by anyone holding either bearer.
  return jsonResponse(
    {
      ok: result.ok,
      since: since.toISOString(),
      until: until.toISOString(),
      changes: result.changes,
      // `groups` is the denominator for `recipients`: groups is what WOULD be sent,
      // recipients is what the send helper reported sent, so `recipients < groups` is the
      // send-failure signal. Comparing recipients against `changes` instead would misread
      // one recipient with three changed facilities as a failure.
      groups: result.groups,
      recipients: result.recipients,
    },
    { status: result.ok ? 200 : 500 }
  );
}
