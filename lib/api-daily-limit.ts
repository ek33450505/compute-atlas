import { and, eq, sql } from "drizzle-orm";

import { getDb, hasDatabaseUrl } from "@/lib/db/client";
import { apiAccessGrantsTable, apiDailyUsageTable } from "@/lib/db/schema";
import { extractClientIp, hashIp } from "@/lib/rate-limit";

export const API_DAILY_LIMIT_MAX = 1000;

function utcDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function secondsUntilNextUtcMidnight(now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((next.getTime() - now.getTime()) / 1000);
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token || null;
}

/**
 * Gate for the facilities-family read API's Track B2 daily-volume ceiling.
 * A valid, active, unexpired access-grant bearer token bypasses this
 * entirely — token holders are bounded only by the existing in-memory burst
 * limiter (`checkApiRateLimit`, unchanged, still runs first in every route),
 * matching the plan: "no additional ceiling beyond the existing 60/min
 * burst limiter" for token holders. An expired/revoked/unknown token is
 * treated as anonymous (falls through to the IP-day counter) rather than
 * rejected — an expired token holder is just an anonymous caller, not an
 * attacker. Anonymous callers are capped at API_DAILY_LIMIT_MAX
 * requests/IP-hash/UTC-day via a durable DB counter.
 *
 * Fail-open, matching this codebase's outage-resilience convention for new
 * server DB reads (see e.g. `getRecentActivity` in lib/data.ts): returns
 * `{ ok: true }` immediately when `DATABASE_URL` is unset (local dev without
 * a DB, or a Vercel preview build), and again if the DB round trip itself
 * throws (unreachable, over quota, etc.) — this gate backstops the existing
 * in-memory burst limiter, which still runs first in every route; it must
 * never be the reason a DB blip takes down the public read API.
 */
export async function checkDailyApiGate(
  request: Request
): Promise<{ ok: boolean; retryAfter?: number }> {
  if (!hasDatabaseUrl()) {
    return { ok: true };
  }

  try {
    const db = getDb();
    const token = extractBearerToken(request);

    if (token) {
      const rows = await db
        .select({ id: apiAccessGrantsTable.id, expiresAt: apiAccessGrantsTable.expiresAt })
        .from(apiAccessGrantsTable)
        .where(and(eq(apiAccessGrantsTable.accessToken, token), eq(apiAccessGrantsTable.status, "active")));
      const grant = rows[0];
      if (grant && (!grant.expiresAt || grant.expiresAt > new Date())) {
        await db
          .update(apiAccessGrantsTable)
          .set({ requestCount: sql`${apiAccessGrantsTable.requestCount} + 1`, lastUsedAt: new Date() })
          .where(eq(apiAccessGrantsTable.id, grant.id))
          .catch(() => {
            // Usage counter is visibility-only (per apiAccessGrantsTable's doc
            // comment) — a failed bump must never block the request it authorizes.
          });
        return { ok: true };
      }
    }

    const ipHash = hashIp(extractClientIp(request));
    const day = utcDateString();
    const rows = await db
      .insert(apiDailyUsageTable)
      .values({ ipHash, day, count: 1 })
      .onConflictDoUpdate({
        target: [apiDailyUsageTable.ipHash, apiDailyUsageTable.day],
        set: { count: sql`${apiDailyUsageTable.count} + 1` },
      })
      .returning({ count: apiDailyUsageTable.count });

    const count = rows[0]?.count ?? 1;
    if (count <= API_DAILY_LIMIT_MAX) {
      return { ok: true };
    }
    return { ok: false, retryAfter: secondsUntilNextUtcMidnight() };
  } catch (err) {
    console.warn("checkDailyApiGate: daily-volume gate unavailable, failing open", err);
    return { ok: true };
  }
}
