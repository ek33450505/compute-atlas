/**
 * The claim/complete primitives behind `state_digest_runs` (see that table's
 * doc comment in lib/db/schema.ts for the full contract this module
 * implements). `notifyStateSubscribersMonthly` (lib/notify.ts) is the only
 * caller: it claims a `(since, until)` window BEFORE building or sending
 * anything, and marks it complete only after a real send has finished.
 *
 * INVARIANT: no function here ever logs a caught error object. Same
 * reasoning as lib/submission-notify.ts's module doc comment — Drizzle wraps
 * driver errors in `DrizzleQueryError`, whose own `.message` binds the query
 * params (here, only two timestamps — harmless today, but the convention
 * exists so the next statement added to this file doesn't inherit a bad
 * habit).
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { stateDigestRunsTable } from "@/lib/db/schema";

const UNIQUE_VIOLATION_CODE = "23505";

/**
 * Exact duplicate of lib/subscribe.ts's / lib/submission-notify.ts's
 * `isUniqueViolation` (same reasoning: both the neon-http and PGlite drivers
 * surface constraint violations with a Postgres error `code`, but drizzle-orm
 * wraps the driver error in a `DrizzleQueryError` whose own `.message` is a
 * generic "Failed query: ..." string — the real `code`/message live one level
 * down on `.cause` — plus a message-regex fallback in case a driver loses
 * `code`). Duplicated rather than imported for the same reason
 * lib/submission-notify.ts gives: this module has no other dependency on
 * either file and the predicate is small and stable. Keep all three in sync
 * if the shared shape ever changes.
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

export type DigestClaim =
  | { claimed: true }
  | {
      claimed: false;
      priorRun: { startedAt: Date; completedAt: Date | null; recipients: number | null };
    };

/**
 * Attempts to CLAIM a `(since, until)` window by inserting its row BEFORE any
 * change is built or any mail is sent — see the `stateDigestRunsTable` doc
 * comment in lib/db/schema.ts for why the claim must precede the send, not
 * follow it. Returns `{claimed:true}` on success (the caller may proceed) or,
 * on a unique-index violation — this window was already claimed, either by a
 * completed run or a crashed one — `{claimed:false, priorRun}` describing the
 * existing row so the caller can tell the two apart.
 *
 * This is also the RACE path: two concurrent invocations for the SAME window
 * both attempt the insert; the unique index lets exactly one succeed, and the
 * loser resolves to `{claimed:false}` here rather than throwing.
 *
 * Any error OTHER than a unique violation propagates. This is deliberate: a
 * DB failure here must never be reported as a successful claim (which would
 * let the caller proceed to send unrecorded) or as a refused claim (which
 * would silently swallow a real infra failure as an ordinary duplicate). The
 * caller's own catch (`notifyStateSubscribersMonthly`) handles it.
 */
export async function claimDigestWindow(since: Date, until: Date): Promise<DigestClaim> {
  const db = getDb();
  try {
    await db.insert(stateDigestRunsTable).values({ since, until });
    return { claimed: true };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    const rows = await db
      .select({
        startedAt: stateDigestRunsTable.startedAt,
        completedAt: stateDigestRunsTable.completedAt,
        recipients: stateDigestRunsTable.recipients,
      })
      .from(stateDigestRunsTable)
      .where(and(eq(stateDigestRunsTable.since, since), eq(stateDigestRunsTable.until, until)))
      .limit(1);

    const priorRun = rows[0];
    if (!priorRun) {
      // Should be unreachable: Postgres only raises a unique-violation once
      // the conflicting row's transaction has committed, so a SELECT
      // immediately after must see it. Throwing a hard error here — rather
      // than fabricating a placeholder priorRun — is what makes this
      // reachable-at-all worth investigating instead of silently reporting a
      // plausible lie about when the prior run started.
      throw new Error("claimDigestWindow: unique violation but no conflicting row found");
    }
    return { claimed: false, priorRun };
  }
}

/**
 * Marks a previously-claimed window complete, recording the counts the run
 * actually produced. Matched by the `(since, until)` pair, not an id — the
 * caller never sees the row's id, only the same Date pair it claimed with.
 *
 * Idempotent and silent if no row matches — this can only happen if the row
 * was deleted between the claim and this call (the documented manual-resend
 * path: see the enable checklist in app/api/cron/state-digest/route.ts),
 * which is not this function's job to detect.
 *
 * A throw from THIS call (vs. from the claim or the send) is the specific
 * case that leaves a window claimed with `completedAt` still null even
 * though the mail genuinely went out — see the `stateDigestRunsTable` doc
 * comment for why that failure direction (never retried, never re-sent) is
 * accepted rather than guarded against here.
 */
export async function completeDigestWindow(
  since: Date,
  until: Date,
  counts: { changes: number; groups: number; recipients: number }
): Promise<void> {
  await getDb()
    .update(stateDigestRunsTable)
    .set({
      completedAt: new Date(),
      changes: counts.changes,
      groups: counts.groups,
      recipients: counts.recipients,
    })
    .where(and(eq(stateDigestRunsTable.since, since), eq(stateDigestRunsTable.until, until)));
}
