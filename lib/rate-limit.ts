import { createHash } from "node:crypto";
import { and, gt, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { submissionsTable } from "@/lib/db/schema";

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
