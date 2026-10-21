import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

import { emailSendsTable } from "@/lib/db/schema";
import {
  EMAIL_SEND_KINDS,
  EMAIL_SEND_OUTCOMES,
  type EmailSendKind,
  type EmailSendOutcome,
  type EmailSendsDb,
} from "@/lib/email-sends";

/**
 * Read path for the `email_sends` ledger (admin page + CLI). It never selects
 * `email_hash`: rows carry only `hashPrefix`, enough to see which rows share
 * an address without handing out the hash. Every filter is validated against
 * a constant list or a strict date shape and then bound as a parameter;
 * nothing is interpolated.
 */

export const EMAIL_SENDS_DEFAULT_LIMIT = 200;
export const EMAIL_SENDS_MAX_LIMIT = 500;
export const HASH_PREFIX_LENGTH = 8;
/** Row cap for one address lookup (admin action). */
export const ADDRESS_LOOKUP_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EmailSendsFilter {
  kind?: string;
  outcome?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  since?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  until?: string;
  /** Full salted hash, as produced by `hashAddress`. Never a plaintext address. */
  emailHash?: string;
  runId?: string;
  limit?: number;
}

export interface EmailSendListed {
  id: string;
  createdAt: Date;
  completedAt: Date | null;
  kind: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  runId: string | null;
  resendId: string | null;
  errorCode: string | null;
  subscriptionId: string | null;
  hashPrefix: string;
}

export function isEmailSendKind(value: unknown): value is EmailSendKind {
  return typeof value === "string" && (EMAIL_SEND_KINDS as readonly string[]).includes(value);
}

export function isEmailSendOutcome(value: unknown): value is EmailSendOutcome {
  return typeof value === "string" && (EMAIL_SEND_OUTCOMES as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A real calendar date in `YYYY-MM-DD` form as UTC midnight, else null (`2026-02-31` is rejected, not rolled over). */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().startsWith(value) ? date : null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return EMAIL_SENDS_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), EMAIL_SENDS_MAX_LIMIT);
}

/** Invalid values are dropped (not matched, not interpolated): a bad filter widens the view rather than erroring. */
function conditions(filter: EmailSendsFilter): SQL[] {
  const out: SQL[] = [];
  if (isEmailSendKind(filter.kind)) out.push(eq(emailSendsTable.kind, filter.kind));
  if (isEmailSendOutcome(filter.outcome)) out.push(eq(emailSendsTable.outcome, filter.outcome));
  const since = parseIsoDate(filter.since);
  if (since) out.push(gte(emailSendsTable.createdAt, since));
  const until = parseIsoDate(filter.until);
  if (until) out.push(lt(emailSendsTable.createdAt, new Date(until.getTime() + DAY_MS)));
  if (isUuid(filter.runId)) out.push(eq(emailSendsTable.runId, filter.runId));
  if (typeof filter.emailHash === "string" && /^[0-9a-f]{64}$/.test(filter.emailHash)) {
    out.push(eq(emailSendsTable.emailHash, filter.emailHash));
  }
  return out;
}

/** Newest first; `limit` defaults to 200 and is capped at 500. */
export async function listEmailSends(
  db: EmailSendsDb,
  filter: EmailSendsFilter = {}
): Promise<EmailSendListed[]> {
  const where = conditions(filter);
  return db
    .select({
      id: emailSendsTable.id,
      createdAt: emailSendsTable.createdAt,
      completedAt: emailSendsTable.completedAt,
      kind: emailSendsTable.kind,
      outcome: emailSendsTable.outcome,
      targetType: emailSendsTable.targetType,
      targetId: emailSendsTable.targetId,
      runId: emailSendsTable.runId,
      resendId: emailSendsTable.resendId,
      errorCode: emailSendsTable.errorCode,
      subscriptionId: emailSendsTable.subscriptionId,
      hashPrefix: sql<string>`left(${emailSendsTable.emailHash}, ${HASH_PREFIX_LENGTH})`,
    })
    .from(emailSendsTable)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(emailSendsTable.createdAt), desc(emailSendsTable.id))
    .limit(clampLimit(filter.limit));
}

/** Row counts by outcome under the same filters (`limit` ignored). */
export async function countEmailSendsByOutcome(
  db: EmailSendsDb,
  filter: EmailSendsFilter = {}
): Promise<Record<string, number>> {
  const where = conditions(filter);
  const rows = await db
    .select({ outcome: emailSendsTable.outcome, n: sql<number>`count(*)::int` })
    .from(emailSendsTable)
    .where(where.length ? and(...where) : undefined)
    .groupBy(emailSendsTable.outcome);
  return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
}

type Param = string | string[] | undefined;

const firstParam = (value: Param): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Page filters from URL params. Only validated values survive, so nothing invalid is applied or echoed back into the form. */
export function filterFromSearchParams(params: Record<string, Param>): EmailSendsFilter {
  const kind = firstParam(params.kind);
  const outcome = firstParam(params.outcome);
  const since = firstParam(params.since);
  const until = firstParam(params.until);
  return {
    kind: isEmailSendKind(kind) ? kind : undefined,
    outcome: isEmailSendOutcome(outcome) ? outcome : undefined,
    since: parseIsoDate(since) ? since : undefined,
    until: parseIsoDate(until) ? until : undefined,
  };
}
