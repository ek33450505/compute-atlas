/**
 * One-off: bring EXISTING free dataset grants down to the 90-day term (Ed, 2026-11-13) and tell the grantees.
 * DRY RUN IS THE DEFAULT.
 *
 *   npm run grants:term                      dry run: list the grants that would be shortened
 *   npm run grants:term -- --apply           shorten them (expires_at = approved_at + 90 days)
 *   npm run grants:term -- --apply --notify  shorten, then mail each affected grantee once
 *   npm run grants:term -- --notify-ids a,b  retry the notice for named grants (full ids, printed by --apply)
 *
 * SINGLE-USE MIGRATION for the 365-to-90-day change (Ed, 2026-11-13); delete it once it has run. It touches only
 * grants still on their ORIGINAL term, `expires_at = approved_at + 365 days` (approval sets both in one statement,
 * so they are exactly equal). A renewed or extended grant has a different expiry and is never selected or mailed.
 *
 * Scope: `tier = 'free' AND status = 'active'` only; a commercial row is never selected or written. The UPDATE
 * repeats the whole predicate, so a re-run changes nothing and a grant can only be SHORTENED. REFUSED (dry run and
 * --apply, before any write) when any new expiry would land under now + 7 days: that would cut someone off with no
 * warning; the refusal prints which grants. The 7-day floor is also in the UPDATE's WHERE, so the write itself can
 * never cut anyone off.
 *
 * The write is ONE UPDATE statement (atomic; the Neon HTTP driver has no interactive transaction). It is read
 * back and the count checked. --notify goes through `sendGrantGated` (live free grant, suppression honored), at
 * most once per grant: the recipients are exactly the rows this run's UPDATE returned, never inferred from dates,
 * and a grant with a `sent` `dataset_term_changed` row is skipped. A failed send exits non-zero and prints the ids.
 * --notify-ids retries only grants an earlier run tried and failed to notify, and re-checks each is a free, active
 * grant really on the 90-day term. If an id has no earlier failed notice row it is refused, not retried (a notice that
 * was never recorded, e.g. the grant lookup failed, must be sent by hand). --notify refuses before any write when
 * RESEND_API_KEY is unset, and a `skipped_no_key` send counts as failed. Addresses are never printed in full.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { DATASET_FREE_GRANT_TERM_MS } from "../lib/dataset-grants";
import { datasetAccessGrantsTable, emailSendsTable } from "../lib/db/schema";
import { getDb, hasDatabaseUrl } from "../lib/db/client";
import { formatFatalError } from "../lib/db-error";
import { sendDatasetTermChangedEmail, type SendOutcome } from "../lib/email";
import { sendGrantGated, type GateResult } from "../lib/email-gate";
import type { EmailSendsDb } from "../lib/email-sends";
import { makePacer, type Pacer } from "../lib/send-pacer";
import { sendWithTimeout } from "../lib/send-timeout";
import { isEntrypoint } from "./is-entrypoint";

/** A new expiry earlier than now + this is refused: the grantee would get no reminder window. */
export const MIN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_TIMEOUT_MS = 20_000;

export class RefusalError extends Error {}

export function parseArgs(argv: string[]): { apply: boolean; notify: boolean; notifyIds: string[] } {
  let apply = false;
  let notify = false;
  let notifyIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--notify") notify = true;
    else if (arg === "--notify-ids") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--notify-ids needs a comma-separated list of grant ids");
      notifyIds = value.split(",").map((v) => v.trim()).filter(Boolean);
      if (notifyIds.length === 0 || !notifyIds.every((id) => UUID_RE.test(id))) {
        throw new Error("--notify-ids takes full grant UUIDs, comma-separated");
      }
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (notify && !apply) throw new Error("--notify only works with --apply: it mails the grants that run shortened");
  if (notifyIds.length > 0 && (apply || notify)) throw new Error("--notify-ids is a retry on its own; do not combine it with --apply or --notify");
  return { apply, notify, notifyIds };
}

export interface Candidate {
  id: string;
  email: string;
  approvedAt: Date;
  expiresAt: Date;
  newExpiresAt: Date;
  renewalPending: boolean;
}

/** `approved_at + 90 days` in SQL, in seconds so it matches `DATASET_FREE_GRANT_TERM_MS` exactly. */
const freeTermEnd = sql`${datasetAccessGrantsTable.approvedAt} + ${DATASET_FREE_GRANT_TERM_MS / 1000}::double precision * interval '1 second'`;

/** The original term a grant was approved with, before this change. */
const ORIGINAL_TERM_MS = 365 * 24 * 60 * 60 * 1000;

/** The ONE predicate for "a free grant still on its original 365-day term"; the SELECT and the UPDATE both use it. */
const onOriginalTerm = and(
  eq(datasetAccessGrantsTable.tier, "free"),
  eq(datasetAccessGrantsTable.status, "active"),
  sql`${datasetAccessGrantsTable.approvedAt} is not null`,
  sql`${datasetAccessGrantsTable.expiresAt} = ${datasetAccessGrantsTable.approvedAt} + ${ORIGINAL_TERM_MS / 1000}::double precision * interval '1 second'`,
);

/** The write-side floor: the new expiry must leave at least MIN_REMAINING_MS, or the row is not written. */
const keepsFloor = sql`${freeTermEnd} >= now() + ${MIN_REMAINING_MS / 1000}::double precision * interval '1 second'`;

/** a***@domain; never the full address. */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
};

const day = (d: Date): string => d.toISOString().slice(0, 10);

export async function selectCandidates(db: EmailSendsDb): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: datasetAccessGrantsTable.id,
      email: datasetAccessGrantsTable.email,
      approvedAt: datasetAccessGrantsTable.approvedAt,
      expiresAt: datasetAccessGrantsTable.expiresAt,
      renewalRequestedAt: datasetAccessGrantsTable.renewalRequestedAt,
    })
    .from(datasetAccessGrantsTable)
    .where(onOriginalTerm)
    .orderBy(datasetAccessGrantsTable.approvedAt);
  return rows.flatMap((r) =>
    r.approvedAt && r.expiresAt
      ? [
          {
            id: r.id,
            email: r.email,
            approvedAt: r.approvedAt,
            expiresAt: r.expiresAt,
            newExpiresAt: new Date(r.approvedAt.getTime() + DATASET_FREE_GRANT_TERM_MS),
            renewalPending: r.renewalRequestedAt !== null,
          },
        ]
      : [],
  );
}

/**
 * The retry audience: every named id must be a free, active grant that really is on the 90-day term
 * (`expires_at = approved_at + 90 days`). Unknown or ineligible ids refuse the whole run before any send.
 */
export async function selectForRetry(db: EmailSendsDb, ids: string[]): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: datasetAccessGrantsTable.id,
      email: datasetAccessGrantsTable.email,
      approvedAt: datasetAccessGrantsTable.approvedAt,
      expiresAt: datasetAccessGrantsTable.expiresAt,
      renewalRequestedAt: datasetAccessGrantsTable.renewalRequestedAt,
    })
    .from(datasetAccessGrantsTable)
    .where(
      and(
        inArray(datasetAccessGrantsTable.id, ids),
        eq(datasetAccessGrantsTable.tier, "free"),
        eq(datasetAccessGrantsTable.status, "active"),
        sql`${datasetAccessGrantsTable.approvedAt} is not null`,
        sql`${datasetAccessGrantsTable.expiresAt} = ${freeTermEnd}`,
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const bad = ids.filter((id) => !found.has(id));
  if (bad.length > 0) {
    throw new RefusalError(`refusing: not a free, active grant on the 90-day term: ${bad.join(", ")}`);
  }
  // Only a grant a previous run actually tried to notify (and did not get through) may be retried.
  const tried = await db
    .select({ targetId: emailSendsTable.targetId })
    .from(emailSendsTable)
    .where(
      and(
        eq(emailSendsTable.kind, "dataset_term_changed"),
        sql`${emailSendsTable.outcome} <> 'sent'`,
        inArray(emailSendsTable.targetId, ids),
      ),
    );
  const triedIds = new Set(tried.map((r) => r.targetId));
  const untried = ids.filter((id) => !triedIds.has(id));
  if (untried.length > 0) {
    throw new RefusalError(
      `refusing: no earlier failed notice row exists for ${untried.join(", ")}, so it was not retried; if a notice was never recorded (for example the grant lookup failed), send it by hand`,
    );
  }
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    approvedAt: r.approvedAt as Date,
    expiresAt: r.expiresAt as Date,
    newExpiresAt: r.expiresAt as Date,
    renewalPending: r.renewalRequestedAt !== null,
  }));
}

/** Throws a RefusalError naming each grant whose new expiry is under now + 7 days. */
export function assertEnoughNotice(candidates: Candidate[], now: Date): void {
  const floor = now.getTime() + MIN_REMAINING_MS;
  const tooSoon = candidates.filter((c) => c.newExpiresAt.getTime() < floor);
  if (tooSoon.length === 0) return;
  const lines = tooSoon.map((c) => `  ${c.id.slice(0, 8)} approved ${day(c.approvedAt)} -> would end ${day(c.newExpiresAt)}`);
  throw new RefusalError(
    `refusing: ${tooSoon.length} grant(s) would end in under 7 days (or already have), with no warning:\n${lines.join("\n")}\nExtend or renew these by hand first.`,
  );
}

export function formatPlan(candidates: Candidate[]): string[] {
  const lines = candidates.map(
    (c) =>
      `${c.id.slice(0, 8)}  ${maskEmail(c.email)}  approved ${day(c.approvedAt)}  expiry ${day(c.expiresAt)} -> ${day(c.newExpiresAt)}${c.renewalPending ? "  (renewal pending)" : ""}`,
  );
  return [...lines, `${candidates.length} free grant(s) still on the 365-day term`];
}

/** The shortening UPDATE; re-checks the full predicate so it is idempotent and only ever shortens. Returns the rows it changed. */
export async function applyShorten(db: EmailSendsDb): Promise<Candidate[]> {
  const rows = await db
    .update(datasetAccessGrantsTable)
    .set({ expiresAt: freeTermEnd })
    .where(and(onOriginalTerm, keepsFloor))
    .returning({
      id: datasetAccessGrantsTable.id,
      email: datasetAccessGrantsTable.email,
      approvedAt: datasetAccessGrantsTable.approvedAt,
      expiresAt: datasetAccessGrantsTable.expiresAt,
      renewalRequestedAt: datasetAccessGrantsTable.renewalRequestedAt,
    });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    approvedAt: r.approvedAt as Date,
    expiresAt: r.expiresAt as Date,
    newExpiresAt: r.expiresAt as Date,
    renewalPending: r.renewalRequestedAt !== null,
  }));
}

export async function countOnOriginalTerm(db: EmailSendsDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(datasetAccessGrantsTable)
    .where(onOriginalTerm);
  return row?.n ?? 0;
}

/** Grant ids that already have a `sent` term-changed row. */
export async function alreadyNotified(db: EmailSendsDb, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ targetId: emailSendsTable.targetId })
    .from(emailSendsTable)
    .where(
      and(
        eq(emailSendsTable.kind, "dataset_term_changed"),
        eq(emailSendsTable.outcome, "sent"),
        inArray(emailSendsTable.targetId, ids),
      ),
    );
  return new Set(rows.flatMap((r) => (r.targetId ? [r.targetId] : [])));
}

export interface NotifyDeps {
  db: EmailSendsDb;
  send?: (input: { email: string; expiresAt: Date }) => Promise<SendOutcome>;
  pacer?: Pacer;
  log: (line: string) => void;
}

export async function notifyGrantees(
  grants: Candidate[],
  deps: NotifyDeps,
): Promise<{ sent: number; skipped: number; failed: number; failedIds: string[] }> {
  const pace = deps.pacer ?? makePacer();
  const done = await alreadyNotified(deps.db, grants.map((g) => g.id));
  const result = { sent: 0, skipped: 0, failed: 0, failedIds: [] as string[] };
  for (const g of grants) {
    if (done.has(g.id)) {
      result.skipped++;
      continue;
    }
    const res: GateResult = await sendGrantGated(
      deps.db,
      { kind: "dataset_term_changed", grantId: g.id, email: g.email },
      async () => {
        await pace();
        return sendWithTimeout(
          // The real sender is named only here, inside the gate callback (lib/email-send-gate-guard.test.ts).
          () => (deps.send ?? sendDatasetTermChangedEmail)({ email: g.email, expiresAt: g.newExpiresAt }),
          SEND_TIMEOUT_MS,
        );
      },
    );
    if (res.sent) result.sent++;
    else if (res.disposition === "send_failed" || res.disposition === "gate_error" || res.disposition === "skipped_no_key") {
      result.failed++;
      result.failedIds.push(g.id);
    } else result.skipped++;
    deps.log(`${g.id.slice(0, 8)}  ${maskEmail(g.email)}  ${res.disposition}`);
  }
  return result;
}

export async function run(
  argv: string[],
  deps: { db: EmailSendsDb; now?: Date; log: (line: string) => void; send?: NotifyDeps["send"]; pacer?: Pacer },
): Promise<void> {
  const { apply, notify, notifyIds } = parseArgs(argv);
  // Fail closed BEFORE any write: with no key nothing can be mailed, and the grants would be shortened unannounced.
  // (`deps.send` is the test seam; the real sender reads RESEND_API_KEY, lib/email.ts getResend.)
  if ((notify || notifyIds.length > 0) && !deps.send && !process.env.RESEND_API_KEY) {
    throw new RefusalError("refusing: --notify needs RESEND_API_KEY, which is not set; nothing was written");
  }
  const report = async (grants: Candidate[]) => {
    const r = await notifyGrantees(grants, deps);
    deps.log(`notify: sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
    if (r.failed > 0) {
      throw new RefusalError(`${r.failed} notice(s) failed; retry with: --notify-ids ${r.failedIds.join(",")}`);
    }
  };

  if (notifyIds.length > 0) {
    await report(await selectForRetry(deps.db, notifyIds));
    return;
  }

  const now = deps.now ?? new Date();
  const candidates = await selectCandidates(deps.db);
  assertEnoughNotice(candidates, now);
  for (const line of formatPlan(candidates)) deps.log(line);

  if (!apply) {
    deps.log("dry run: nothing written (pass --apply)");
    return;
  }
  const shortened = await applyShorten(deps.db);
  const remaining = await countOnOriginalTerm(deps.db);
  if (remaining !== 0) throw new Error(`read-back failed: ${remaining} free grant(s) are still on the 365-day term`);
  deps.log(`applied: ${shortened.length} grant(s) shortened, read-back clean`);
  if (shortened.length > 0) deps.log(`shortened ids (for --notify-ids retries): ${shortened.map((g) => g.id).join(",")}`);
  if (notify) await report(shortened);
}

if (isEntrypoint(import.meta.url)) {
  if (!hasDatabaseUrl()) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  run(process.argv.slice(2), { db: getDb() as unknown as EmailSendsDb, log: (l) => console.log(l) }).catch((err) => {
    if (err instanceof RefusalError) {
      // lint-no-raw-error-logs: allow -- RefusalError is built only from short ids and dates in this script, never from a caught DB error
      console.error(err.message);
    } else {
      console.error(formatFatalError(err));
    }
    process.exit(1);
  });
}
