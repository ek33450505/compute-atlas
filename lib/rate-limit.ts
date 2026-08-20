import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { submissionsTable, subscriptionsTable, leadsTable } from "@/lib/db/schema";

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
