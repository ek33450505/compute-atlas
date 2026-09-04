import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  submissionsTable,
  subscriptionsTable,
  leadsTable,
  contactMessagesTable,
  apiAccessGrantsTable,
} from "@/lib/db/schema";

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
 * `extractClientIp`'s result entirely.
 *
 * Precedence, most to least trusted:
 *  1. `cf-connecting-ip` — on the production path (Cloudflare in front of
 *     Vercel), Cloudflare always overwrites this header with the real
 *     connecting client's IP rather than passing through a client-supplied
 *     value, so it's trustworthy there. It is NOT unspoofable in general: a
 *     request that reaches the Vercel origin directly, bypassing Cloudflare,
 *     can set this header itself like any other. That's not an incremental
 *     weakness versus the alternatives below, though — the same direct-to-
 *     origin caller could already forge `x-real-ip` (precedence #2) too, and
 *     the burst limiter (`lib/api-rate-limit.ts`) plus the DB-backed daily
 *     volume gate remain as further defense regardless of which header wins.
 *     Confirmed live 2026-09-03: production's `x-forwarded-for` leftmost
 *     entry was rotating per request (21 requests from one stable IPv4
 *     egress produced 20 distinct buckets), which is exactly the spoofing
 *     this precedence exists to close.
 *  2. `x-real-ip` — assumed set by Vercel's edge to the true
 *     client-connection IP, single-valued and not attacker-controllable; the
 *     fallback for non-Cloudflare paths (local dev, direct Vercel access).
 *  3. The RIGHTMOST `x-forwarded-for` entry (the one appended by the trusted
 *     proxy, on the same assumption), if neither of the above is present.
 *  4. A fixed sentinel ("unknown").
 *
 * Prefer this over `extractClientIp` for any path where a spoofed bucket
 * defeats the limiter's purpose — auth lockout, anything that sends email or
 * costs money on every accepted request (e.g. the contact endpoint), durable
 * per-IP volume caps (e.g. the daily API-read gate), and the in-memory burst
 * limiter (`lib/api-rate-limit.ts`) guarding the read API's
 * `checkApiRateLimit` buckets. The burst limiter was switched over
 * deliberately, at all five read-API routes (`facilities`,
 * `facilities/[id]`, `search`, `stats`, `schema`): the production incident
 * this precedence exists to close (above) hits an in-memory
 * per-request-count bucket exactly the same way it hits a DB-backed one — a
 * rotating leftmost XFF entry defeats either kind of counter regardless of
 * where the count is stored.
 *
 * The `cf-connecting-ip` precedence is a strict improvement for every
 * existing caller (`app/api/contact/route.ts`, `app/admin/login/actions.ts`)
 * too — it only takes effect on requests that are actually behind
 * Cloudflare, and when present it is strictly more trustworthy than
 * `x-real-ip`/XFF, so no caller becomes less safe.
 *
 * Takes `Headers` directly (not a `Request`) so both a route handler
 * (`request.headers`) and a Server Action (`await headers()` from
 * `next/headers`, whose `ReadonlyHeaders` type is a structural superset of
 * `Headers`) can call this without wrapping or casting.
 */
export function extractTrustedClientIp(headers: Headers): string {
  const cfConnectingIp = headers.get("cf-connecting-ip");
  if (cfConnectingIp) {
    const trimmed = cfConnectingIp.trim();
    if (trimmed) return trimmed;
  }
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

const IPV4_MAPPED_IPV6 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * Collapses an IPv6 address to its /64 network prefix for use as a rate-limit
 * bucket key; IPv4 addresses (and the "unknown" sentinel) pass through
 * unchanged. A residential IPv6 client is routinely delegated a whole /64 and
 * rotates its source address within it automatically (privacy extensions,
 * RFC 4941), so hashing the full address would hand any such client
 * effectively unlimited buckets against a per-IP cap — standard practice is
 * to rate-limit IPv6 at the /64 boundary instead. `::ffff:1.2.3.4`
 * (IPv4-mapped IPv6) is treated as plain IPv4.
 *
 * Handles `::` zero-compression by expanding it properly: the compressed run
 * can sit anywhere in the address (start, middle, or end), and the groups
 * that carry the /64 prefix can live on either side of it — e.g.
 * `::2001:db8:1:2:3:4:5` expands to `0:2001:db8:1:2:3:4:5`, so its /64 is
 * `0:2001:db8:1`, not `0:0:0:0` (naively taking only the pre-"::" head gets
 * this wrong whenever the compressed run sits early and the tail carries the
 * prefix groups). We split on `::` into head and tail group lists, insert
 * `8 - head.length - tail.length` zero groups between them to get the full
 * 8-group address, then take the first four groups as the /64 prefix (e.g.
 * `2001:db8::1` -> head `["2001","db8"]`, tail `["1"]` -> prefix
 * `2001:db8:0:0`).
 */
export function normaliseIpForBucketing(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4, or the "unknown" sentinel

  const mapped = ip.match(IPV4_MAPPED_IPV6);
  if (mapped) return mapped[1];

  const withoutZone = ip.split("%")[0]; // strip zone id (e.g. "%eth0")

  let groups: string[];
  if (withoutZone.includes("::")) {
    const [headPart, tailPart] = withoutZone.split("::");
    const head = headPart ? headPart.split(":").filter((p) => p.length > 0) : [];
    const tail = tailPart ? tailPart.split(":").filter((p) => p.length > 0) : [];
    const missing = Math.max(0, 8 - head.length - tail.length);
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = withoutZone.split(":").filter((p) => p.length > 0);
  }

  const prefix =
    groups.length >= 4 ? groups.slice(0, 4) : [...groups, ...Array(4 - groups.length).fill("0")];
  return prefix.join(":");
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

/**
 * Per-IP rate limit for the bulk-API-access request endpoint
 * (`POST /api/access/request`), counting `apiAccessGrantsTable` rows via its
 * own `submitterIpHash` column — its own counter (own table, same
 * MAX/WINDOW), same reasoning as `checkLeadRateLimit`/`checkContactRateLimit`.
 * This guards the request-a-token endpoint from abuse; it is NOT the daily
 * API-volume gate on the facilities-family routes (a separate mechanism,
 * out of scope here).
 */
export async function checkAccessGrantRateLimit(ipHash: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(apiAccessGrantsTable)
    .where(
      and(gt(apiAccessGrantsTable.createdAt, windowStart), eq(apiAccessGrantsTable.submitterIpHash, ipHash))
    );
  return rateLimitDecision(Number(rows[0]?.c ?? 0));
}

/**
 * Per-recipient cap on bulk-access-request magic-link emails, independent of
 * the per-IP rate limit above — mirrors `checkEmailSendCap`'s reasoning
 * (s65 security review, Fix 2): the IP limit alone doesn't stop a
 * distributed attacker from email-bombing one victim across IPs. `email` is
 * expected pre-normalized (lowercased/trimmed) by the caller.
 */
export async function checkAccessGrantEmailSendCap(email: string): Promise<{ ok: boolean }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(apiAccessGrantsTable)
    .where(and(gt(apiAccessGrantsTable.createdAt, windowStart), eq(apiAccessGrantsTable.email, email)));
  return { ok: Number(rows[0]?.c ?? 0) < EMAIL_SEND_CAP_MAX };
}
