import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { submissionsTable, subscriptionsTable, leadsTable, contactMessagesTable } from "@/lib/db/schema";

export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export function extractClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/**
 * Derives the client IP the way `extractClientIp` above deliberately does
 * NOT: on Vercel the leftmost `x-forwarded-for` entry is client-suppliable
 * (Vercel appends the real client IP rather than replacing one the client
 * already sent), so an attacker can rotate XFF per request to get a fresh
 * `ipHash` bucket every request and bypass any limiter keyed on
 * `extractClientIp`'s result entirely. This prefers `x-real-ip` instead —
 * assumed to be set by Vercel's edge to the true client-connection IP,
 * single-valued and not attacker-controllable — falling back to the
 * RIGHTMOST `x-forwarded-for` entry (the one appended by the trusted proxy,
 * on the same assumption) if `x-real-ip` is absent, then to a fixed
 * sentinel.
 *
 * Prefer this over `extractClientIp` for security-sensitive paths where a
 * spoofed bucket has a real cost if bypassed — auth lockout, and anything
 * that sends email or costs money on every accepted request (e.g. the
 * contact endpoint). `extractClientIp` remains the default for the read-API
 * and other limiters that don't need this stronger guarantee; do not switch
 * them over without a reason, since it's marginally stricter (a genuine
 * multi-hop proxy chain with no `x-real-ip` set will resolve to a different
 * entry than before).
 *
 * Takes `Headers` directly (not a `Request`) so both a route handler
 * (`request.headers`) and a Server Action (`await headers()` from
 * `next/headers`, whose `ReadonlyHeaders` type is a structural superset of
 * `Headers`) can call this without wrapping or casting.
 */
export function extractTrustedClientIp(headers: Headers): string {
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}

export function hashIp(ip: string): string {
  const salt = process.env.CONTRIBUTE_IP_SALT ?? "compute-atlas-contribute-v1";
  return createHash("sha256").update(ip + salt).digest("hex");
}

export function rateLimitDecision(count: number): { ok: boolean } {
  return { ok: count < RATE_LIMIT_MAX };
}

export async function checkRateLimit(ipHash: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(submissionsTable)
    .where(
      and(
        gt(submissionsTable.createdAt, windowStart),
        sql`${submissionsTable.provenance}->>'submitterIpHash' = ${ipHash}`
      )
    );
  return rateLimitDecision(Number(rows[0]?.c ?? 0));
}

export async function checkSubscribeRateLimit(ipHash: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(subscriptionsTable)
    .where(
      and(
        gt(subscriptionsTable.createdAt, windowStart),
        eq(subscriptionsTable.submitterIpHash, ipHash)
      )
    );
  return rateLimitDecision(Number(rows[0]?.c ?? 0));
}

/**
 * Per-IP rate limit for the leads endpoint (`POST /api/leads`), counting
 * `leadsTable` rows via its real `submitterIpHash` column — unlike
 * `checkRateLimit`, which counts `submissions` rows through a jsonb-path
 * lookup. Kept as its own counter (own table, same MAX/WINDOW) so leads and
 * facility submissions don't share a budget — otherwise a burst of one would
 * silently starve the other.
 */
export async function checkLeadRateLimit(ipHash: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(and(gt(leadsTable.createdAt, windowStart), eq(leadsTable.submitterIpHash, ipHash)));
  return rateLimitDecision(Number(rows[0]?.c ?? 0));
}

/**
 * Per-IP rate limit for the contact endpoint (`POST /api/contact`), counting
 * `contactMessagesTable` rows via its own `submitterIpHash` column — its own
 * counter (own table, same MAX/WINDOW), same reasoning as `checkLeadRateLimit`:
 * contact messages, leads, and facility submissions must not share a budget,
 * or a burst against one silently starves the others.
 */
export async function checkContactRateLimit(ipHash: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(contactMessagesTable)
    .where(and(gt(contactMessagesTable.createdAt, windowStart), eq(contactMessagesTable.submitterIpHash, ipHash)));
  return rateLimitDecision(Number(rows[0]?.c ?? 0));
}

export const EMAIL_SEND_CAP_MAX = 5; // confirm emails per address per window

/**
 * Per-recipient cap on confirm-email sends, independent of the per-IP rate
 * limit above. The IP limit doesn't stop a distributed attacker from
 * email-bombing one victim by varying targetId (and IP) across requests —
 * this bounds sends to a single address regardless of source (s65 security
 * review, Fix 2). `email` is expected pre-normalized (lowercased/trimmed) by
 * the caller.
 */
export async function checkEmailSendCap(email: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(subscriptionsTable)
    .where(and(gt(subscriptionsTable.createdAt, windowStart), eq(subscriptionsTable.email, email)));
  return { ok: Number(rows[0]?.c ?? 0) < EMAIL_SEND_CAP_MAX };
}
